// 攻擊：普通兵與武將共用同一套延遲出手與命中。四種出手延遲依原版動畫時序（刀 500ms 命中、弓 650ms 放箭、
// 槍 480ms 刺出、騎／劍 150ms 掃掠），改由模擬排程決定；延遲與彈速屬待校正數值。
// 武將依武器類型出手（弓→箭、槍→刺、刀→砍、劍→掃）；具名技能與武器特效於 M4 加入。
import { BUFF, applyBuff, attackSpeedBonus, statBonus, unitDisabled, unitSuppressed } from './buffs';
import { allocId, schedule } from './create';
import { damageEnemy, remainingDistance } from './enemies';
import { generalCenter, generalStats } from './generals';
import { afterGeneralAttack, beforeGeneralAttack, onGeneralHit } from './skills';
import { weaponAfterAttack, weaponAttack, weaponOnHit, weaponRangeMult } from './weapons';
import {
  CELL,
  TICK_MS,
  ticks,
  type Actor,
  type AttackSource,
  type Enemy,
  type General,
  type Pt,
  type ScheduledAction,
  type Side,
  type StepContext,
  type World,
} from './types';

const ARROW_SPEED = 480; // px/s，待校正
const SPEAR_WIDTH = 30;
export type Style = 'melee' | 'arrow' | 'spear' | 'sweep';
const DELAY_MS: Record<Style, number> = { melee: 500, arrow: 650, spear: 480, sweep: 150 };
const SOLDIER_STYLE: Record<string, Style> = { blade: 'melee', bow: 'arrow', spear: 'spear', cavalry: 'sweep' };
/** 武器類型 0 弓、1 槍、2 刀、3 劍 */
const WEAPON_STYLE: Style[] = ['arrow', 'spear', 'melee', 'sweep'];

export function actorCenter(a: Actor): Pt | null {
  if (a.loc.c !== 'board') return null;
  return { x: a.loc.x * CELL + CELL / 2, y: a.loc.y * CELL + CELL / 2 };
}

export interface Attacker {
  src: AttackSource;
  side: Side;
  at: Pt;
  damage: number;
  range: number;
  intervalTicks: number;
  targetRule: string;
  style: Style;
}

function soldierAttacker(w: World, a: Actor, ctx: StepContext): Attacker | null {
  const at = actorCenter(a);
  if (!at) return null;
  const s = ctx.data.units.soldiers.find((x) => x.id === a.token)!;
  // 壓制／魅惑期間暫降為 1 級
  const level = unitSuppressed(w, a.id) ? 1 : a.level;
  const mult = ctx.data.units.soldierLevelMultiplier[level - 1] ?? 1;
  const aiMult = a.side === 1 ? w.aiDamageMultiplier : 1;
  const base = s.damage * mult;
  return {
    src: { kind: 'actor', id: a.id },
    side: a.side,
    at,
    damage: (base + statBonus(w, a.id, BUFF.attPower, base)) * aiMult,
    // 射程 buff 以格為單位
    range: (s.rangeCells + statBonus(w, a.id, BUFF.attRange, s.rangeCells)) * CELL,
    intervalTicks: ticks((s.intervalSec * 1000) / mult / (1 + attackSpeedBonus(w, a.id))),
    targetRule: s.targetRule,
    style: SOLDIER_STYLE[a.token]!,
  };
}

function attackerOf(w: World, src: AttackSource, ctx: StepContext): Attacker | null {
  if (src.kind === 'actor') {
    const a = w.actors[src.id];
    return a && a.kind === 'soldier' ? soldierAttacker(w, a, ctx) : null;
  }
  const g = w.generals[src.id];
  const at = g ? generalCenter(w, g) : null;
  if (!g || !at) return null;
  const st = generalStats(w, g, ctx.data);
  const rangeCells = st.range / CELL;
  return {
    src,
    side: g.side,
    at,
    damage: st.damage + statBonus(w, g.id, BUFF.attPower, st.damage),
    range: (rangeCells + statBonus(w, g.id, BUFF.attRange, rangeCells)) * CELL * weaponRangeMult(w, g),
    intervalTicks: ticks(st.intervalMs / (1 + attackSpeedBonus(w, g.id))),
    targetRule: st.targetRule,
    style: WEAPON_STYLE[st.def.weaponType]!,
  };
}

