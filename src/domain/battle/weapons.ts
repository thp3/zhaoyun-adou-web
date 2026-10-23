// 武將武器（原版 Be 與 De/Xe/ea/La 子類、44 把正式武器與 4 種預設）。
// 武器決定：攻擊加成 AT、普攻型態（依武將切換槍法）、命中與擊殺附加效果、計數或機率替換普攻的特技。
// 動畫時長、彈速改由排程與固定速度表示，屬待校正數值。
import type { GameData } from '../../data';
import { BUFF, applyBuff } from './buffs';
import type { Attacker } from './combat';
import { allocId, schedule } from './create';
import { damageEnemy, maxHpOf } from './enemies';
import { generalCenter } from './generals';
import { nextFloat, nextInt } from './rng';
import { CELL, TICK_MS, ticks, type AttackSource, type Enemy, type General, type ShotFx, type StepContext, type WeaponState, type World } from './types';

/** 每單位 gS 約對應 160 px/s（普通箭 gS=3 ≈ 480 px/s） */
const GS = 160;

export function emptyWeaponState(): WeaponState {
  return { stackTarget: null, stacks: 0, counter: 0, seen: [], tracked: null, spinNext: false, villainUntil: 0, weakUntil: 0 };
}

export function weaponDef(id: number, data: GameData) {
  return id >= 0 ? data.weapons.weapons.find((w) => w.id === id) : undefined;
}

/** 武器攻擊加成（預設武器 0） */
export function weaponAT(g: General, data: GameData): number {
  return weaponDef(g.weaponId, data)?.addAttPower ?? 0;
}

const rand = (w: World) => nextFloat(w.rng, 'combat');
const src = (g: General): AttackSource => ({ kind: 'general', id: g.id });
const sign = (g: General) => `wpn${g.id}`;
const enemiesOf = (w: World, side: number) => Object.values(w.enemies).filter((e) => e.side === side);
const genKey = (g: General, data: GameData) => data.generals.generals[g.type]!.key;

// ---------------- 裝備 ----------------

/** 武將成形時裝上武器：只接受與武將類型相符的武器，否則用預設 */
export function equipWeapon(w: World, g: General, ctx: StepContext): void {
  const def = ctx.data.generals.generals[g.type]!;
  const id = w.equip[g.side]?.[g.type] ?? -1;
  const wd = weaponDef(id, ctx.data);
  g.weaponId = wd && wd.type === def.weaponType ? id : -1;
  g.weapon = emptyWeaponState();
  const flat = (type: number, num: number, percent = false) =>
    applyBuff(w, g.id, type, num, { percent, timeMs: -1, sign: sign(g) }, ctx);
  switch (g.weaponId) {
    case 1:
    case 11:
    case 21:
    case 32:
      flat(BUFF.attRange, 0.5);
      break;
    case 13:
      flat(BUFF.attRange, 1);
      break;
    case 8:
      flat(BUFF.attRange, 1, true);
      break;
    case 33:
      flat(BUFF.attPower, 3);
      break;
    case 18:
      placeSnake(w, g, ctx);
      break;
  }
}

/** 升級時（丈八蛇矛）再放一條蛇 */
export function weaponOnLevelUp(w: World, g: General, ctx: StepContext): void {
  if (g.weaponId === 18) placeSnake(w, g, ctx);
}

// ---------------- 彈體工具 ----------------

function homing(w: World, g: General, at: { x: number; y: number }, t: Enemy, damage: number, speed: number, blast?: { r: number; damage: number; knock: number }): void {
  const id = allocId(w);
  w.projectiles[id] = { id, side: g.side, src: src(g), targetId: t.id, x: at.x, y: at.y, speed, damage, ...(blast ? { blast } : {}) };
}

function shot(w: World, g: General, at: { x: number; y: number }, dir: { x: number; y: number }, o: { damage: number; speed: number; pierce: boolean; radius?: number; range?: number; fx?: ShotFx }): void {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const id = allocId(w);
  w.skills[id] = {
    id,
    kind: 'shot',
    side: g.side,
    src: src(g),
    damage: o.damage,
    x: at.x,
    y: at.y,
    dx: dir.x / len,
    dy: dir.y / len,
    speed: o.speed,
    left: o.range ?? 1200,
    traveled: 0,
    pierce: o.pierce,
    radius: o.radius ?? 28,
    hit: [],
    fx: o.fx ?? {},
  };
}

