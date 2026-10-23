// 七種武將具名技能（原版 Je 子類）。計數單位是「普攻次數」，不是秒。
// 接管型（跳斬、大喝、火箭烈、箭雨）：計數到門檻後，下一次出手改放技能；
// 非接管型（聖劍、七進七出）：第門檻次普攻後立即發動，本體繼續普攻；暈眩為常駐命中效果。
// 動畫時序（跳躍、飛行時間）改由排程表達，屬待校正數值。
import { BUFF, applyBuff } from './buffs';
import type { Attacker } from './combat';
import { allocId, schedule } from './create';
import { damageEnemy, maxHpOf } from './enemies';
import { generalCenter } from './generals';
import { nextFloat, nextInt } from './rng';
import { CELL, TICK_MS, ticks, type Enemy, type General, type ScheduledAction, type StepContext, type World } from './types';

const HOP_MS = 350;
const SPLASH_R = 200;
const ROCKET_R = 150;
const PHANTOM_SPEED = 300;
const SWORD_SPEED = 360;

/** 跳斬段數：關羽 5、張翼 1 */
const JUMP_HOPS: Record<string, number> = { guanyu: 5, zhangyi: 1 };
/** 暈眩技能：一般敵人／Boss 的機率與時長；馬超另扣最大血量比例 */
const STUN: Record<string, { p: number; ms: number; bossP: number; bossMs: number; hpRatio: number; bossHpRatio: number }> = {
  machao: { p: 0.3, ms: 500, bossP: 0.1, bossMs: 200, hpRatio: 0.1, bossHpRatio: 0.02 },
  guanxing: { p: 0.1, ms: 300, bossP: 0, bossMs: 0, hpRatio: 0, bossHpRatio: 0 },
  zhangbao: { p: 0.1, ms: 300, bossP: 0, bossMs: 0, hpRatio: 0, bossHpRatio: 0 },
};

function defOf(g: General, ctx: StepContext) {
  return ctx.data.generals.generals[g.type]!;
}

function skillName(id: string, ctx: StepContext): string {
  return ctx.data.generals.skills.find((s) => s.id === id)?.name ?? id;
}

function sideEnemies(w: World, side: number): Enemy[] {
  return Object.values(w.enemies).filter((e) => e.side === side);
}

function rand(w: World): number {
  return nextFloat(w.rng, 'combat');
}

