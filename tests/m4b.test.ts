import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { BUFF, hasBuff, statBonus } from '../src/domain/battle/buffs';
import { applyCommand } from '../src/domain/battle/commands';
import { createWorld, type CreateWorldParams } from '../src/domain/battle/create';
import { damageEnemy, spawnEnemy } from '../src/domain/battle/enemies';
import { generalStats, tryFormGeneral } from '../src/domain/battle/generals';
import { ITEM, exorcismBlocks, generateAiItems, useItem } from '../src/domain/battle/items';
import { stepWorld } from '../src/domain/battle/step';
import { ticks, type Actor, type Enemy, type General, type StepContext, type World } from '../src/domain/battle/types';
import { generateOpponent } from '../src/domain/profile/opponent';

const data = loadGameData();
const rules = { data };
const ctx = (): StepContext => ({ data, events: [] });
const GENERAL = (key: string) => data.generals.generals.find((g) => g.key === key)!;

function world(over: Partial<CreateWorldParams> = {}): World {
  const w = createWorld({ data, seed: 9, mapId: 0, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: false, ...over });
  w.camps[0].lives = 1e9;
  w.wave = { phase: 'spawning', wave: 5, timer: -1e9, spawned: 0 };
  return w;
}

function run(w: World, n: number): void {
  for (let i = 0; i < n && !w.result; i++) stepWorld(w, [], rules);
}

/** 玩家方一組相鄰兩格（鄰近道路），必要時先開墾 */
function pairCell(w: World): { x: number; y: number } {
  const path = new Set(w.paths[0].map((p) => `${Math.floor(p.x / 80)},${Math.floor(p.y / 80)}`));
  for (let y = 9; y >= 5; y--) for (let x = 0; x < 7; x++) {
    const ok = (cx: number) => w.camp[cx]![y] === 0 && w.kind[cx]![y] !== 0 && w.board[cx]![y] == null;
    const near = [[0, -1], [0, 1], [-1, 0], [2, 0]].some(([dx, dy]) => path.has(`${x + dx!},${y + dy!}`));
    if (ok(x) && ok(x + 1) && near) return { x, y };
  }
  throw new Error('no pair');
}

function makeGeneral(w: World, key: string, weaponId: number, side: 0 | 1 = 0): General {
  const def = GENERAL(key);
  w.equip[side]![def.id] = weaponId;
  const { x, y } = pairCell(w);
  let last: Actor | null = null;
  def.chars.forEach((tok, k) => {
    w.kind[x + k]![y] = 1;
    const id = w.nextId++;
    last = { id, side, token: tok, kind: 'name', level: 1, loc: { c: 'board', x: x + k, y }, cooldown: 0, generalId: null, exp: 0 };
    w.actors[id] = last;
    w.board[x + k]![y] = id;
  });
  return tryFormGeneral(w, last!, ctx())!;
}

function mob(w: World, pathIdx: number, hp = 1e6, side: 0 | 1 = 0): Enemy {
  const p = w.paths[side][pathIdx]!;
  return spawnEnemy(w, side, ctx(), { at: { x: p.x, y: p.y, pathIdx: pathIdx + 1 }, hp, speed: 0 });
}

/** 在離武將最近的路點放敵人 */
function nearMobs(w: World, g: General, n: number, hp = 1e6): Enemy[] {
  const first = w.actors[g.partIds[0]!]!;
  const cx = (first.loc as { x: number }).x * 80 + 80;
  const cy = (first.loc as { y: number }).y * 80 + 40;
  const order = w.paths[0]
    .map((p, i) => ({ i, d: Math.hypot(p.x - cx, p.y - cy) }))
    .filter((o) => o.i > 0 && o.i < w.paths[0].length - 1)
    .sort((a, b) => a.d - b.d);
  return Array.from({ length: n }, (_, k) => mob(w, order[k % 3]!.i, hp));
}

function soldier(w: World, token: string, level = 1): Actor {
  const { x, y } = pairCell(w);
  w.kind[x]![y] = 1;
  const id = w.nextId++;
  const a: Actor = { id, side: 0, token, kind: token === 'farmer' ? 'farmer' : 'soldier', level, loc: { c: 'board', x, y }, cooldown: 0, generalId: null, exp: 0 };
  w.actors[id] = a;
  w.board[x]![y] = id;
  return a;
}

function giveItem(w: World, itemId: number, level = 1): number {
  w.items[0].push({ itemId, level, cd: 0, uses: 0 });
  return w.items[0].length - 1;
}

