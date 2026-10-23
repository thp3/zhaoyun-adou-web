import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { maybeSpawnBoss } from '../src/domain/battle/bosses';
import { BUFF, addGlobal, applyBuff, attackSpeedBonus, hasBuff, onUnitLevelUp, unitDisabled } from '../src/domain/battle/buffs';
import { generalCenter } from '../src/domain/battle/generals';
import { applyCommand } from '../src/domain/battle/commands';
import { createWorld } from '../src/domain/battle/create';
import { damageEnemy, maxHpOf, spawnEnemy } from '../src/domain/battle/enemies';
import { stepWorld } from '../src/domain/battle/step';
import { ticks, type Actor, type Enemy, type General, type StepContext, type World } from '../src/domain/battle/types';

const data = loadGameData();
const rules = { data };
const ctx = (): StepContext => ({ data, events: [] });

function world(mapId = 0): World {
  const w = createWorld({ data, seed: 5, mapId, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: false });
  w.camps[0].lives = 1e9;
  w.wave = { phase: 'spawning', wave: 5, timer: -1e9, spawned: 0 };
  return w;
}

function run(w: World, n: number): void {
  for (let i = 0; i < n && !w.result; i++) stepWorld(w, [], rules);
}

/** 玩家方緊鄰道路的可部署格 */
function cellNearPath(w: World, nth = 0): { x: number; y: number; pathIdx: number } {
  const found: { x: number; y: number; pathIdx: number }[] = [];
  const path = w.paths[0];
  for (let x = 0; x < 8; x++) for (let y = 0; y < 10; y++) {
    if (w.camp[x]![y] !== 0 || w.kind[x]![y] === 0) continue;
    const i = path.findIndex((p) => Math.abs(Math.floor(p.x / 80) - x) + Math.abs(Math.floor(p.y / 80) - y) === 1);
    if (i > 0) found.push({ x, y, pathIdx: i });
  }
  return found[nth]!;
}

function soldier(w: World, token: string, x: number, y: number, level = 1): Actor {
  w.kind[x]![y] = 1;
  const id = w.nextId++;
  const a: Actor = { id, side: 0, token, kind: 'soldier', level, loc: { c: 'board', x, y }, cooldown: 0, generalId: null, exp: 0 };
  w.actors[id] = a;
  w.board[x]![y] = id;
  return a;
}

function enemyAt(w: World, pathIdx: number, opt: { boss?: number; hp?: number } = {}): Enemy {
  const p = w.paths[0][pathIdx]!;
  const e = spawnEnemy(w, 0, ctx(), { at: { x: p.x, y: p.y, pathIdx: pathIdx + 1 }, boss: opt.boss, hp: opt.hp ?? 1e6, speed: 0 });
  return e;
}

/** 讓 Boss 立刻施法並跑完施法時間 */
function castNow(w: World, boss: Enemy): void {
  boss.bossState!.cd = 1e9;
  run(w, ticks(2200));
}