function zone(w: World, g: General, x: number, y: number, damage: number, ms: number, rehitMs: number): void {
  const id = allocId(w);
  w.skills[id] = { id, kind: 'zone', side: g.side, src: src(g), damage, x, y, left: ms < 0 ? -1 : ticks(ms), rehit: ticks(rehitMs), lastHit: {} };
}

/** 丈八蛇矛：在射程內的己方道路格隨機放蛇（永久，每 2 秒咬一次） */
function placeSnake(w: World, g: General, ctx: StepContext): void {
  const at = generalCenter(w, g);
  if (!at) return;
  const range = ctx.data.generals.generals[g.type]!.rangeCells * CELL;
  const cands = w.paths[g.side].slice(1).filter((p) => Math.hypot(p.x - at.x, p.y - at.y) <= range);
  // 原版取 range(0, n-1) 右界不含：多候選時最後一格選不到
  const n = cands.length > 1 ? cands.length - 1 : cands.length;
  if (n === 0) return;
  const p = cands[nextInt(w.rng, 'combat', n)]!;
  zone(w, g, p.x, p.y, generalDamage(w, g, ctx), -1, 2000);
  ctx.events.push({ type: 'skill', side: g.side, name: '蛇', x: p.x, y: p.y });
}

function generalDamage(w: World, g: General, ctx: StepContext): number {
  const def = ctx.data.generals.generals[g.type]!;
  const mult = g.side === 1 ? w.aiDamageMultiplier : 1;
  return (def.damage + weaponAT(g, ctx.data)) * ctx.data.generals.levelDamageMultiplier[g.level - 1]! * mult;
}

// ---------------- 出手 ----------------

/** 同目標連擊加攻速（角弓、鐵刀 +0.05；神臂弓 +0.15；累計上限 20） */
function stackOnTarget(w: World, g: General, target: Enemy, step: number, ctx: StepContext): void {
  const st = g.weapon;
  if (st.stackTarget === target.id) st.stacks = Math.min(st.stacks + step, 20);
  else {
    st.stackTarget = target.id;
    st.stacks = 0;
  }
  w.buffs[g.id] = (w.buffs[g.id] ?? []).filter((b) => b.sign !== `${sign(g)}stack`);
  if (st.stacks > 0) applyBuff(w, g.id, BUFF.attSpeed, st.stacks, { percent: true, timeMs: -1, sign: `${sign(g)}stack` }, ctx);
}

export type NormalAttack = 'melee' | 'arrow' | 'spear' | 'sweep';

/**
 * 武將出手：處理武器的計數／機率特技；回傳要做的普通攻擊，或 null 表示這次被特技取代。
 * 呼叫端負責排程普通攻擊。
 */
