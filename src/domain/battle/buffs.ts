// 20 種 buff（原版 te / Ns / Zs）。數值類各筆獨立累加；狀態類同型第二筆併入第一筆（num 相加、有期限則時間相加）；
// 摔倒 9、擊倒 17 改為刷新期限；灼燒 14 每筆獨立。
// 與原版的有意差異：
// 1. 百分比數值在查詢時以「當下基礎值 × 百分比」計算，不在加入時固定，避免升級後解除扣回不同數額。
// 2. 控制旗標依「是否仍有任一種對應 buff」判斷；原版旗標不計數，移除一種控制可能誤解除另一種。
import { CELL, TICK_MS, ticks, type BuffEntry, type Side, type StepContext, type World } from './types';

export const BUFF = {
  attPower: 0,
  attSpeed: 1,
  attRange: 2,
  moveSpeed: 3,
  maxHp: 4,
  hp: 5,
  scale: 6,
  custom: 7,
  stun: 8,
  fall: 9,
  pierce: 10,
  electrocute: 11,
  knockback: 12,
  chaos: 13,
  burnStatic: 14,
  limit: 15,
  lock: 16,
  knockdown: 17,
  suppression: 18,
  charm: 19,
} as const;

const STATE_MIN = 8;
/** 同型追加時刷新期限而非累加（原版 mv=true） */
const REFRESH_TIME = new Set<number>([BUFF.fall, BUFF.knockdown]);
/** 每筆獨立（原版 Lv=false） */
const INDEPENDENT = new Set<number>([BUFF.burnStatic]);

const BURN_INTERVAL = ticks(1000);

export function buffsOf(w: World, id: number): BuffEntry[] {
  return w.buffs[id] ?? [];
}

export function hasBuff(w: World, id: number, type: number): boolean {
  return buffsOf(w, id).some((b) => b.type === type);
}

/** 數值類加總：percent 以 base 計 */
export function statBonus(w: World, id: number, type: number, base: number): number {
  let sum = 0;
  for (const b of buffsOf(w, id)) if (b.type === type) sum += b.percent ? base * b.num : b.num;
  return sum;
}

/** 攻速加成；原版 N_ 把負值清 0，因此減益只能抵消增益 */
export function attackSpeedBonus(w: World, id: number): number {
  return Math.max(0, statBonus(w, id, BUFF.attSpeed, 1));
}

// ---------- 控制旗標 ----------

/** 普通兵是否不能出手（暈眩、電擊、混亂、鎖鏈、擊倒） */
export function unitDisabled(w: World, id: number): boolean {
  return buffsOf(w, id).some((b) => b.type === 8 || b.type === 11 || b.type === 13 || b.type === 16 || b.type === 17);
}

/** 是否不能拖動（混亂、鎖鏈、魅惑） */
export function unitPinned(w: World, id: number): boolean {
  return buffsOf(w, id).some((b) => b.type === 13 || b.type === 16 || b.type === 19);
}

/** 是否被壓到 1 級且禁止合成（壓制、魅惑） */
export function unitSuppressed(w: World, id: number): boolean {
  return buffsOf(w, id).some((b) => b.type === 18 || b.type === 19);
}

/** 敵人是否停止前進（暈眩、摔倒、刺穿、電擊、混亂；限制另擋擊退） */
export function enemyHalted(w: World, id: number): boolean {
  return buffsOf(w, id).some((b) => b.type === 8 || b.type === 9 || b.type === 10 || b.type === 11 || b.type === 13 || b.type === 15);
}

// ---------- 加入／移除 ----------

export interface ApplyOptions {
  percent?: boolean;
  /** 毫秒；-1 永久、-2 到下一波開始 */
  timeMs?: number;
  sign?: string | null;
}

function targetExists(w: World, id: number): boolean {
  return !!(w.enemies[id] || w.actors[id] || w.generals[id]);
}

/** 加入 buff；回傳子 id，目標不存在或被拒回傳 -1 */
export function applyBuff(w: World, id: number, type: number, num: number, opt: ApplyOptions, ctx: StepContext): number {
  if (!targetExists(w, id)) return -1;
  // 擊退與限制互斥：有限制時拒絕擊退；加限制先移除擊退（移除可能刪掉整個列表，之後才取列表）
  if (type === BUFF.knockback && hasBuff(w, id, BUFF.limit)) return -1;
  if (type === BUFF.limit) removeBuffType(w, id, BUFF.knockback);
  const list = (w.buffs[id] ??= []);
  const timeMs = opt.timeMs ?? -1;
  const time = timeMs < 0 ? timeMs : ticks(timeMs);
  const first = type >= STATE_MIN && !INDEPENDENT.has(type) ? list.find((b) => b.type === type) : undefined;
  if (first) {
    first.num += num;
    if (REFRESH_TIME.has(type)) {
      if (first.time !== -1) {
        first.time = time;
        first.timer = 0;
      }
    } else if (first.time !== -1) first.time += time;
    if (type === BUFF.knockback) addKnockback(w, id, num, 1);
    return first.sub;
  }
  const entry: BuffEntry = { sub: w.seq++, type, num, percent: opt.percent ?? false, time, timer: 0, sign: opt.sign ?? null };
  list.push(entry);
  onAdded(w, id, entry, ctx);
  return entry.sub;
}