describe('武器', () => {
  it('裝備：攻擊加成計入傷害；長槍射程 +0.5 格；類型不符改用預設', () => {
    const w = world();
    const g = makeGeneral(w, 'zhaoyun', 11);
    expect(g.weaponId).toBe(11);
    expect(generalStats(w, g, data).damage).toBe((GENERAL('zhaoyun').damage + 2) * 1);
    expect(statBonus(w, g.id, BUFF.attRange, 1)).toBe(0.5);
    const w2 = world();
    const g2 = makeGeneral(w2, 'zhaoyun', 0); // 弓給槍將
    expect(g2.weaponId).toBe(-1);
  });

  it('鐵劍另加固定攻擊 3', () => {
    const w = world();
    const g = makeGeneral(w, 'zhangyi', 33);
    expect(statBonus(w, g.id, BUFF.attPower, 10)).toBe(3);
  });

  it('角弓：同目標連擊攻速疊加，上限 20', () => {
    const w = world();
    const g = makeGeneral(w, 'huangzhong', 3);
    g.skillCount = -1e9; // 不放技能
    nearMobs(w, g, 1);
    run(w, ticks(8000));
    expect(g.weapon.stacks).toBeGreaterThan(0);
    expect(statBonus(w, g.id, BUFF.attSpeed, 1)).toBeCloseTo(g.weapon.stacks);
  });

  it('三尖刀：第 10 次改射刀氣', () => {
    const w = world();
    const g = makeGeneral(w, 'guanping', 24);
    g.skillCount = -1e9;
    nearMobs(w, g, 3);
    const names: string[] = [];
    for (let i = 0; i < ticks(15000); i++) for (const e of stepWorld(w, [], rules)) if (e.type === 'skill') names.push(e.name);
    expect(names).toContain('刀氣');
  });

  it('古錠刀：每個新敵人第一次被砍 +1 戰鬥資金', () => {
    const w = world();
    const g = makeGeneral(w, 'guanping', 26);
    g.skillCount = -1e9;
    nearMobs(w, g, 3);
    const gold = w.camps[0].gold;
    run(w, ticks(3000));
    expect(w.camps[0].gold - gold).toBeGreaterThanOrEqual(1);
    expect(w.camps[0].gold - gold).toBeLessThanOrEqual(3);
  });

  it('點鋼槍：追蹤的敵人死亡，攻速 +50% 兩秒', () => {
    const w = world();
    const g = makeGeneral(w, 'zhangbao', 15);
    g.skillCount = -1e9;
    const [e] = nearMobs(w, g, 1, 1e6);
    run(w, ticks(2000));
    expect(g.weapon.tracked).toBe(e!.id);
    damageEnemy(w, e!, 1e9, null, ctx());
    expect(hasBuff(w, g.id, BUFF.attSpeed)).toBe(true);
  });

  it('劍技：龍淵劍固定君子、雙股劍固定小人', () => {
    for (const [wid, expected] of [[36, '君子劍'], [37, '小人劍']] as const) {
      const w = world();
      const g = makeGeneral(w, 'zhangyi', wid);
      g.skillCount = -1e9;
      nearMobs(w, g, 3);
      const names: string[] = [];
      for (let i = 0; i < ticks(20000); i++) for (const e of stepWorld(w, [], rules)) if (e.type === 'skill') names.push(e.name);
      expect(names).toContain(expected);
    }
  });

  it('方天畫戟：抽中 Boss 時跳過這次攻擊，不挑摔', () => {
    const w = world();
    const g = makeGeneral(w, 'guanping', 30);
    g.skillCount = -1e9;
    g.level = 3;
    const first = w.actors[g.partIds[0]!]!.loc as { x: number; y: number };
    const p = w.paths[0].reduce((best, q) => (Math.hypot(q.x - first.x * 80, q.y - first.y * 80) < Math.hypot(best.x - first.x * 80, best.y - first.y * 80) ? q : best));
    const idx = w.paths[0].indexOf(p);
    spawnEnemy(w, 0, ctx(), { at: { x: p.x, y: p.y, pathIdx: idx + 1 }, hp: 1e9, speed: 0, boss: 0 });
    const names: string[] = [];
    for (let i = 0; i < ticks(20000); i++) for (const e of stepWorld(w, [], rules)) if (e.type === 'skill') names.push(e.name);
    expect(names).not.toContain('挑摔');
  });

  it('丈八蛇矛：裝備時在射程內道路放蛇', () => {
    const w = world();
    makeGeneral(w, 'zhangfei', 18);
    expect(Object.values(w.skills).some((s) => s.kind === 'zone' && s.left === -1)).toBe(true);
  });

  it('AI 配裝：武器類型與武將相符、同一武將不重複', () => {
    const op = generateOpponent(data, 123, 260, 5, 3);
    op.aiEquip.forEach((wid, gi) => {
      if (wid < 0) return;
      const wd = data.weapons.weapons.find((x) => x.id === wid)!;
      expect(wd.type).toBe(data.generals.generals[gi]!.weaponType);
    });
    expect(op.aiEquip.filter((x) => x >= 0).length).toBeGreaterThan(0);
  });
});