export function weaponAttack(w: World, g: General, atk: Attacker, target: Enemy, ctx: StepContext): { style: NormalAttack; repeat: number } | null {
  const data = ctx.data;
  const key = genKey(g, data);
  const st = g.weapon;
  const at = atk.at;
  const wid = g.weaponId;
  const type = data.generals.generals[g.type]!.weaponType;
  if (st.weakUntil > w.tick) return null;

  switch (wid) {
    case 3:
    case 22:
      stackOnTarget(w, g, target, 0.05, ctx);
      break;
    case 6:
      stackOnTarget(w, g, target, 0.15, ctx);
      break;
  }

  // 弓
  if (type === 0) {
    const dir = { x: target.x - at.x, y: target.y - at.y };
    if (wid === 4 && nextInt(w.rng, 'combat', 100) < 10) {
      shot(w, g, at, dir, { damage: 3 * atk.damage, speed: 0.35 * GS, pierce: true, radius: 34, fx: { knock: 0.3, slow: true, label: '鷹' } });
      ctx.events.push({ type: 'skill', side: g.side, name: '射鵰', x: at.x, y: at.y });
      return null;
    }
    if (wid === 5 && nextInt(w.rng, 'combat', 100) < 10) {
      shot(w, g, at, dir, { damage: atk.damage, speed: 5 * GS, pierce: true, radius: 30, fx: { fireTrail: true, label: '龍' } });
      ctx.events.push({ type: 'skill', side: g.side, name: '火龍', x: at.x, y: at.y });
      return null;
    }
    if (wid === 8) {
      // 落日弓：一律改射鳳凰，穿透、距離增傷、灼燒、減速
      shot(w, g, at, dir, { damage: atk.damage, speed: 3 * GS, pierce: true, radius: 30, fx: { growth: true, burn: { num: 10, ms: 2000 }, slow: true, label: '凰' } });
      return null;
    }
    if (wid === 9) {
      if (st.counter < 10) st.counter += 1;
      else {
        // 諸葛連弩：第 11 次改為約 2 秒的火箭掃射
        st.counter = 0;
        g.busyUntil = w.tick + ticks(2000);
        schedule(w, 1, { kind: 'weaponFx', generalId: g.id, fx: 'volley', targetId: target.id, n: 10 });
        ctx.events.push({ type: 'skill', side: g.side, name: '連弩', x: at.x, y: at.y });
        return null;
      }
    }
    if (wid === 6) {
      // 神臂弓：主箭外另生 3 拳，各 1 倍
      for (let i = 0; i < 3; i++) homing(w, g, { x: at.x + (rand(w) * 100 - 50), y: at.y + (rand(w) * 100 - 50) }, target, atk.damage, 3 * GS);
    }
    // 黃忠多重箭：等級 1–5 為 1/1/2/2/3 枝，分給最近的數個目標
    if (key === 'huangzhong') {
      const n = [1, 1, 2, 2, 3][g.level - 1] ?? 1;
      const extra = enemiesOf(w, g.side)
        .filter((e) => e.id !== target.id && Math.hypot(e.x - at.x, e.y - at.y) <= atk.range)
        .sort((a, b) => Math.hypot(a.x - at.x, a.y - at.y) - Math.hypot(b.x - at.x, b.y - at.y))
        .slice(0, n - 1);
      for (const e of extra) homing(w, g, at, e, atk.damage, 3 * GS);
    }
    return { style: 'arrow', repeat: 1 };
  }

  // 槍：依武將切換槍法（張飛迴旋、趙雲五連、馬超投槍、其他一刺）
  if (type === 1) {
    if (wid === 19) {
      // 龍膽亮銀槍：每次出槍（趙雲每段）有機率對全場敵人射出 5 倍飛槍
      const segs = key === 'zhaoyun' ? 5 : 1;
      const p = key === 'zhaoyun' ? 0.05 : 0.1;
      for (let s = 0; s < segs; s++) {
        if (rand(w) > p) continue;
        schedule(w, ticks(1200), { kind: 'weaponFx', generalId: g.id, fx: 'flyingSpears', targetId: 0, n: 0 });
        ctx.events.push({ type: 'skill', side: g.side, name: '飛槍', x: at.x, y: at.y });
        break;
      }
    }
    if (key === 'zhangfei') return { style: 'sweep', repeat: 1 };
    if (key === 'zhaoyun') return { style: 'spear', repeat: 5 };
    if (key === 'machao') {
      homing(w, g, at, target, atk.damage, GS);
      return null;
    }
    return { style: 'spear', repeat: 1 };
  }

  // 刀
  if (type === 2) {
    if (st.spinNext) {
      // 青龍偃月刀：追蹤的敵人死後，下一刀改為旋斬，放出一圈刀氣
      st.spinNext = false;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        shot(w, g, at, { x: Math.cos(a), y: Math.sin(a) }, { damage: atk.damage, speed: 1 * GS * 3, pierce: true, radius: 26, range: 600, fx: { label: '氣' } });
      }
      ctx.events.push({ type: 'skill', side: g.side, name: '旋斬', x: at.x, y: at.y });
      st.tracked = target.id;
      return null;
    }
    if (wid === 24) {
      st.counter += 1;
      if (st.counter >= 10) {
        // 三尖刀：第 10 次改射 2 倍群體刀氣
        st.counter = 0;
        shot(w, g, at, { x: target.x - at.x, y: target.y - at.y }, { damage: 2 * atk.damage, speed: GS * 3, pierce: true, radius: 40, range: 700, fx: { label: '氣' } });
        ctx.events.push({ type: 'skill', side: g.side, name: '刀氣', x: at.x, y: at.y });
        return null;
      }
    }
    if (wid === 28 && rand(w) < 0.1) {
      const targets = enemiesOf(w, g.side);
      if (targets.length > 0) {
        // 七星刀：流星數＝武將等級，各落在不同敵人上
        for (let i = targets.length - 1; i > 0; i--) {
          const j = nextInt(w.rng, 'combat', i + 1);
          [targets[i], targets[j]] = [targets[j]!, targets[i]!];
        }
        const n = Math.min(g.level, targets.length);
        for (let k = 0; k < n; k++) {
          schedule(w, ticks(250 + rand(w) * 1000), { kind: 'weaponFx', generalId: g.id, fx: 'meteor', targetId: targets[k]!.id, n: 0 });
        }
        ctx.events.push({ type: 'skill', side: g.side, name: '流星雨', x: at.x, y: at.y });
        return null;
      }
    }
    if (wid === 30) {
      const p = [0.1, 0.15, 0.2, 0.25, 0.3][g.level - 1] ?? 0.1;
      if (rand(w) <= p) {
        // 方天畫戟：抽中 Boss 直接跳過這次（也不普攻）
        if (target.boss) return null;
        applyBuff(w, target.id, BUFF.stun, 1, { timeMs: 1000 }, ctx);
        g.busyUntil = w.tick + ticks(1000);
        schedule(w, ticks(1000), { kind: 'weaponFx', generalId: g.id, fx: 'halberd', targetId: target.id, n: 0 });
        ctx.events.push({ type: 'skill', side: g.side, name: '挑摔', x: at.x, y: at.y });
        return null;
      }
    }
    if (wid === 29) g.weapon.tracked = target.id;
    return { style: 'melee', repeat: 1 };
  }

  // 劍：十次技能劍（君子／小人）；短、長、鐵劍與預設劍不計數
  if (wid >= 34 && wid <= 43) {
    if (st.counter < 9) {
      if (st.villainUntil <= w.tick && st.weakUntil <= w.tick) st.counter += 1;
    } else {
      st.counter = 0;
      const h = wid === 36 ? 0 : wid === 37 ? 1 : 0.5;
      // 劉備固定君子
      const villain = key === 'liubei' ? false : rand(w) < h;
      if (villain && st.villainUntil <= w.tick) {
        st.villainUntil = w.tick + ticks(6500);
        g.busyUntil = w.tick + ticks(1950);
        schedule(w, ticks(1950), { kind: 'weaponFx', generalId: g.id, fx: 'villainBuff', targetId: 0, n: 0 });
        schedule(w, ticks(6500), { kind: 'weaponFx', generalId: g.id, fx: 'villainEnd', targetId: 0, n: 0 });
        ctx.events.push({ type: 'skill', side: g.side, name: '小人劍', x: at.x, y: at.y });
      } else {
        g.busyUntil = w.tick + ticks(2600);
        schedule(w, ticks(750), { kind: 'weaponFx', generalId: g.id, fx: 'gentleman', targetId: 0, n: 0 });
        ctx.events.push({ type: 'skill', side: g.side, name: '君子劍', x: at.x, y: at.y });
      }
      return null;
    }
  }
  return { style: 'sweep', repeat: 1 };
}