export function attackerFor(w: World, src: AttackSource, ctx: StepContext): Attacker | null {
  return attackerOf(w, src, ctx);
}

export function enemiesInRange(w: World, side: number, at: Pt, range: number): Enemy[] {
  const out: Enemy[] = [];
  for (const e of Object.values(w.enemies)) {
    if (e.side !== side) continue;
    if (Math.hypot(e.x - at.x, e.y - at.y) <= range) out.push(e);
  }
  return out;
}

export function pickTarget(w: World, at: Pt, cands: Enemy[], rule: string): Enemy | null {
  let best: Enemy | null = null;
  let bestScore = Infinity;
  for (const e of cands) {
    const score = rule === 'closest_end' ? remainingDistance(w, e) : Math.hypot(e.x - at.x, e.y - at.y);
    if (score < bestScore) {
      best = e;
      bestScore = score;
    }
  }
  return best;
}

function scheduleNormal(w: World, atk: Attacker, style: Style, target: Enemy, repeat: number): void {
  const base = { src: atk.src, damage: atk.damage };
  const action: ScheduledAction =
    style === 'melee'
      ? { kind: 'meleeHit', targetId: target.id, ...base }
      : style === 'arrow'
        ? { kind: 'fireArrow', targetId: target.id, ...base }
        : style === 'spear'
          ? { kind: 'spearThrust', targetId: target.id, ...base }
          : { kind: 'cavalrySweep', ...base };
  // 多段（趙雲五連刺）每段相隔 100ms，各段可再傷同一敵人
  for (let i = 0; i < repeat; i++) schedule(w, ticks(DELAY_MS[style] + i * 100), action);
}

function tryAttack(w: World, atk: Attacker, setCooldown: (t: number) => void, ctx: StepContext): boolean {
  const target = pickTarget(w, atk.at, enemiesInRange(w, atk.side, atk.at, atk.range), atk.targetRule);
  if (!target) return false;
  setCooldown(atk.intervalTicks);
  scheduleNormal(w, atk, atk.style, target, 1);
  return true;
}

/** 武將出手：先交給武器決定普攻型態或特技 */
function generalAttack(w: World, g: General, atk: Attacker, ctx: StepContext): boolean {
  const target = pickTarget(w, atk.at, enemiesInRange(w, atk.side, atk.at, atk.range), atk.targetRule);
  if (!target) return false;
  g.cooldown = atk.intervalTicks;
  const plan = weaponAttack(w, g, atk, target, ctx);
  if (plan) scheduleNormal(w, atk, plan.style, target, plan.repeat);
  weaponAfterAttack(w, g, atk, target, ctx);
  return true;
}

/** 依 id 順序：普通兵，再武將；組成字本身不出手 */
export function updateAttackers(w: World, ctx: StepContext): void {
  for (const a of Object.values(w.actors)) {
    if (a.kind !== 'soldier') continue;
    if (a.cooldown > 0) a.cooldown -= 1;
    if (a.cooldown > 0 || unitDisabled(w, a.id)) continue;
    const atk = soldierAttacker(w, a, ctx);
    if (atk) tryAttack(w, atk, (t) => (a.cooldown = t), ctx);
  }
  for (const g of Object.values(w.generals)) {
    if (g.cooldown > 0) g.cooldown -= 1;
    // 技能施放中暫停普攻
    if (g.cooldown > 0 || g.busyUntil > w.tick) continue;
    const atk = attackerOf(w, { kind: 'general', id: g.id }, ctx);
    if (!atk) continue;
    if (beforeGeneralAttack(w, g, atk, ctx)) {
      g.cooldown = atk.intervalTicks;
      continue;
    }
    if (generalAttack(w, g, atk, ctx)) afterGeneralAttack(w, g, atk, ctx);
  }
}

export type AttackAction = Extract<ScheduledAction, { src: AttackSource }>;

/** 命中：扣血，並觸發武將的命中附加效果（暈眩技能等） */
export function hitEnemy(w: World, e: Enemy, damage: number, src: AttackSource, ctx: StepContext): void {
  if (!w.enemies[e.id]) return;
  if (src.kind === 'general') {
    onGeneralHit(w, src.id, e, ctx);
    const g = w.generals[src.id];
    if (g && w.enemies[e.id]) weaponOnHit(w, g, e, damage, ctx);
    if (!w.enemies[e.id]) return;
  }
  damageEnemy(w, e, damage, src, ctx);
}