describe('buff 合併與到期', () => {
  it('狀態同型第二筆：num 相加、期限相加；摔倒改為刷新期限', () => {
    const w = world();
    const e = enemyAt(w, 3);
    applyBuff(w, e.id, BUFF.stun, 1, { timeMs: 1000 }, ctx());
    applyBuff(w, e.id, BUFF.stun, 1, { timeMs: 500 }, ctx());
    const stun = w.buffs[e.id]!.filter((b) => b.type === BUFF.stun);
    expect(stun).toHaveLength(1);
    expect(stun[0]).toMatchObject({ num: 2, time: ticks(1500) });
    applyBuff(w, e.id, BUFF.fall, 0, { timeMs: 1000 }, ctx());
    run(w, 10);
    applyBuff(w, e.id, BUFF.fall, 0, { timeMs: 800 }, ctx());
    expect(w.buffs[e.id]!.find((b) => b.type === BUFF.fall)).toMatchObject({ time: ticks(800), timer: 0 });
  });

  it('限制擋擊退、加限制先移除擊退', () => {
    const w = world();
    const e = enemyAt(w, 4);
    applyBuff(w, e.id, BUFF.knockback, 1, {}, ctx());
    expect(hasBuff(w, e.id, BUFF.knockback)).toBe(true);
    applyBuff(w, e.id, BUFF.limit, 1, { timeMs: 5000 }, ctx());
    expect(hasBuff(w, e.id, BUFF.knockback)).toBe(false);
    expect(applyBuff(w, e.id, BUFF.knockback, 1, {}, ctx())).toBe(-1);
  });

  it('攻速減益只能抵消增益（原版 N_ 清負值）', () => {
    const w = world();
    const c = cellNearPath(w);
    const a = soldier(w, 'bow', c.x, c.y);
    applyBuff(w, a.id, BUFF.attSpeed, -0.2, { percent: true }, ctx());
    expect(attackSpeedBonus(w, a.id)).toBe(0);
    applyBuff(w, a.id, BUFF.attSpeed, 0.4, { percent: true }, ctx());
    expect(attackSpeedBonus(w, a.id)).toBeCloseTo(0.2);
  });

  it('最大血量增益補目前血量，到期後截斷', () => {
    const w = world();
    const e = enemyAt(w, 3, { hp: 100 });
    applyBuff(w, e.id, BUFF.maxHp, 0.5, { percent: true, timeMs: 100 }, ctx());
    expect(e.hp).toBe(150);
    expect(maxHpOf(w, e)).toBe(150);
    run(w, ticks(200));
    expect(e.hp).toBe(100);
  });

  it('time=-2 的 buff 在下一波開始時移除', () => {
    const w = world();
    const e = enemyAt(w, 3);
    applyBuff(w, e.id, BUFF.moveSpeed, -0.1, { percent: true, timeMs: -2 }, ctx());
    w.wave = { phase: 'intermission', wave: 5, timer: 1e9, spawned: 0 };
    run(w, 2);
    expect(hasBuff(w, e.id, BUFF.moveSpeed)).toBe(false);
  });

  it('受控普通兵不出手、不能拖、也不能當合成目標；升級解除鎖鏈與擊倒；壓制禁止合成', () => {
    const w = world();
    const c1 = cellNearPath(w, 0);
    const c2 = cellNearPath(w, 1);
    const a = soldier(w, 'blade', c1.x, c1.y);
    const b = soldier(w, 'blade', c2.x, c2.y);
    applyBuff(w, b.id, BUFF.lock, 1, {}, ctx());
    applyBuff(w, b.id, BUFF.knockdown, 1, {}, ctx());
    expect(unitDisabled(w, b.id)).toBe(true);
    expect(applyCommand(w, { type: 'MOVE', side: 0, actorId: b.id, to: { c: 'board', ...c1 } }, ctx()).ok).toBe(false);
    // 原版：目標處於不可拖狀態也不能交換或合成
    expect(applyCommand(w, { type: 'MOVE', side: 0, actorId: a.id, to: { c: 'board', x: c2.x, y: c2.y } }, ctx()).ok).toBe(false);
    onUnitLevelUp(w, b.id);
    expect(hasBuff(w, b.id, BUFF.lock)).toBe(false);
    expect(hasBuff(w, b.id, BUFF.knockdown)).toBe(false);
    expect(applyCommand(w, { type: 'MOVE', side: 0, actorId: a.id, to: { c: 'board', x: c2.x, y: c2.y } }, ctx()).ok).toBe(true);
    expect(b.level).toBe(2);
    const d = soldier(w, 'blade', c1.x, c1.y, 2);
    applyBuff(w, d.id, BUFF.suppression, 1, { timeMs: 5000 }, ctx());
    expect(applyCommand(w, { type: 'MOVE', side: 0, actorId: b.id, to: { c: 'board', ...c1 } }, ctx())).toEqual({ ok: false, reason: '受壓制不能合成' });
  });

  it('全局效果：之後新征的兵也繼承', () => {
    const w = world();
    addGlobal(w, { sign: 'test', side: 0, target: 'units', type: BUFF.attSpeed, num: 0.1, percent: true, timeMs: -1 }, ctx());
    applyCommand(w, { type: 'RECRUIT', side: 0 }, ctx());
    const fresh = w.camps[0].slots.map((id) => w.actors[id!]!).filter((a) => a.kind === 'soldier');
    expect(fresh.length).toBeGreaterThan(0);
    for (const a of fresh) expect(hasBuff(w, a.id, BUFF.attSpeed)).toBe(true);
  });
});