/** 小人模式期間掃擊範圍 ×3 */
export function weaponRangeMult(w: World, g: General): number {
  return g.weapon.villainUntil > w.tick ? 3 : 1;
}

/** 普攻排程後：狼牙棒／虎嘯戰刀 10% 給周邊友軍加攻速；鐵蒺藜骨朵 10% 暈眩目標 */
export function weaponAfterAttack(w: World, g: General, atk: Attacker, target: Enemy, ctx: StepContext): void {
  const wid = g.weaponId;
  if ((wid === 23 || wid === 27) && rand(w) < 0.1) {
    const num = wid === 23 ? 0.2 : 0.3;
    for (const a of Object.values(w.actors)) {
      if (a.side !== g.side || a.kind !== 'soldier' || a.loc.c !== 'board') continue;
      const cx = a.loc.x * CELL + CELL / 2;
      const cy = a.loc.y * CELL + CELL / 2;
      if (Math.hypot(cx - atk.at.x, cy - atk.at.y) <= atk.range) applyBuff(w, a.id, BUFF.attSpeed, num, { percent: true, timeMs: 10000 }, ctx);
    }
    for (const o of Object.values(w.generals)) {
      if (o.side !== g.side || o.id === g.id) continue;
      const c = generalCenter(w, o);
      if (c && Math.hypot(c.x - atk.at.x, c.y - atk.at.y) <= atk.range) applyBuff(w, o.id, BUFF.attSpeed, num, { percent: true, timeMs: 10000 }, ctx);
    }
    ctx.events.push({ type: 'skill', side: g.side, name: wid === 23 ? '狼嚎' : '虎嘯', x: atk.at.x, y: atk.at.y });
  }
  if (wid === 25 && rand(w) < 0.1) applyBuff(w, target.id, BUFF.stun, 1, { timeMs: 500 }, ctx);
}

