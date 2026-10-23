// 敵人：血量公式（原版 It.Ty）、出生、沿路移動與擊退、走到阿斗、受傷與死亡獎勵。
import { BUFF, clearBuffs, enemyHalted, enemyMaxHp, hasBuff, inheritGlobals, removeBuffType, setBuffDamageHook, statBonus } from './buffs';
import { allocId, schedule } from './create';
import { nextInt, pickWeighted } from './rng';
import { gainExp } from './generals';
import { weaponOnEnemyDied } from './weapons';
import { TICK_MS, ticks, type AttackSource, type Enemy, type Side, type StepContext, type World } from './types';

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

export interface SpawnOptions {
  kind?: Enemy['kind'];
  hp?: number;
  speed?: number;
  /** 指定位置與路徑索引（殭屍、傀儡）；預設在出生點 */
  at?: { x: number; y: number; pathIdx: number };
  boss?: number;
  carries?: boolean;
}

export function spawnEnemy(w: World, side: Side, ctx: StepContext, opt: SpawnOptions = {}): Enemy {
  const hp = opt.hp ?? enemyHp(w, w.wave.wave, ctx);
  const start = w.paths[side][0]!;
  const e: Enemy = {
    id: allocId(w),
    side,
    hp,
    maxHp: hp,
    speed: opt.speed ?? ctx.data.waves.speedByMap[w.mapId]!,
    x: opt.at?.x ?? start.x,
    y: opt.at?.y ?? start.y,
    pathIdx: opt.at?.pathIdx ?? 1,
    boss: opt.boss !== undefined,
    hitBy: [],
    kind: opt.kind ?? 'mob',
    knockVel: 0,
    scaleBonus: 0,
    bossState: opt.boss === undefined ? null : { bossId: opt.boss, cd: 0, cast: -1, castData: {}, usedOnce: false },
    carries: opt.carries ?? false,
  };
  w.enemies[e.id] = e;
  inheritGlobals(w, e.id, side, 'enemies', ctx);
  return e;
}

/** 剩餘路程：越小越接近阿斗（closest_end 選敵用） */
export function remainingDistance(w: World, e: Enemy): number {
  const path = w.paths[e.side];
  const next = path[e.pathIdx];
  if (!next) return 0;
  return Math.hypot(next.x - e.x, next.y - e.y) + w.remain[e.side][e.pathIdx]!;
}

export function enemySpeed(w: World, e: Enemy): number {
  return Math.max(0, e.speed + statBonus(w, e.id, BUFF.moveSpeed, e.speed));
}

/** 沿路徑往回推（擊退）；不退過第一段 */
function retreat(w: World, e: Enemy, dist: number): void {
  const path = w.paths[e.side];
  while (dist > 0 && e.pathIdx > 1) {
    const back = path[e.pathIdx - 1]!;
    const d = Math.hypot(back.x - e.x, back.y - e.y);
    if (d <= dist) {
      e.x = back.x;
      e.y = back.y;
      e.pathIdx -= 1;
      dist -= d;
    } else {
      e.x += ((back.x - e.x) / d) * dist;
      e.y += ((back.y - e.y) / d) * dist;
      dist = 0;
    }
  }
}

/** 擊退速度每 1/60 秒衰減 0.9（原版每幀 ×0.9），低於門檻即結束擊退 */
const KNOCK_DECAY = 0.9 ** (TICK_MS / (1000 / 60));
const KNOCK_STOP = 6;

