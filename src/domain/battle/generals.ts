// 武將：同一列、相鄰、依姓名順序排列的名字字自動成形（原版 Kh.sD/LD）；移開任一字即拆開（Kh.QB）。
// 經驗存在武將與組成字上，拆開再合沿用較大者。
import { clearBuffs, inheritGlobals } from './buffs';
import { allocId } from './create';
import { emptyWeaponState, equipWeapon, unequipWeapon, weaponAT, weaponOnLevelUp } from './weapons';
import { CELL, type Actor, type General, type Pt, type Side, type StepContext, type World } from './types';
import type { GameData } from '../../data';

type GeneralDef = GameData['generals']['generals'][number];

export function levelFromExp(def: GeneralDef, exp: number, data: GameData): number {
  const table = def.highTier ? data.generals.expHighTier : data.generals.expNormalTier;
  for (let i = table.length - 1; i >= 0; i--) if (exp >= table[i]!) return i + 1;
  return 1;
}

export function generalCenter(w: World, g: General): Pt | null {
  const first = w.actors[g.partIds[0]!];
  if (!first || first.loc.c !== 'board') return null;
  return { x: first.loc.x * CELL + (g.partIds.length * CELL) / 2, y: first.loc.y * CELL + CELL / 2 };
}

export function generalStats(w: World, g: General, data: GameData) {
  const def = data.generals.generals[g.type]!;
  const lv = g.level - 1;
  const mult = g.side === 1 ? w.aiDamageMultiplier : 1;
  return {
    def,
    // 武器攻擊加成 AT 於 M4/M5 接入，目前為 0
    damage: (def.damage + weaponAT(g, data)) * data.generals.levelDamageMultiplier[lv]! * mult,
    range: def.rangeCells * CELL,
    intervalMs: (def.intervalSec * 1000) / data.generals.levelSpeedMultiplier[lv]!,
    targetRule: def.targetRule,
  };
}

function sameSideHasType(w: World, side: Side, type: number): boolean {
  return Object.values(w.generals).some((g) => g.side === side && g.type === type);
}

/** 剛放上地圖的名字字嘗試成形；成功回傳武將 */
export function tryFormGeneral(w: World, a: Actor, ctx: StepContext): General | null {
  if (a.kind !== 'name' || a.generalId !== null || a.loc.c !== 'board') return null;
  const { x, y } = a.loc;
  const defs = ctx.data.generals.generals;
  for (const def of defs) {
    const i = def.chars.indexOf(a.token);
    if (i < 0) continue;
    const parts: Actor[] = [];
    let ok = true;
    for (let k = 0; k < def.chars.length && ok; k++) {
      const cx = x + (k - i);
      const id = w.board[cx]?.[y];
      const p = id == null ? undefined : w.actors[id];
      if (!p || p.side !== a.side || p.token !== def.chars[k] || p.generalId !== null) ok = false;
      else parts.push(p);
    }
    if (!ok || sameSideHasType(w, a.side, def.id)) continue;
    const exp = Math.max(...parts.map((p) => p.exp));
    const g: General = {
      id: allocId(w),
      side: a.side,
      type: def.id,
      partIds: parts.map((p) => p.id),
      level: 1,
      exp,
      cooldown: 0,
      skillCount: 0,
      busyUntil: 0,
      weaponId: -1,
      weapon: emptyWeaponState(),
    };
    g.level = levelFromExp(def, exp, ctx.data);
    for (const p of parts) p.generalId = g.id;
    w.generals[g.id] = g;
    equipWeapon(w, g, ctx);
    inheritGlobals(w, g.id, g.side, 'units', ctx);
    ctx.events.push({ type: 'generalFormed', generalId: g.id, side: g.side });
    return g;
  }
  return null;
}

/** 組成字被移動或移除時拆開武將；字保留經驗 */
export function dissolveGeneralOf(w: World, a: Actor): void {
  if (a.generalId === null) return;
  const g = w.generals[a.generalId];
  a.generalId = null;
  if (!g) return;
  unequipWeapon(w, g);
  for (const id of g.partIds) {
    const p = w.actors[id];
    if (p) {
      p.generalId = null;
      p.exp = g.exp;
    }
  }
  delete w.generals[g.id];
  clearBuffs(w, g.id);
  for (const s of Object.values(w.skills)) if (s.kind === 'phantom' && s.generalId === g.id) delete w.skills[s.id];
}

/** 增加經驗並重算等級；普通組滿 3 級後不再累積（原版 Ta.wD） */
export function gainExp(w: World, g: General, amount: number, ctx: StepContext): void {
  const def = ctx.data.generals.generals[g.type]!;
  const table = def.highTier ? ctx.data.generals.expHighTier : ctx.data.generals.expNormalTier;
  if (!def.highTier && g.level === table.length) return;
  g.exp = Math.max(0, g.exp + amount);
  for (const id of g.partIds) {
    const p = w.actors[id];
    if (p) p.exp = g.exp;
  }
  const level = Math.min(def.maxLevel, levelFromExp(def, g.exp, ctx.data));
  if (level !== g.level) {
    const up = level > g.level;
    g.level = level;
    if (up) weaponOnLevelUp(w, g, ctx);
    ctx.events.push({ type: 'generalLevel', generalId: g.id, level });
  }
}

/**
 * 拖到已成形武將的同字上餵經驗（原版 Ln.KY / Kh.SD）：
 * 來源不能是該武將的組成字；加 Rp[level]-Rp[level-1]（普通組也用 Rp）。
 */
export function feedTarget(w: World, src: Actor, target: Actor): General | null {
  if (src.kind !== 'name' || target.kind !== 'name' || target.generalId === null) return null;
  if (src.token !== target.token) return null;
  const g = w.generals[target.generalId];
  if (!g || g.partIds.includes(src.id)) return null;
  return g;
}

export function feedAmount(g: General, data: GameData): number {
  const rp = data.generals.expHighTier;
  return (rp[g.level] ?? 0) - (rp[g.level - 1] ?? 0);
}

export function generalMaxLevel(g: General, data: GameData): number {
  return data.generals.generals[g.type]!.maxLevel;
}