describe('Boss 排程', () => {
  it('第 18 波必出；雙方同一位，輪換推進', () => {
    const w = world();
    maybeSpawnBoss(w, 18, ctx());
    const bosses = Object.values(w.enemies).filter((e) => e.boss);
    expect(bosses).toHaveLength(2);
    expect(new Set(bosses.map((b) => b.bossState!.bossId))).toEqual(new Set([0]));
    expect(bosses[0]!.maxHp).toBeCloseTo(8235 * data.waves.hpStrategies[w.hpStrategy]![17]! * 7);
    expect(w.bossRotation).toBe(1);
    maybeSpawnBoss(w, 3, ctx()); // 10%：可能不出
    maybeSpawnBoss(w, 4, ctx()); // 非 Boss 波
    expect(Object.values(w.enemies).filter((e) => e.boss).length).toBeLessThanOrEqual(4);
  });

  it('Boss 擊殺給 10 資金；受控時不施法', () => {
    const w = world();
    const b = enemyAt(w, 3, { boss: 0, hp: 5 });
    applyBuff(w, b.id, BUFF.stun, 1, { timeMs: -1 }, ctx());
    b.bossState!.cd = 1e9;
    run(w, 5);
    expect(b.bossState!.cast).toBe(-1);
    const gold = w.camps[0].gold;
    damageEnemy(w, b, 10, null, ctx());
    expect(w.camps[0].gold).toBe(gold + 10);
  });
});