/** 處理到期的攻擊類延遲事件 */
export function resolveAttack(w: World, action: AttackAction, ctx: StepContext): void {
  // 出手者已被移走、拆開或拖離地圖：這次攻擊取消
  const atk = attackerOf(w, action.src, ctx);
  if (!atk) return;
  const { at, range, side, src } = atk;
  switch (action.kind) {
    case 'meleeHit': {
      const t = w.enemies[action.targetId];
      if (!t) return;
      ctx.events.push({ type: 'attack', src, kind: 'melee', x: at.x, y: at.y, tx: t.x, ty: t.y });
      hitEnemy(w, t, action.damage, src, ctx);
      return;
    }
    case 'fireArrow': {
      // 發射時目標失效可重選
      let t: Enemy | null | undefined = w.enemies[action.targetId];
      if (!t) t = pickTarget(w, at, enemiesInRange(w, side, at, range), 'closest_end');
      if (!t) return;
      const id = allocId(w);
      w.projectiles[id] = { id, side, src, targetId: t.id, x: at.x, y: at.y, speed: ARROW_SPEED, damage: action.damage };
      return;
    }
    case 'spearThrust': {
      const t = w.enemies[action.targetId];
      if (!t) return;
      const len = Math.hypot(t.x - at.x, t.y - at.y) || 1;
      const dx = (t.x - at.x) / len;
      const dy = (t.y - at.y) / len;
      ctx.events.push({ type: 'attack', src, kind: 'spear', x: at.x, y: at.y, tx: at.x + dx * range, ty: at.y + dy * range });
      for (const e of Object.values(w.enemies)) {
        if (e.side !== side) continue;
        const px = e.x - at.x;
        const py = e.y - at.y;
        const along = px * dx + py * dy;
        if (along >= 0 && along <= range && Math.abs(px * dy - py * dx) <= SPEAR_WIDTH) hitEnemy(w, e, action.damage, src, ctx);
      }
      return;
    }
    case 'cavalrySweep': {
      ctx.events.push({ type: 'attack', src, kind: 'sweep', x: at.x, y: at.y, tx: at.x, ty: at.y, r: range });
      // 半射程與全射程兩道掃掠各造成一半傷害，近處敵人可兩道都吃到
      for (const r of [range / 2, range]) {
        for (const e of enemiesInRange(w, side, at, r)) hitEnemy(w, e, action.damage / 2, src, ctx);
      }
      return;
    }
  }
}

export function updateProjectiles(w: World, ctx: StepContext): void {
  for (const p of Object.values(w.projectiles)) {
    const t = w.enemies[p.targetId];
    if (!t) {
      delete w.projectiles[p.id];
      continue;
    }
    const step = (p.speed * TICK_MS) / 1000;
    const d = Math.hypot(t.x - p.x, t.y - p.y);
    if (d <= step) {
      delete w.projectiles[p.id];
      ctx.events.push({ type: 'attack', src: p.src, kind: 'arrow', x: p.x, y: p.y, tx: t.x, ty: t.y });
      const bx = t.x;
      const by = t.y;
      hitEnemy(w, t, p.damage, p.src, ctx);
      if (p.blast) {
        // 流星落地：範圍傷害依距離衰減並擊退
        ctx.events.push({ type: 'blast', x: bx, y: by, r: p.blast.r });
        for (const e of Object.values(w.enemies)) {
          if (e.side !== p.side) continue;
          const d = Math.hypot(e.x - bx, e.y - by);
          if (d > p.blast.r) continue;
          damageEnemy(w, e, p.blast.damage * (1 - d / p.blast.r), p.src, ctx);
          if (w.enemies[e.id] && p.blast.knock > 0) applyBuff(w, e.id, BUFF.knockback, p.blast.knock, { timeMs: -1 }, ctx);
        }
      }
    } else {
      p.x += ((t.x - p.x) / d) * step;
      p.y += ((t.y - p.y) / d) * step;
    }
  }
}
