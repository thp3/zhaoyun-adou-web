// 普通兵攻擊。四種兵的出手延遲依原版動畫時序（刀 500ms 命中、弓 650ms 放箭、槍 480ms 刺出、騎 150ms 掃掠），
// 但改由模擬排程決定，不再依動畫回呼。延遲與彈速屬待校正數值。
import { allocId, schedule } from './create';
import { damageEnemy, remainingDistance } from './enemies';
import {
  CELL,
  TICK_MS,
  ticks,
  type Actor,
  type Enemy,
  type Pt,
  type ScheduledAction,
  type StepContext,
  type World,
} from './types';

const ARROW_SPEED = 480; // px/s，待校正
const SPEAR_WIDTH = 30;
const DELAY_MS = { blade: 500, bow: 650, spear: 480, cavalry: 150 } as const;

export function actorCenter(a: Actor): Pt | null {
  if (a.loc.c !== 'board') return null;
  return { x: a.loc.x * CELL + CELL / 2, y: a.loc.y * CELL + CELL / 2 };
}

function soldierStats(a: Actor, ctx: StepContext) {
  const s = ctx.data.units.soldiers.find((x) => x.id === a.token)!;
  const mult = ctx.data.units.soldierLevelMultiplier[a.level - 1] ?? 1;
  return {
    damage: s.damage * mult,
    range: s.rangeCells * CELL,
    intervalTicks: ticks((s.intervalSec * 1000) / mult),
    targetRule: s.targetRule,
  };
}

function enemiesInRange(w: World, side: number, at: Pt, range: number): Enemy[] {
  const out: Enemy[] = [];
  for (const e of Object.values(w.enemies)) {
    if (e.side !== side) continue;
    if (Math.hypot(e.x - at.x, e.y - at.y) <= range) out.push(e);
  }
  return out;
}

function pickTarget(w: World, at: Pt, cands: Enemy[], rule: string): Enemy | null {
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

/** 依 id 順序讓每個在地圖上的普通兵嘗試出手 */
export function updateSoldiers(w: World, ctx: StepContext): void {
  for (const a of Object.values(w.actors)) {
    if (a.kind !== 'soldier') continue;
    if (a.cooldown > 0) a.cooldown -= 1;
    const at = actorCenter(a);
    if (!at || a.cooldown > 0) continue;
    const st = soldierStats(a, ctx);
    const target = pickTarget(w, at, enemiesInRange(w, a.side, at, st.range), st.targetRule);
    if (!target) continue;
    a.cooldown = st.intervalTicks;
    const token = a.token as keyof typeof DELAY_MS;
    const action: ScheduledAction =
      token === 'blade'
        ? { kind: 'meleeHit', actorId: a.id, targetId: target.id, damage: st.damage }
        : token === 'bow'
          ? { kind: 'fireArrow', actorId: a.id, targetId: target.id, damage: st.damage }
          : token === 'spear'
            ? { kind: 'spearThrust', actorId: a.id, targetId: target.id, damage: st.damage }
            : { kind: 'cavalrySweep', actorId: a.id, damage: st.damage };
    schedule(w, ticks(DELAY_MS[token]), action);
  }
}

/** 處理到期的攻擊類延遲事件；回傳 false 表示不是攻擊事件 */
export function resolveAttack(w: World, action: ScheduledAction, ctx: StepContext): boolean {
  if (action.kind === 'enterSlot') return false;
  const a = w.actors[action.actorId];
  const at = a ? actorCenter(a) : null;
  // 出手者已被移走或拖離地圖：這次攻擊取消
  if (!a || !at) return true;
  const range = soldierStats(a, ctx).range;
  switch (action.kind) {
    case 'meleeHit': {
      const t = w.enemies[action.targetId];
      if (!t) return true;
      ctx.events.push({ type: 'attack', actorId: a.id, kind: 'melee', x: at.x, y: at.y, tx: t.x, ty: t.y });
      damageEnemy(w, t, action.damage, ctx);
      return true;
    }
    case 'fireArrow': {
      // 發射時目標失效可重選
      let t: Enemy | null | undefined = w.enemies[action.targetId];
      if (!t) t = pickTarget(w, at, enemiesInRange(w, a.side, at, range), 'closest_end');
      if (!t) return true;
      const id = allocId(w);
      w.projectiles[id] = { id, side: a.side, sourceId: a.id, targetId: t.id, x: at.x, y: at.y, speed: ARROW_SPEED, damage: action.damage };
      return true;
    }
    case 'spearThrust': {
      const t = w.enemies[action.targetId];
      if (!t) return true;
      const len = Math.hypot(t.x - at.x, t.y - at.y) || 1;
      const dx = (t.x - at.x) / len;
      const dy = (t.y - at.y) / len;
      const tx = at.x + dx * range;
      const ty = at.y + dy * range;
      ctx.events.push({ type: 'attack', actorId: a.id, kind: 'spear', x: at.x, y: at.y, tx, ty });
      for (const e of Object.values(w.enemies)) {
        if (e.side !== a.side) continue;
        const px = e.x - at.x;
        const py = e.y - at.y;
        const along = px * dx + py * dy;
        const across = Math.abs(px * dy - py * dx);
        if (along >= 0 && along <= range && across <= SPEAR_WIDTH) damageEnemy(w, e, action.damage, ctx);
      }
      return true;
    }
    case 'cavalrySweep': {
      ctx.events.push({ type: 'attack', actorId: a.id, kind: 'sweep', x: at.x, y: at.y, tx: at.x, ty: at.y, r: range });
      // 半射程與全射程兩道掃掠各造成一半傷害，近處敵人可兩道都吃到
      for (const r of [range / 2, range]) {
        for (const e of enemiesInRange(w, a.side, at, r)) damageEnemy(w, e, action.damage / 2, ctx);
      }
      return true;
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
      ctx.events.push({ type: 'attack', actorId: p.sourceId, kind: 'arrow', x: p.x, y: p.y, tx: t.x, ty: t.y });
      damageEnemy(w, t, p.damage, ctx);
    } else {
      p.x += ((t.x - p.x) / d) * step;
      p.y += ((t.y - p.y) / d) * step;
    }
  }
}