function onAdded(w: World, id: number, b: BuffEntry, ctx: StepContext): void {
  const e = w.enemies[id];
  if (e) {
    if (b.type === BUFF.maxHp) {
      const add = b.percent ? e.maxHp * b.num : b.num;
      if (add > 0) e.hp += add;
    }
    if (b.type === BUFF.knockback) addKnockback(w, id, b.num, 3);
    if (b.type === BUFF.fall && b.num > 0) damageViaHook(w, id, b.num, ctx);
    if (b.type === BUFF.burnStatic) {
      damageViaHook(w, id, b.num, ctx);
      b.timer = 0;
    }
  }
  ctx.events.push({ type: 'buff', targetId: id, buffType: b.type, x: e?.x ?? 0, y: e?.y ?? 0 });
}

/** 原版初次擊退沿三個呼叫點各累加一次向量；之後追加只一次 */
function addKnockback(w: World, id: number, force: number, times: number): void {
  const e = w.enemies[id];
  if (e) e.knockVel += force * CELL * times;
}

// 由 enemies.ts 注入，避免循環依賴
let damageHook: ((w: World, id: number, amount: number, ctx: StepContext) => void) | null = null;
export function setBuffDamageHook(fn: typeof damageHook): void {
  damageHook = fn;
}
function damageViaHook(w: World, id: number, amount: number, ctx: StepContext): void {
  damageHook?.(w, id, amount, ctx);
}

function removeEntry(w: World, id: number, b: BuffEntry): void {
  const list = w.buffs[id];
  if (!list) return;
  const i = list.indexOf(b);
  if (i >= 0) list.splice(i, 1);
  const e = w.enemies[id];
  if (e && b.type === BUFF.maxHp) {
    const max = enemyMaxHp(w, e.id, e.maxHp);
    if (e.hp > max) e.hp = max;
  }
  if (e && b.type === BUFF.knockback) e.knockVel = 0;
  if (list.length === 0) delete w.buffs[id];
}

export function removeBuffType(w: World, id: number, type: number): void {
  for (const b of [...buffsOf(w, id)]) if (b.type === type) removeEntry(w, id, b);
}

export function removeBuffsBySignPrefix(w: World, id: number, prefix: string): void {
  for (const b of [...buffsOf(w, id)]) if (b.sign?.startsWith(prefix)) removeEntry(w, id, b);
}

export function clearBuffs(w: World, id: number): void {
  delete w.buffs[id];
}

/** 敵人目前最大血量（基礎 + maxHp buff） */
export function enemyMaxHp(w: World, id: number, base: number): number {
  return base + statBonus(w, id, BUFF.maxHp, base);
}

// ---------- 全局來源 ----------

/** 對某一方的現有單位／敵人立即套用，並登記給之後新建的對象 */
export function addGlobal(
  w: World,
  g: { sign: string; side: Side; target: 'units' | 'enemies'; type: number; num: number; percent: boolean; timeMs: number },
  ctx: StepContext,
): void {
  const time = g.timeMs < 0 ? g.timeMs : ticks(g.timeMs);
  w.globals.push({ sign: g.sign, side: g.side, target: g.target, type: g.type, num: g.num, percent: g.percent, time });
  for (const id of globalTargets(w, g.side, g.target)) applyBuff(w, id, g.type, g.num, { percent: g.percent, timeMs: g.timeMs, sign: g.sign }, ctx);
}

export function removeGlobal(w: World, sign: string): void {
  w.globals = w.globals.filter((g) => g.sign !== sign);
  for (const id of Object.keys(w.buffs).map(Number)) removeBuffsBySignPrefix(w, id, sign);
}

function globalTargets(w: World, side: Side, target: 'units' | 'enemies'): number[] {
  if (target === 'enemies') return Object.values(w.enemies).filter((e) => e.side === side).map((e) => e.id);
  return [
    ...Object.values(w.actors).filter((a) => a.side === side && a.kind === 'soldier').map((a) => a.id),
    ...Object.values(w.generals).filter((g) => g.side === side).map((g) => g.id),
  ];
}

/** 新建的單位／敵人補掛該方的全局效果 */
export function inheritGlobals(w: World, id: number, side: Side, target: 'units' | 'enemies', ctx: StepContext): void {
  for (const g of w.globals) {
    if (g.side !== side || g.target !== target) continue;
    applyBuff(w, id, g.type, g.num, { percent: g.percent, timeMs: g.time < 0 ? g.time : g.time * TICK_MS, sign: g.sign }, ctx);
  }
}

// ---------- 每 tick ----------

export function updateBuffs(w: World, ctx: StepContext): void {
  for (const key of Object.keys(w.buffs)) {
    const id = Number(key);
    const list = w.buffs[id];
    if (!list) continue;
    if (!targetExists(w, id)) {
      delete w.buffs[id];
      continue;
    }
    for (const b of [...list]) {
      b.timer += 1;
      if (b.type === BUFF.burnStatic && b.timer % BURN_INTERVAL === 0) {
        // 每秒把所有灼燒的 num 加總造成一次傷害
        const total = list.filter((x) => x.type === BUFF.burnStatic).reduce((s, x) => s + x.num, 0);
        if (list.find((x) => x.type === BUFF.burnStatic) === b) damageViaHook(w, id, total, ctx);
      }
      if (b.time >= 0 && b.timer >= b.time) removeEntry(w, id, b);
    }
  }
}

/** 下一波開始時移除 time=-2 的 buff */
export function expireRoundBuffs(w: World): void {
  for (const key of Object.keys(w.buffs)) {
    const id = Number(key);
    for (const b of [...buffsOf(w, id)]) if (b.time === -2) removeEntry(w, id, b);
  }
}

/** 普通兵正向升級：解除鎖鏈、擊倒與該單位身上的雨（原版 ri.X_ / Kh.iD） */
export function onUnitLevelUp(w: World, id: number): void {
  removeBuffType(w, id, BUFF.lock);
  removeBuffType(w, id, BUFF.knockdown);
  removeBuffsBySignPrefix(w, id, 'rain');
}