describe('被動道具', () => {
  it('續命丹：持有方 +5、對方 +3；大補丸 +3', () => {
    const w = createWorld({ data, seed: 1, mapId: 0, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: true, playerItems: [{ id: ITEM.xuMingPill, level: 1 }], aiItems: [{ id: ITEM.daBuPill, level: 1 }] });
    expect(w.camps[0].lives).toBe(3 + 5);
    expect(w.camps[1].lives).toBe(3 + 3 + 3);
  });

  it('齊頭並進：固定玩家 +50%、AI +30%（即使是 AI 持有）', () => {
    const w = createWorld({ data, seed: 1, mapId: 0, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: true, aiItems: [{ id: ITEM.goingHandInHand, level: 1 }] });
    expect(w.globals.find((g) => g.side === 0)?.num).toBe(0.5);
    expect(w.globals.find((g) => g.side === 1)?.num).toBe(0.3);
  });

  it('淤泥：自己防區的敵人移速 -10%', () => {
    const w = world({ playerItems: [{ id: ITEM.silt, level: 1 }] });
    const e = mob(w, 3);
    expect(statBonus(w, e.id, BUFF.moveSpeed, 100)).toBeCloseTo(-10);
  });

  it('招賢榜：名字字可能多一張，之後抽名字字多消耗一張', () => {
    const w = world({ playerItems: [{ id: ITEM.recruit, level: 1 }] });
    expect(w.camps[0].deck.length).toBeGreaterThan(w.camps[1].deck.length);
    expect(w.itemState.recruitBoost[0]).toBe(true);
  });

  it('農民：30 秒刷出 1 級農民，在待開墾地依週期產金', () => {
    const w = world({ playerItems: [{ id: ITEM.farmer, level: 1 }] });
    run(w, ticks(30000));
    const f = Object.values(w.actors).find((a) => a.kind === 'farmer');
    expect(f).toBeDefined();
    const gold = w.camps[0].gold;
    run(w, ticks(20000) + 1);
    expect(w.camps[0].gold).toBeGreaterThan(gold);
  });

  it('降妖符：自己防區 Boss 施法有機率被攔截並扣血', () => {
    const w = world({ playerItems: [{ id: ITEM.exorcismSpell, level: 1 }] });
    const b = spawnEnemy(w, 0, ctx(), { hp: 1000, boss: 0, speed: 0 });
    let blocked = 0;
    for (let i = 0; i < 40; i++) if (exorcismBlocks(w, b, ctx())) blocked++;
    expect(blocked).toBeGreaterThan(5);
    expect(b.hp).toBeLessThan(1000);
  });

  it('升職令 3 級：刷出的 1 級兵有 15% 直接 2 級', () => {
    const w = world({ playerItems: [{ id: ITEM.promotionOrder, level: 3 }] });
    let two = 0;
    let total = 0;
    for (let i = 0; i < 80; i++) {
      w.camps[0].gold = 1000;
      w.camps[0].lastRecruitTick = -1e9;
      applyCommand(w, { type: 'RECRUIT', side: 0 }, ctx());
      for (const id of w.camps[0].slots) {
        const a = w.actors[id!];
        if (a?.kind === 'soldier') {
          total++;
          if (a.level === 2) two++;
        }
      }
    }
    expect(two / total).toBeGreaterThan(0.05);
    expect(two / total).toBeLessThan(0.3);
  });
});