/** 接管型技能：到門檻就在這次出手改放技能；回傳 true 表示這次不普攻 */
export function beforeGeneralAttack(w: World, g: General, atk: Attacker, ctx: StepContext): boolean {
  const def = defOf(g, ctx);
  const sk = def.skill;
  if (!sk || sk.triggerAttacks <= 0 || g.skillCount < sk.triggerAttacks) return false;
  const at = atk.at;
  switch (sk.skill) {
    case 'ta': {
      // 只接受槍／刀／劍
      if (def.weaponType === 0) return false;
      if (!lowestHpEnemy(w, g.side)) return false;
      g.skillCount = 0;
      const hops = JUMP_HOPS[def.key] ?? 1;
      // 關羽持青龍偃月刀：跳斬時對全場敵人各放一道追蹤刀氣
      if (g.weaponId === 29 && def.key === 'guanyu') {
        for (const e of sideEnemies(w, g.side)) {
          const id = allocId(w);
          w.projectiles[id] = { id, side: g.side, src: { kind: 'general', id: g.id }, targetId: e.id, x: at.x, y: at.y, speed: 960, damage: atk.damage };
        }
      }
      g.busyUntil = w.tick + ticks(HOP_MS * (hops + 1));
      schedule(w, ticks(HOP_MS), { kind: 'jumpSlash', generalId: g.id, hopsLeft: hops });
      ctx.events.push({ type: 'skill', side: g.side, name: skillName('ta', ctx), x: at.x, y: at.y });
      return true;
    }
    case 'Ca': {
      g.skillCount = 0;
      g.busyUntil = w.tick + ticks(700);
      schedule(w, ticks(500), { kind: 'warCry', generalId: g.id, stunMs: sk.stunMs ?? 2000 });
      ctx.events.push({ type: 'skill', side: g.side, name: skillName('Ca', ctx), x: at.x, y: at.y });
      return true;
    }
    case 'Na': {
      if (def.weaponType !== 0) return false;
      g.skillCount = 0;
      const n = Math.floor(Math.max(1, (g.level - 1) / 2));
      const points: { x: number; y: number }[] = [];
      for (const p of w.paths[g.side]) {
        const k = (1 + nextInt(w.rng, 'combat', 3)) * n;
        for (let i = 0; i < k; i++) {
          points.push({ x: p.x + (rand(w) * 0.6 - 0.3) * CELL, y: p.y + (rand(w) * 0.6 - 0.3) * CELL });
        }
      }
      for (let i = points.length - 1; i > 0; i--) {
        const j = nextInt(w.rng, 'combat', i + 1);
        [points[i], points[j]] = [points[j]!, points[i]!];
      }
      points.forEach((p, i) => {
        const flight = 500 + rand(w) * 250;
        schedule(w, ticks(i * 25 + flight), { kind: 'rocket', side: g.side, generalId: g.id, x: p.x, y: p.y, damage: 2 * atk.damage });
      });
      g.busyUntil = w.tick + ticks(points.length * 25 + 300);
      ctx.events.push({ type: 'skill', side: g.side, name: skillName('Na', ctx), x: at.x, y: at.y });
      return true;
    }
    case 'qa': {
      if (def.weaponType !== 0) return false;
      g.skillCount = 0;
      g.busyUntil = w.tick + ticks(5 * 300);
      schedule(w, 1, { kind: 'arrowRain', generalId: g.id, roundsLeft: 5 });
      ctx.events.push({ type: 'skill', side: g.side, name: skillName('qa', ctx), x: at.x, y: at.y });
      return true;
    }
  }
  return false;
}

/** 普攻後：技能未進行時計數 +1；非接管型到門檻立即發動 */
export function afterGeneralAttack(w: World, g: General, atk: Attacker, ctx: StepContext): void {
  const sk = defOf(g, ctx).skill;
  if (!sk || sk.triggerAttacks <= 0 || g.busyUntil > w.tick) return;
  g.skillCount += 1;
  if (g.skillCount < sk.triggerAttacks) return;
  if (sk.skill === 'Ha') {
    // 聖劍：朝最近目標射出可穿透多名敵人的劍，傷害 5 倍
    const t = nearestEnemy(w, g.side, atk.at);
    g.skillCount = 0;
    if (!t) return;
    const len = Math.hypot(t.x - atk.at.x, t.y - atk.at.y) || 1;
    const id = allocId(w);
    w.skills[id] = {
      id,
      kind: 'sword',
      side: g.side,
      src: { kind: 'general', id: g.id },
      damage: 5 * atk.damage,
      x: atk.at.x,
      y: atk.at.y,
      dx: (t.x - atk.at.x) / len,
      dy: (t.y - atk.at.y) / len,
      left: 1200,
      hit: [],
    };
    ctx.events.push({ type: 'skill', side: g.side, name: skillName('Ha', ctx), x: atk.at.x, y: atk.at.y });
  } else if (sk.skill === 'hn') {
    // 七進七出：幻象跳到最接近終點的敵人，沿路來回 7 趟；本體繼續普攻
    const target = furthestEnemy(w, g.side);
    if (!target) return;
    g.skillCount = 0;
    const id = allocId(w);
    w.skills[id] = {
      id,
      kind: 'phantom',
      side: g.side,
      generalId: g.id,
      damage: atk.damage,
      x: target.x,
      y: target.y,
      pathIdx: Math.max(0, target.pathIdx - 1),
      goal: 0,
      trips: 0,
      clearIn: ticks(100),
      hit: [],
    };
    ctx.events.push({ type: 'skill', side: g.side, name: skillName('hn', ctx), x: atk.at.x, y: atk.at.y });
  }
}