describe('12 位 Boss 技能', () => {
  it('張梁 攝魂：附近普通兵混亂', () => {
    const w = world();
    const c = cellNearPath(w);
    const a = soldier(w, 'blade', c.x, c.y);
    castNow(w, enemyAt(w, c.pathIdx, { boss: 0 }));
    expect(hasBuff(w, a.id, BUFF.chaos) || w.buffs[a.id] === undefined).toBe(true);
    // 混亂 2 秒，施法 1.5 秒：結束時應已套上且尚未全部到期
    const w2 = world();
    const c2 = cellNearPath(w2);
    const a2 = soldier(w2, 'blade', c2.x, c2.y);
    const boss = enemyAt(w2, c2.pathIdx, { boss: 0 });
    boss.bossState!.cd = 1e9;
    run(w2, ticks(1450));
    expect(hasBuff(w2, a2.id, BUFF.chaos)).toBe(true);
  });

  it('張寶 招魂：施法期間死亡的敵人復活為殭屍，最多 3 隻', () => {
    const w = world();
    const boss = enemyAt(w, 2, { boss: 1 });
    boss.bossState!.cd = 1e9;
    run(w, 2);
    for (let i = 0; i < 5; i++) damageEnemy(w, enemyAt(w, 4 + i, { hp: 1 }), 5, null, ctx());
    run(w, ticks(600));
    expect(Object.values(w.enemies).filter((e) => e.kind === 'zombie')).toHaveLength(3);
  });

  it('張角 鼓舞：附近敵人加血與移速', () => {
    const w = world();
    const boss = enemyAt(w, 3, { boss: 2 });
    const mob = enemyAt(w, 3, { hp: 100 });
    castNow(w, boss);
    // 5 秒效果在施法後仍有效
    expect(hasBuff(w, mob.id, BUFF.maxHp)).toBe(true);
    expect(mob.hp).toBe(150);
  });

  it('孫尚香 拆遷：一格空的可部署地變成待開墾', () => {
    const w = world(1);
    const before = w.kind.flat().filter((k, i) => k === 1).length;
    castNow(w, enemyAt(w, 3, { boss: 3 }));
    const after = w.kind.flat().filter((k) => k === 1).length;
    expect(after).toBe(before - 1);
  });

  it('甄宓 巫山雲雨：全體攻速 -20% 來源；Boss 死亡撤除；只施法一次', () => {
    const w = world(1);
    const c = cellNearPath(w);
    const a = soldier(w, 'bow', c.x, c.y);
    const boss = enemyAt(w, 3, { boss: 4 });
    castNow(w, boss);
    expect(w.buffs[a.id]?.some((b) => b.sign === `rain${boss.id}`)).toBe(true);
    expect(boss.bossState!.usedOnce).toBe(true);
    damageEnemy(w, boss, 1e9, null, ctx());
    expect(w.buffs[a.id]?.some((b) => b.sign?.startsWith('rain')) ?? false).toBe(false);
    expect(w.globals).toHaveLength(0);
  });

  it('貂蟬 裙下之臣：最低級普通兵全部變成傀儡', () => {
    const w = world(1);
    const c1 = cellNearPath(w, 0);
    const c2 = cellNearPath(w, 1);
    const low = soldier(w, 'blade', c1.x, c1.y, 1);
    const high = soldier(w, 'bow', c2.x, c2.y, 3);
    castNow(w, enemyAt(w, 3, { boss: 5 }));
    expect(w.actors[low.id]).toBeUndefined();
    expect(w.actors[high.id]).toBeDefined();
    expect(Object.values(w.enemies).filter((e) => e.kind === 'puppet')).toHaveLength(1);
  });

  it('華雄 鐵騎號令：召喚 3 隻速度 80 的鐵騎', () => {
    const w = world(2);
    castNow(w, enemyAt(w, 3, { boss: 6 }));
    const cav = Object.values(w.enemies).filter((e) => e.kind === 'cavalry');
    expect(cav).toHaveLength(3);
    expect(cav[0]!.speed).toBe(80);
  });

  it('呂布 方天畫戟：200px 內普通兵壓制 5 秒', () => {
    const w = world(2);
    const c = cellNearPath(w);
    const a = soldier(w, 'spear', c.x, c.y, 3);
    castNow(w, enemyAt(w, c.pathIdx, { boss: 7 }));
    expect(hasBuff(w, a.id, BUFF.suppression)).toBe(true);
  });

  it('董卓 饕餮：吞掉附近敵人（不給資金），本體加血', () => {
    const w = world(2);
    const boss = enemyAt(w, 3, { boss: 8, hp: 1000 });
    enemyAt(w, 3);
    enemyAt(w, 3);
    const gold = w.camps[0].gold;
    castNow(w, boss);
    expect(Object.values(w.enemies).filter((e) => !e.boss)).toHaveLength(0);
    expect(w.camps[0].gold).toBe(gold);
    expect(boss.maxHp).toBeGreaterThan(1000);
    expect(boss.scaleBonus).toBeCloseTo(0.02);
  });

  it('典韋 徹底瘋狂：160px 內一名普通兵永久擊倒', () => {
    const w = world(3);
    const c = cellNearPath(w);
    const a = soldier(w, 'blade', c.x, c.y);
    castNow(w, enemyAt(w, c.pathIdx, { boss: 9 }));
    expect(hasBuff(w, a.id, BUFF.knockdown)).toBe(true);
  });

  it('夏侯惇 噬目：該側視野變暗 5 秒', () => {
    const w = world(3);
    castNow(w, enemyAt(w, 3, { boss: 10 }));
    expect(w.blindUntil[0]).toBeGreaterThan(w.tick);
  });

  it('曹操 一代梟雄：鎖住最高等級普通兵', () => {
    const w = world(3);
    const c1 = cellNearPath(w, 0);
    const c2 = cellNearPath(w, 1);
    const lo = soldier(w, 'blade', c1.x, c1.y, 2);
    const hi = soldier(w, 'bow', c2.x, c2.y, 4);
    castNow(w, enemyAt(w, 3, { boss: 11 }));
    expect(hasBuff(w, hi.id, BUFF.lock)).toBe(true);
    expect(hasBuff(w, lo.id, BUFF.lock)).toBe(false);
  });
});