export function moveEnemies(w: World, ctx: StepContext): void {
  const dt = TICK_MS / 1000;
  for (const e of Object.values(w.enemies)) {
    // 施法中的 Boss 不前進
    if (e.bossState && e.bossState.cast >= 0) continue;
    if (e.knockVel > 0) {
      // 限制（陷阱）連擊退也擋住
      if (!hasBuff(w, e.id, BUFF.limit)) retreat(w, e, e.knockVel * dt);
      e.knockVel *= KNOCK_DECAY;
      if (e.knockVel < KNOCK_STOP) {
        e.knockVel = 0;
        removeBuffType(w, e.id, BUFF.knockback);
      }
      continue;
    }
    if (enemyHalted(w, e.id)) continue;
    const path = w.paths[e.side];
    let step = enemySpeed(w, e) * dt;
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
  removeEnemy(w, e);
  if (e.side === 1 && !w.aiEnabled) return;
  const camp = w.camps[e.side];
  camp.lives -= 1;
  ctx.events.push({ type: 'adouHit', side: e.side, lives: camp.lives });
}

/** 不經擊殺獎勵直接移除（走到終點、被董卓吞噬） */
export function removeEnemy(w: World, e: Enemy): void {
  delete w.enemies[e.id];
  clearBuffs(w, e.id);
}

export function damageEnemy(w: World, e: Enemy, amount: number, src: AttackSource | null, ctx: StepContext): void {
  if (e.hp <= 0 || !w.enemies[e.id]) return;
  e.hp = Math.max(0, e.hp - amount);
  if (src?.kind === 'general' && !e.hitBy.includes(src.id)) e.hitBy.push(src.id);
  ctx.events.push({ type: 'damage', enemyId: e.id, x: e.x, y: e.y, amount });
  if (e.hp > 0) return;
  // 擊殺獎勵給該敵人所屬的防守方：普通 +1、Boss +10
  const reward = e.boss ? 10 : 1;
  const camp = w.camps[e.side];
  camp.gold += reward;
  camp.kills += 1;
  removeEnemy(w, e);
  if (e.carries && e.side === 0) dropFragment(w, e, ctx);
  creditKill(w, e, src, ctx);
  onEnemyDied(w, e);
  weaponOnEnemyDied(w, e, ctx);
  ctx.events.push({ type: 'enemyDied', enemyId: e.id, side: e.side, x: e.x, y: e.y, reward });
}

setBuffDamageHook((w, id, amount, ctx) => {
  const e = w.enemies[id];
  if (e) damageEnemy(w, e, amount, null, ctx);
});

/**
 * 張寶招魂期間，同側敵人死後 400ms 以當波滿血復活為殭屍（每次施法上限 3 隻，計數在復活時才加，
 * 所以近同時多隻死亡可能超過 3 隻排程，到時再擋）。雲夢澤的 Mob1 不會被招魂。
 */
function onEnemyDied(w: World, e: Enemy): void {
  if (e.boss) {
    onBossDied(w, e);
    return;
  }
  const count = w.soulCall[e.side];
  const mob1 = w.mapId === 1 && e.kind === 'mob';
  if (count >= 0 && count < 3 && !mob1) {
    schedule(w, ticks(400), { kind: 'reviveZombie', side: e.side, x: e.x, y: e.y, pathIdx: e.pathIdx });
  }
}

/** Boss 死亡：撤除只在存活期間有效的全局效果（甄宓的雨） */
function onBossDied(w: World, e: Enemy): void {
  const sign = `rain${e.id}`;
  if (!w.globals.some((g) => g.sign === sign)) return;
  w.globals = w.globals.filter((g) => g.sign !== sign);
  for (const key of Object.keys(w.buffs)) {
    const id = Number(key);
    const left = w.buffs[id]!.filter((b) => b.sign !== sign);
    if (left.length === 0) delete w.buffs[id];
    else w.buffs[id] = left;
  }
}

export function reviveZombie(w: World, side: Side, x: number, y: number, pathIdx: number, ctx: StepContext): void {
  if (w.soulCall[side] < 0 || w.soulCall[side] >= 3) return;
  w.soulCall[side] += 1;
  spawnEnemy(w, side, ctx, { kind: 'zombie', at: { x, y, pathIdx } });
}

/**
 * 碎片掉落（原版 St.su）：依累計局數所在區間的稀有度權重抽稀有度（普通固定 0），再在該稀有度均勻抽武器。
 * 只記玩家防區；結算時一次入帳（重構政策，原版掉落即入帳且勝利會再加一次）。
 */
function dropFragment(w: World, e: Enemy, ctx: StepContext): void {
  if (!w.weaponUnlocked) return;
  const fd = ctx.data.weapons.fragmentDrop;
  let bracket = 0;
  for (let i = fd.roundThresholds.length - 1; i >= 0; i--) {
    if (w.totalRounds > fd.roundThresholds[i]!) {
      bracket = i;
      break;
    }
  }
  const weights = [...fd.rarityWeightsByBracket[bracket]!];
  weights[0] = 0;
  if (weights.every((x) => x <= 0)) return;
  const rarity = pickWeighted(w.rng, 'combat', weights);
  const pool = ctx.data.weapons.weapons.filter((x) => x.rarity === rarity);
  if (pool.length === 0) return;
  const weaponId = pool[nextInt(w.rng, 'combat', pool.length)]!.id;
  w.drops.push(weaponId);
  ctx.events.push({ type: 'drop', weaponId, x: e.x, y: e.y });
}

/** 有效最大血量（含 buff） */
export function maxHpOf(w: World, e: Enemy): number {
  return enemyMaxHp(w, e.id, e.maxHp);
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