/** 武將命中時的常駐效果（暈眩技能），每次命中各擲一次 */
export function onGeneralHit(w: World, generalId: number, e: Enemy, ctx: StepContext): void {
  const g = w.generals[generalId];
  if (!g) return;
  const def = defOf(g, ctx);
  if (def.skill?.skill !== 'Oa') return;
  const s = STUN[def.key];
  if (!s) return;
  const p = e.boss ? s.bossP : s.p;
  const ms = e.boss ? s.bossMs : s.ms;
  if (p <= 0 || rand(w) > p) return;
  applyBuff(w, e.id, BUFF.stun, 1, { timeMs: ms }, ctx);
  const ratio = e.boss ? s.bossHpRatio : s.hpRatio;
  if (ratio > 0) damageEnemy(w, e, maxHpOf(w, e) * ratio, { kind: 'general', id: g.id }, ctx);
}

function lowestHpEnemy(w: World, side: number): Enemy | null {
  let best: Enemy | null = null;
  for (const e of sideEnemies(w, side)) if (!best || e.hp < best.hp) best = e;
  return best;
}

function nearestEnemy(w: World, side: number, at: { x: number; y: number }): Enemy | null {
  let best: Enemy | null = null;
  let d = Infinity;
  for (const e of sideEnemies(w, side)) {
    const dd = Math.hypot(e.x - at.x, e.y - at.y);
    if (dd < d) {
      best = e;
      d = dd;
    }
  }
  return best;
}

function furthestEnemy(w: World, side: number): Enemy | null {
  let best: Enemy | null = null;
  for (const e of sideEnemies(w, side)) if (!best || e.pathIdx > best.pathIdx) best = e;
  return best;
}

/** 範圍傷害：依距離線性衰減，可附擊退 */
function blast(w: World, side: number, x: number, y: number, r: number, damage: number, knock: number, generalId: number, ctx: StepContext): void {
  ctx.events.push({ type: 'blast', x, y, r });
  for (const e of sideEnemies(w, side)) {
    const d = Math.hypot(e.x - x, e.y - y);
    if (d > r) continue;
    damageEnemy(w, e, damage * (1 - d / r), { kind: 'general', id: generalId }, ctx);
    if (knock > 0 && w.enemies[e.id]) applyBuff(w, e.id, BUFF.knockback, knock, { timeMs: -1 }, ctx);
  }
}

type SkillAction = Extract<ScheduledAction, { kind: 'jumpSlash' | 'warCry' | 'rocket' | 'arrowRain' }>;

export function isSkillAction(a: ScheduledAction): a is SkillAction {
  return a.kind === 'jumpSlash' || a.kind === 'warCry' || a.kind === 'rocket' || a.kind === 'arrowRain';
}

export function resolveSkill(w: World, a: SkillAction, ctx: StepContext): void {
  if (a.kind === 'rocket') {
    blast(w, a.side, a.x, a.y, ROCKET_R, a.damage, 1, a.generalId, ctx);
    return;
  }
  const g = w.generals[a.generalId];
  const at = g ? generalCenter(w, g) : null;
  if (!g || !at) return;
  const dmg = (() => {
    const def = defOf(g, ctx);
    const mult = g.side === 1 ? w.aiDamageMultiplier : 1;
    return def.damage * ctx.data.generals.levelDamageMultiplier[g.level - 1]! * mult;
  })();
  switch (a.kind) {
    case 'jumpSlash': {
      const t = lowestHpEnemy(w, g.side);
      if (!t) {
        g.busyUntil = w.tick;
        return;
      }
      const tx = t.x;
      const ty = t.y;
      damageEnemy(w, t, dmg, { kind: 'general', id: g.id }, ctx);
      blast(w, g.side, tx, ty, SPLASH_R, dmg / 2, 1, g.id, ctx);
      if (a.hopsLeft > 1) schedule(w, ticks(HOP_MS), { kind: 'jumpSlash', generalId: g.id, hopsLeft: a.hopsLeft - 1 });
      else g.busyUntil = w.tick + ticks(200);
      return;
    }
    case 'warCry': {
      const r = defOf(g, ctx).rangeCells * CELL;
      ctx.events.push({ type: 'blast', x: at.x, y: at.y, r });
      for (const e of sideEnemies(w, g.side)) if (Math.hypot(e.x - at.x, e.y - at.y) <= r) applyBuff(w, e.id, BUFF.stun, 1, { timeMs: a.stunMs }, ctx);
      return;
    }
    case 'arrowRain': {
      const r = defOf(g, ctx).rangeCells * CELL;
      const targets = sideEnemies(w, g.side).filter((e) => Math.hypot(e.x - at.x, e.y - at.y) <= r);
      if (targets.length > 0) {
        for (let i = 0; i < 10; i++) {
          const t = 10 > targets.length ? targets[i % targets.length]! : targets[nextInt(w.rng, 'combat', targets.length)]!;
          const id = allocId(w);
          w.projectiles[id] = { id, side: g.side, src: { kind: 'general', id: g.id }, targetId: t.id, x: at.x, y: at.y, speed: 400, damage: dmg };
        }
      }
      if (a.roundsLeft > 1) schedule(w, ticks(300), { kind: 'arrowRain', generalId: g.id, roundsLeft: a.roundsLeft - 1 });
      return;
    }
  }
}