describe('7 種武將技能', () => {
  function general(w: World, key: string, level = 1): General {
    const def = data.generals.generals.find((g) => g.key === key)!;
    let pos: { x: number; y: number } | null = null;
    for (let y = 9; y >= 5 && !pos; y--) for (let x = 0; x < 7; x++) {
      if (w.camp[x]![y] === 0 && w.camp[x + 1]![y] === 0 && w.kind[x]![y] !== 0 && w.kind[x + 1]![y] !== 0 && w.board[x]![y] == null && w.board[x + 1]![y] == null) {
        pos = { x, y };
        break;
      }
    }
    const ids = def.chars.map((tok, k) => {
      w.kind[pos!.x + k]![pos!.y] = 1;
      const id = w.nextId++;
      w.actors[id] = { id, side: 0, token: tok, kind: 'name', level: 1, loc: { c: 'board', x: pos!.x + k, y: pos!.y }, cooldown: 0, generalId: null, exp: 0 };
      w.board[pos!.x + k]![pos!.y] = id;
      return id;
    });
    const gid = w.nextId++;
    const g: General = { id: gid, side: 0, type: def.id, partIds: ids, level, exp: 0, cooldown: 0, skillCount: def.skill?.triggerAttacks ?? 0, busyUntil: 0 };
    for (const id of ids) w.actors[id]!.generalId = gid;
    w.generals[gid] = g;
    return g;
  }
  /** 在離武將最近的路點上放敵人（不移動） */
  function targets(w: World, n: number): Enemy[] {
    const g = Object.values(w.generals)[0]!;
    const c = generalCenter(w, g)!;
    const order = w.paths[0]
      .map((p, i) => ({ i, d: Math.hypot(p.x - c.x, p.y - c.y) }))
      .filter((o) => o.i < w.paths[0].length - 1)
      .sort((a, b) => a.d - b.d);
    return Array.from({ length: n }, (_, k) => enemyAt(w, order[k % 3]!.i, { hp: 1e6 }));
  }
  const events = (w: World, n: number) => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) for (const e of stepWorld(w, [], rules)) if (e.type === 'skill') out.push(e.name);
    return out;
  };

  it('關羽 跳斬：放技能並打最低血量的敵人', () => {
    const w = world();
    general(w, 'guanyu');
    const es = targets(w, 6);
    es[2]!.hp = 50;
    expect(events(w, ticks(3000))).toContain('跳斬');
    expect(w.enemies[es[2]!.id]).toBeUndefined();
  });

  it('張飛 大喝：範圍內敵人暈眩', () => {
    const w = world();
    general(w, 'zhangfei');
    const es = targets(w, 10);
    expect(events(w, ticks(1500))).toContain('大喝');
    expect(es.some((e) => hasBuff(w, e.id, BUFF.stun) || !w.enemies[e.id])).toBe(true);
  });

  it('馬超 暈眩：常駐，命中有機率暈眩', () => {
    const w = world();
    general(w, 'machao');
    const es = targets(w, 10);
    let stunned = false;
    for (let i = 0; i < ticks(10_000) && !stunned; i++) {
      stepWorld(w, [], rules);
      stunned = es.some((e) => hasBuff(w, e.id, BUFF.stun));
    }
    expect(stunned).toBe(true);
  });

  it('劉備 聖劍：發出可穿透的劍', () => {
    const w = world();
    const g = general(w, 'liubei');
    g.skillCount = 19;
    targets(w, 10);
    expect(events(w, ticks(5000))).toContain('聖劍');
  });

  it('黃忠 火箭烈：整條道路落下火箭', () => {
    const w = world();
    general(w, 'huangzhong', 5);
    targets(w, 10);
    const seen: string[] = [];
    let blasts = 0;
    for (let i = 0; i < ticks(5000); i++) {
      for (const e of stepWorld(w, [], rules)) {
        if (e.type === 'skill') seen.push(e.name);
        if (e.type === 'blast') blasts++;
      }
    }
    expect(seen).toContain('火箭烈');
    expect(blasts).toBeGreaterThan(w.paths[0].length);
  });

  it('黃祖 箭雨：五輪各十箭', () => {
    const w = world();
    general(w, 'huangzu');
    targets(w, 10);
    let maxArrows = 0;
    const seen: string[] = [];
    for (let i = 0; i < ticks(4000); i++) {
      for (const e of stepWorld(w, [], rules)) if (e.type === 'skill') seen.push(e.name);
      maxArrows = Math.max(maxArrows, Object.keys(w.projectiles).length);
    }
    expect(seen).toContain('箭雨');
    expect(maxArrows).toBeGreaterThanOrEqual(10);
  });

  it('趙雲 七進七出：幻象沿路來回造成傷害，本體繼續普攻', () => {
    const w = world();
    const g = general(w, 'zhaoyun');
    g.skillCount = 29;
    const es = targets(w, 8);
    const seen = events(w, ticks(3000));
    expect(seen).toContain('七進七出');
    expect(Object.values(w.skills).some((s) => s.kind === 'phantom')).toBe(true);
    expect(es.some((e) => !w.enemies[e.id] || e.hp < 1e6)).toBe(true);
  });
});