// ---------------- 命中與擊殺 ----------------

/** 武將攻擊命中後的武器附加效果；在本體傷害之前呼叫 */
export function weaponOnHit(w: World, g: General, e: Enemy, damage: number, ctx: StepContext): void {
  const wid = g.weaponId;
  const st = g.weapon;
  const firstHit = !st.seen.includes(e.id);
  switch (wid) {
    case 2:
      if (rand(w) < 0.1) applyBuff(w, e.id, BUFF.knockback, 1, { timeMs: -1 }, ctx);
      break;
    case 7: {
      // 霸王弓：多輪各 50% 隨機一名敵人受閃電鏈
      const all = enemiesOf(w, g.side);
      const rounds = Math.ceil(Object.keys(w.enemies).length / 2);
      for (let i = 0; i < rounds; i++) {
        if (rand(w) >= 0.5 || all.length === 0) continue;
        const t = all[nextInt(w.rng, 'combat', all.length)]!;
        if (t.id === e.id || !w.enemies[t.id]) continue;
        ctx.events.push({ type: 'attack', src: src(g), kind: 'spear', x: e.x, y: e.y, tx: t.x, ty: t.y });
        damageEnemy(w, t, damage, src(g), ctx);
      }
      break;
    }
    case 12:
      if (firstHit && rand(w) <= 0.2) {
        applyBuff(w, e.id, BUFF.pierce, 1, { timeMs: 500 }, ctx);
        damageEnemy(w, e, 2 * damage, src(g), ctx);
      }
      break;
    case 14:
      if (firstHit && rand(w) <= 0.2) applyBuff(w, e.id, BUFF.fall, 0, { timeMs: 2000 }, ctx);
      break;
    case 15:
    case 16:
      st.tracked = e.id;
      break;
    case 17:
      if (firstHit && rand(w) <= 0.2) {
        const pool = enemiesOf(w, g.side);
        const n = genKey(g, ctx.data) === 'machao' ? 5 : 3;
        for (let k = 0; k < n && pool.length > 0; k++) {
          const t = pool.splice(nextInt(w.rng, 'combat', pool.length), 1)[0]!;
          applyBuff(w, t.id, BUFF.pierce, 1, { timeMs: 500 }, ctx);
          damageEnemy(w, t, 3 * damage, src(g), ctx);
        }
        ctx.events.push({ type: 'skill', side: g.side, name: '槍陣', x: e.x, y: e.y });
      }
      break;
    case 26:
      // 古錠刀：每個新敵人第一次被砍中 +1 戰鬥資金
      if (firstHit) w.camps[g.side].gold += 1;
      break;
  }
  if (firstHit && (wid === 12 || wid === 14 || wid === 17 || wid === 26)) st.seen.push(e.id);
}

