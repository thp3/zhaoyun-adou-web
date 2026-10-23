// 普通敵人：血量公式（原版 It.Ty）、出生、沿路移動、走到阿斗。
import { allocId } from './create';
import { gainExp } from './generals';
import { TICK_MS, type AttackSource, type Enemy, type Side, type StepContext, type World } from './types';

/** 普通敵人血量 */
export function enemyHp(w: World, wave: number, ctx: StepContext): number {
  const v = ctx.data.waves;
  const wv = Math.max(1, wave);
  if (wv > v.waveCount) return v.endlessHp.base * v.endlessHp.growth ** (wv - 1);
  const idx = wv - 1;
  let hp = v.baseHpByMap[w.mapId]![idx]! * v.hpStrategies[w.hpStrategy]![idx]!;
  // 新手係數：依累計局數索引，不是依波序
  if (w.totalRounds < v.rookieHpByRound.length && wv <= 10) hp *= v.rookieHpByRound[w.totalRounds]!;
  if (wv > 10) hp *= 1 + w.addHp;
  return hp;
}

export function spawnEnemy(w: World, side: Side, ctx: StepContext): Enemy {
  const hp = enemyHp(w, w.wave.wave, ctx);
  const start = w.paths[side][0]!;
  const e: Enemy = {
    id: allocId(w),
    side,
    hp,
    maxHp: hp,
    speed: ctx.data.waves.speedByMap[w.mapId]!,
    x: start.x,
    y: start.y,
    pathIdx: 1,
    boss: false,
    hitBy: [],
  };
  w.enemies[e.id] = e;
  return e;
}

/** 剩餘路程：越小越接近阿斗（closest_end 選敵用） */
export function remainingDistance(w: World, e: Enemy): number {
  const path = w.paths[e.side];
  const next = path[e.pathIdx];
  if (!next) return 0;
  return Math.hypot(next.x - e.x, next.y - e.y) + w.remain[e.side][e.pathIdx]!;
}

export function moveEnemies(w: World, ctx: StepContext): void {
  for (const e of Object.values(w.enemies)) {
    const path = w.paths[e.side];
    let step = (e.speed * TICK_MS) / 1000;
    while (step > 0 && e.pathIdx < path.length) {
      const t = path[e.pathIdx]!;
      const d = Math.hypot(t.x - e.x, t.y - e.y);
      if (d <= step) {
        e.x = t.x;
        e.y = t.y;
        e.pathIdx += 1;
        step -= d;
      } else {
        e.x += ((t.x - e.x) / d) * step;
        e.y += ((t.y - e.y) / d) * step;
        step = 0;
      }
    }
    if (e.pathIdx >= path.length) reachAdou(w, e, ctx);
  }
}

/** 走到終點：扣該方阿斗 1 命並回收；不給擊殺資金。AI 未啟用時 AI 阿斗不扣命（原版 dh=false）。 */
function reachAdou(w: World, e: Enemy, ctx: StepContext): void {
  delete w.enemies[e.id];
  if (e.side === 1 && !w.aiEnabled) return;
  const camp = w.camps[e.side];
  camp.lives -= 1;
  ctx.events.push({ type: 'adouHit', side: e.side, lives: camp.lives });
}

export function damageEnemy(w: World, e: Enemy, amount: number, src: AttackSource | null, ctx: StepContext): void {
  if (e.hp <= 0) return;
  e.hp = Math.max(0, e.hp - amount);
  if (src?.kind === 'general' && !e.hitBy.includes(src.id)) e.hitBy.push(src.id);
  ctx.events.push({ type: 'damage', enemyId: e.id, x: e.x, y: e.y, amount });
  if (e.hp > 0) return;
  // 擊殺獎勵給該敵人所屬的防守方：普通 +1、Boss +10
  const reward = e.boss ? 10 : 1;
  const camp = w.camps[e.side];
  camp.gold += reward;
  camp.kills += 1;
  delete w.enemies[e.id];
  creditKill(w, e, src, ctx);
  ctx.events.push({ type: 'enemyDied', enemyId: e.id, side: e.side, x: e.x, y: e.y, reward });
}

/**
 * 擊殺經驗（原版 Kh.JB）：武將擊殺者 +1；其餘參與過的武將合分 0.5（武將擊殺）或 0.2（非武將擊殺），平均分攤。
 */
function creditKill(w: World, e: Enemy, src: AttackSource | null, ctx: StepContext): void {
  const credit = ctx.data.generals.killCredit;
  const killer = src?.kind === 'general' ? w.generals[src.id] : undefined;
  if (killer) gainExp(w, killer, credit.killerExp, ctx);
  const assists = e.hitBy.filter((id) => id !== killer?.id && w.generals[id]);
  if (assists.length === 0) return;
  const share = (killer ? credit.assistPoolByGeneral : credit.assistPoolByOther) / assists.length;
  for (const id of assists) gainExp(w, w.generals[id]!, share, ctx);
}