describe('主動道具', () => {
  it('鏟子開墾；摸金校尉挖出寶箱', () => {
    const w = world({ playerItems: [{ id: ITEM.goldSeeker, level: 1 }] });
    const slot = giveItem(w, ITEM.shovel);
    let cell: { x: number; y: number } | null = null;
    for (let x = 0; x < 8 && !cell; x++) for (let y = 5; y < 10; y++) if (w.kind[x]![y] === 2 && w.camp[x]![y] === 0) { cell = { x, y }; break; }
    const gold = w.camps[0].gold;
    expect(useItem(w, 0, slot, { c: 'board', ...cell! }, ctx()).ok).toBe(true);
    expect(w.kind[cell!.x]![cell!.y]).toBe(1);
    expect(w.camps[0].gold).toBeGreaterThan(gold);
  });

  it('神兵符必升一級；冷卻中不能再用', () => {
    const w = world();
    const a = soldier(w, 'blade', 2);
    const slot = giveItem(w, ITEM.upLvlSpell);
    expect(useItem(w, 0, slot, a.loc as never, ctx()).ok).toBe(true);
    run(w, ticks(700));
    expect(a.level).toBe(3);
    expect(useItem(w, 0, slot, a.loc as never, ctx())).toEqual({ ok: false, reason: '道具冷卻中' });
  });

  it('練兵符：1、2 級必升；滿級不可用', () => {
    const w = world();
    const a = soldier(w, 'bow', 1);
    const slot = giveItem(w, ITEM.trainingSpell);
    useItem(w, 0, slot, a.loc as never, ctx());
    run(w, ticks(700));
    expect(a.level).toBe(2);
    const b = soldier(w, 'bow', 5);
    w.items[0][slot]!.cd = 0;
    expect(useItem(w, 0, slot, b.loc as never, ctx())).toEqual({ ok: false, reason: '滿級不可使用' });
  });

  it('攻速符 +40%；御敵千里只能用在遠程', () => {
    const w = world();
    const blade = soldier(w, 'blade');
    const bow = soldier(w, 'bow');
    const s1 = giveItem(w, ITEM.attSpeedSpell);
    useItem(w, 0, s1, blade.loc as never, ctx());
    const s2 = giveItem(w, ITEM.longRange);
    expect(useItem(w, 0, s2, blade.loc as never, ctx())).toEqual({ ok: false, reason: '只能遠程' });
    expect(useItem(w, 0, s2, bow.loc as never, ctx()).ok).toBe(true);
    run(w, ticks(700));
    expect(statBonus(w, blade.id, BUFF.attSpeed, 1)).toBeCloseTo(0.4);
    expect(statBonus(w, bow.id, BUFF.attRange, 3.5)).toBeCloseTo(3.5);
  });

  it('垃圾桶：回收單位並退還等級數的資金', () => {
    const w = world();
    const a = soldier(w, 'spear', 3);
    const slot = giveItem(w, ITEM.trashCan);
    const gold = w.camps[0].gold;
    expect(useItem(w, 0, slot, a.loc as never, ctx()).ok).toBe(true);
    expect(w.actors[a.id]).toBeUndefined();
    expect(w.camps[0].gold).toBe(gold + 3);
  });

  it('陷阱抓住踩到的敵人 5 秒；地雷炸死普通敵人', () => {
    const w = world();
    const path = w.paths[0];
    const p = path[4]!;
    const cell = { c: 'board' as const, x: Math.floor(p.x / 80), y: Math.floor(p.y / 80) };
    useItem(w, 0, giveItem(w, ITEM.trap), cell, ctx());
    const e = mob(w, 4);
    run(w, 2);
    expect(hasBuff(w, e.id, BUFF.limit)).toBe(true);
    const q = path[6]!;
    useItem(w, 0, giveItem(w, ITEM.landmine), { c: 'board', x: Math.floor(q.x / 80), y: Math.floor(q.y / 80) }, ctx());
    const m = mob(w, 6, 500);
    run(w, ticks(200));
    expect(w.enemies[m.id]).toBeUndefined();
  });

  it('隕石：敵人接近阿斗時落下，消滅普通敵人', () => {
    const w = world({ playerItems: [{ id: ITEM.meteor, level: 1 }] });
    const n = w.paths[0].length;
    const e = mob(w, n - 3, 50);
    run(w, ticks(2500));
    expect(w.enemies[e.id]).toBeUndefined();
    expect(w.itemState.meteorCd[0]).toBeGreaterThan(0);
  });
});

describe('AI 道具', () => {
  it('開局道具數量依原表，不含行軍丹、鏟子、推土車', () => {
    let seed = 1;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let round = 1; round <= 30; round++) {
      const items = generateAiItems(data, rng, false, round);
      const [min, max] = data.items.aiItemCountLater[round - 1]!;
      expect(items.length).toBeGreaterThanOrEqual(Math.min(min, max));
      expect(items.length).toBeLessThanOrEqual(max);
      for (const it of items) expect([ITEM.marchPill, ITEM.shovel, ITEM.bulldozer]).not.toContain(it.id);
      expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    }
  });
});