/** 敵人死亡：通知追蹤牠的武器（點鋼槍加攻速、梨花槍放梨花、青龍偃月刀下一刀旋斬）；不核對擊殺來源 */
export function weaponOnEnemyDied(w: World, e: Enemy, ctx: StepContext): void {
  for (const g of Object.values(w.generals)) {
    if (g.weapon.tracked !== e.id) continue;
    g.weapon.tracked = null;
    if (g.weaponId === 15) applyBuff(w, g.id, BUFF.attSpeed, 0.5, { percent: true, timeMs: 2000 }, ctx);
    else if (g.weaponId === 29) g.weapon.spinNext = true;
    else if (g.weaponId === 16) {
      const rest = enemiesOf(w, g.side);
      if (rest.length <= 1 && !w.enemies[e.id]) continue;
      const dmg = generalDamage(w, g, ctx);
      for (let i = 0; i < 8 && rest.length > 0; i++) {
        homing(w, g, { x: e.x, y: e.y }, rest[nextInt(w.rng, 'combat', rest.length)]!, dmg, (0.5 + rand(w)) * GS);
      }
      ctx.events.push({ type: 'skill', side: g.side, name: '梨花', x: e.x, y: e.y });
    }
  }
}

// ---------------- 延遲特技 ----------------

export function resolveWeaponFx(w: World, a: { generalId: number; fx: string; targetId: number; n: number }, ctx: StepContext): void {
  const g = w.generals[a.generalId];
  const at = g ? generalCenter(w, g) : null;
  if (!g || !at) return;
  const dmg = generalDamage(w, g, ctx);
  switch (a.fx) {
    case 'volley': {
      // 連弩：一輪 10 枝火箭左右掃射，每枝附每秒 1 點、5 秒灼燒
      const t = w.enemies[a.targetId] ?? enemiesOf(w, g.side)[0];
      const base = t ? Math.atan2(t.y - at.y, t.x - at.x) : -Math.PI / 2;
      const k = 10 - a.n;
      const ang = base + ((k % 2 === 0 ? k : 10 - k) / 10 - 0.5) * (Math.PI / 2);
      shot(w, g, at, { x: Math.cos(ang), y: Math.sin(ang) }, { damage: dmg, speed: 4 * GS, pierce: false, radius: 24, range: 900, fx: { burn: { num: 1, ms: 5000 }, label: '箭' } });
      if (a.n > 1) schedule(w, ticks(200), { kind: 'weaponFx', generalId: a.generalId, fx: 'volley', targetId: a.targetId, n: a.n - 1 });
      return;
    }
    case 'flyingSpears': {
      enemiesOf(w, g.side).forEach((e, k) => {
        homing(w, g, { x: at.x + (k % 5) * 6, y: at.y - 40 }, e, 5 * dmg, 2 * GS);
      });
      return;
    }
    case 'meteor': {
      const t = w.enemies[a.targetId];
      if (!t) return;
      homing(w, g, { x: t.x + (rand(w) * 170 - 85), y: -40 }, t, 2 * dmg, 4 * GS, { r: 2 * CELL, damage: 2 * dmg, knock: 1 });
      return;
    }
    case 'halberd': {
      const t = w.enemies[a.targetId];
      if (!t) return;
      // 方天畫戟摔下：血量 ≥20% 受 5 倍，否則直接斃命；落點 50px 內敵人摔倒
      const hit = t.hp >= 0.2 * maxHpOf(w, t) ? 5 * dmg : t.hp;
      const x = t.x;
      const y = t.y;
      damageEnemy(w, t, hit, src(g), ctx);
      for (const e of enemiesOf(w, g.side)) if (Math.hypot(e.x - x, e.y - y) <= 50) applyBuff(w, e.id, BUFF.fall, dmg, { timeMs: 1000 }, ctx);
      ctx.events.push({ type: 'blast', x, y, r: 50 });
      return;
    }
    case 'gentleman': {
      // 君子劍：射程內敵人暈 3 秒並受半倍傷害
      const r = ctx.data.generals.generals[g.type]!.rangeCells * CELL;
      ctx.events.push({ type: 'blast', x: at.x, y: at.y, r });
      for (const e of enemiesOf(w, g.side)) {
        if (Math.hypot(e.x - at.x, e.y - at.y) > r) continue;
        applyBuff(w, e.id, BUFF.stun, 1, { timeMs: 3000 }, ctx);
        damageEnemy(w, e, dmg / 2, src(g), ctx);
      }
      return;
    }
    case 'villainBuff':
      // 小人劍：攻擊 +200%（依基礎攻擊）5 秒
      applyBuff(w, g.id, BUFF.attPower, 2, { percent: true, timeMs: 5000 }, ctx);
      return;
    case 'villainEnd':
      // 小人模式結束後虛弱 5 秒：不能出手
      g.weapon.weakUntil = w.tick + ticks(5000);
      return;
  }
}