/** 每 tick 更新持續型技能實體：聖劍穿透飛行、七進七出幻象 */
export function updateSkillEntities(w: World, ctx: StepContext): void {
  const dt = TICK_MS / 1000;
  for (const s of Object.values(w.skills)) {
    if (s.kind === 'sword') {
      const step = SWORD_SPEED * dt;
      s.x += s.dx * step;
      s.y += s.dy * step;
      s.left -= step;
      for (const e of sideEnemies(w, s.side)) {
        if (s.hit.includes(e.id) || Math.hypot(e.x - s.x, e.y - s.y) > 40) continue;
        s.hit.push(e.id);
        // 聖劍命中給擊倒 2 秒（敵人沒有對應的停止效果，Boss 機率 0）
        if (!e.boss) applyBuff(w, e.id, BUFF.knockdown, 1, { timeMs: 2000 }, ctx);
        damageEnemy(w, e, s.damage, s.src, ctx);
      }
      if (s.left <= 0 || s.x < -80 || s.y < -80 || s.x > 720 || s.y > 880) delete w.skills[s.id];
      continue;
    }
    if (s.kind !== 'phantom') continue;
    // 幻象
    if (!w.generals[s.generalId]) {
      delete w.skills[s.id];
      continue;
    }
    const path = w.paths[s.side];
    let step = PHANTOM_SPEED * dt;
    for (let guard = 0; step > 0 && guard < 50; guard++) {
      const t = path[s.pathIdx]!;
      const d = Math.hypot(t.x - s.x, t.y - s.y);
      if (d > step) {
        s.x += ((t.x - s.x) / d) * step;
        s.y += ((t.y - s.y) / d) * step;
        break;
      }
      s.x = t.x;
      s.y = t.y;
      step -= d;
      if (s.pathIdx === s.goal) {
        if (s.goal === 0) {
          // 回到起點後改往目前最接近終點的敵人
          const f = furthestEnemy(w, s.side);
          s.goal = f ? Math.max(1, f.pathIdx - 1) : path.length - 1;
        } else {
          s.trips += 1;
          s.goal = 0;
        }
        if (s.trips >= 7) break;
      }
      s.pathIdx += s.goal > s.pathIdx ? 1 : s.goal < s.pathIdx ? -1 : 0;
      if (s.goal === s.pathIdx && step <= 0) break;
    }
    if (s.trips >= 7) {
      delete w.skills[s.id];
      continue;
    }
    s.clearIn -= 1;
    if (s.clearIn <= 0) {
      s.hit = [];
      s.clearIn = ticks(100);
    }
    for (const e of sideEnemies(w, s.side)) {
      if (s.hit.includes(e.id) || Math.abs(e.x - s.x) > CELL / 2 || Math.abs(e.y - s.y) > CELL / 2) continue;
      s.hit.push(e.id);
      damageEnemy(w, e, s.damage, { kind: 'general', id: s.generalId }, ctx);
    }
  }
}