// ---------------- 持續型彈體 ----------------

export function updateWeaponEntities(w: World, ctx: StepContext): void {
  const dt = TICK_MS / 1000;
  for (const s of Object.values(w.skills)) {
    if (s.kind === 'shot') {
      const step = s.speed * dt;
      s.x += s.dx * step;
      s.y += s.dy * step;
      s.left -= step;
      s.traveled += step;
      if (s.fx.fireTrail && Math.floor(s.traveled / CELL) !== Math.floor((s.traveled - step) / CELL)) {
        // 火龍尾部落在己方道路格時留下 5 秒地火
        const cx = Math.floor(s.x / CELL);
        const cy = Math.floor(s.y / CELL);
        const g = w.generals[s.src.id];
        if (g && w.kind[cx]?.[cy] === 0 && w.camp[cx]?.[cy] === s.side) zone(w, g, cx * CELL + CELL / 2, cy * CELL + CELL / 2, s.damage, 5000, 1000);
      }
      for (const e of enemiesOf(w, s.side)) {
        if (s.hit.includes(e.id) || Math.hypot(e.x - s.x, e.y - s.y) > s.radius) continue;
        s.hit.push(e.id);
        const dmg = s.fx.growth ? Math.min(s.damage + Math.floor(s.traveled / 250), 2 * s.damage) : s.damage;
        if (s.fx.knock) applyBuff(w, e.id, BUFF.knockback, s.fx.knock, { timeMs: -1 }, ctx);
        if (s.fx.slow) applyBuff(w, e.id, BUFF.moveSpeed, -0.8, { percent: true, timeMs: 1000 }, ctx);
        if (s.fx.burn) applyBuff(w, e.id, BUFF.burnStatic, s.fx.burn.num, { timeMs: s.fx.burn.ms }, ctx);
        damageEnemy(w, e, dmg, s.src, ctx);
        if (!s.pierce) {
          s.left = 0;
          break;
        }
      }
      if (s.left <= 0 || s.x < -80 || s.y < -80 || s.x > 720 || s.y > 880) delete w.skills[s.id];
    } else if (s.kind === 'zone') {
      if (s.left > 0) s.left -= 1;
      if (s.left === 0) {
        delete w.skills[s.id];
        continue;
      }
      for (const e of enemiesOf(w, s.side)) {
        if (Math.abs(e.x - s.x) > CELL / 2 || Math.abs(e.y - s.y) > CELL / 2) continue;
        const last = s.lastHit[e.id];
        if (last !== undefined && w.tick - last < s.rehit) continue;
        s.lastHit[e.id] = w.tick;
        damageEnemy(w, e, s.damage, s.src, ctx);
      }
    }
  }
}

/** 武將拆開或局末：移除武器登記的永久 buff */
export function unequipWeapon(w: World, g: General): void {
  w.buffs[g.id] = (w.buffs[g.id] ?? []).filter((b) => !b.sign?.startsWith(sign(g)));
  for (const s of Object.values(w.skills)) if ((s.kind === 'zone' || s.kind === 'shot') && s.src.kind === 'general' && s.src.id === g.id) delete w.skills[s.id];
}

