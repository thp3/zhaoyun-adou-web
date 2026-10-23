// Boss 排程與 12 種技能（原版 Se.nT/rT、ie 與各 Boss 子類）。
// 第 3/6/9/12/15/18 波判定，機率 10/20/30/50/90/100%；成功時雙方出同一位 Boss，地圖三人依序輪換。
// 冷卻只在非施法時累積；受控時照樣累積但不施法，解除後可立刻放。施法期間 Boss 不前進。
// 各技能的動畫時長改用固定時間軸表示，屬待校正數值。
import { BUFF, addGlobal, applyBuff, enemyHalted, hasBuff } from './buffs';
import { removeActor } from './commands';
import { exorcismBlocks } from './items';
import { schedule } from './create';
import { enemyHp, removeEnemy, spawnEnemy } from './enemies';
import { nextFloat, nextInt } from './rng';
import { CELL, TICK_MS, ticks, type Actor, type Enemy, type ScheduledAction, type Side, type StepContext, type World } from './types';

const CAST_MS = [1500, 1500, 1000, 1500, 1200, 1500, 1800, 1200, 1500, 1200, 1000, 1000];

/** 波次開始時呼叫：判定是否出 Boss */
export function maybeSpawnBoss(w: World, wave: number, ctx: StepContext): void {
  const v = ctx.data.waves;
  const i = v.bossWaves.indexOf(wave);
  if (i < 0) return;
  if (nextFloat(w.rng, 'combat') >= v.bossChance[i]!) return;
  const bossId = w.mapId * 3 + w.bossRotation;
  w.bossRotation = (w.bossRotation + 1) % 3;
  const def = v.bosses[bossId]!;
  const hp = enemyHp(w, wave, ctx) * def.hpMultiplier;
  for (const side of [0, 1] as const) {
    spawnEnemy(w, side, ctx, { hp, speed: def.speed, boss: bossId });
    ctx.events.push({ type: 'bossSpawn', side, bossId });
  }
}

export function updateBosses(w: World, ctx: StepContext): void {
  for (const e of Object.values(w.enemies)) {
    const bs = e.bossState;
    if (!bs) continue;
    if (bs.cast >= 0) {
      bs.cast += 1;
      runCast(w, e, ctx);
      if (bs.cast * TICK_MS >= CAST_MS[bs.bossId]!) finishCast(w, e, ctx);
      continue;
    }
    bs.cd += 1;
    const cdTicks = ticks(ctx.data.waves.bosses[bs.bossId]!.cooldownSec * 1000);
    if (bs.cd < cdTicks || enemyHalted(w, e.id)) continue;
    bs.cd = 0;
    // 甄宓每隻只真正施法一次
    if (bs.bossId === 4 && bs.usedOnce) continue;
    // 降妖符：自己防區的 Boss 施法 50% 失敗並反噬
    if (exorcismBlocks(w, e, ctx)) continue;
    bs.cast = 0;
    bs.castData = {};
    startCast(w, e, ctx);
    ctx.events.push({ type: 'bossCast', side: e.side, bossId: bs.bossId, x: e.x, y: e.y });
  }
}

// ---------- 共用選取 ----------

function circleHitsCell(cx: number, cy: number, r: number, x: number, y: number): boolean {
  const nx = Math.max(x * CELL, Math.min(cx, x * CELL + CELL));
  const ny = Math.max(y * CELL, Math.min(cy, y * CELL + CELL));
  return (cx - nx) ** 2 + (cy - ny) ** 2 <= r * r;
}

/** 該側地圖上的普通兵（Boss 技能只查普通兵，不含武將與名字字） */
function soldiersOf(w: World, side: Side): (Actor & { loc: { c: 'board'; x: number; y: number } })[] {
  return Object.values(w.actors).filter(
    (a): a is Actor & { loc: { c: 'board'; x: number; y: number } } => a.side === side && a.kind === 'soldier' && a.loc.c === 'board',
  );
}

function soldiersInCircle(w: World, side: Side, cx: number, cy: number, r: number) {
  return soldiersOf(w, side).filter((a) => circleHitsCell(cx, cy, r, a.loc.x, a.loc.y));
}

// ---------- 施法時間軸 ----------

function at(e: Enemy, ms: number): boolean {
  return e.bossState!.cast === ticks(ms);
}

function startCast(w: World, e: Enemy, ctx: StepContext): void {
  const bs = e.bossState!;
  switch (bs.bossId) {
    case 1: // 張寶 招魂：施法期間同側敵人死亡可復活
      w.soulCall[e.side] = 0;
      break;
    case 5: {
      // 貂蟬 裙下之臣：該側全部並列最低級普通兵，先魅惑，再變成傀儡
      const list = soldiersOf(w, e.side);
      if (list.length === 0) break;
      const min = Math.min(...list.map((a) => a.level));
      const chosen = list.filter((a) => a.level === min);
      const delay = 1000 / chosen.length;
      for (const a of chosen) {
        applyBuff(w, a.id, BUFF.charm, 1, { timeMs: -1 }, ctx);
        schedule(w, ticks(delay), { kind: 'puppet', side: e.side, actorId: a.id, bossId: e.id });
      }
      break;
    }
    case 7: // 呂布：施法當刻快照 200px 內的普通兵
      bs.castData.targets = soldiersInCircle(w, e.side, e.x, e.y, 200).map((a) => a.id);
      break;
    case 9: {
      // 典韋：160px 內未被擊倒的普通兵隨機一名
      const c = soldiersInCircle(w, e.side, e.x, e.y, 160).filter((a) => !hasBuff(w, a.id, BUFF.knockdown));
      if (c.length > 0) bs.castData.target = c[nextInt(w.rng, 'combat', c.length)]!.id;
      break;
    }
  }
}

function runCast(w: World, e: Enemy, ctx: StepContext): void {
  const bs = e.bossState!;
  const t = bs.cast * TICK_MS;
  switch (bs.bossId) {
    case 0: {
      // 張梁 攝魂：500–1400ms 間每 100ms 以擴張半徑（約 0.18px/ms）混亂普通兵，每隻一次
      if (t <= 500 || t >= 1400 || bs.cast % ticks(100) !== 0) break;
      const hit = (bs.castData.hit as number[] | undefined) ?? [];
      for (const a of soldiersInCircle(w, e.side, e.x, e.y, 0.18 * t)) {
        if (hit.includes(a.id)) continue;
        hit.push(a.id);
        applyBuff(w, a.id, BUFF.chaos, 1, { timeMs: 2000 }, ctx);
      }
      bs.castData.hit = hit;
      break;
    }
    case 2:
      // 張角 鼓舞：160px 內同側敵人（含自己）體型 +20%、最大血量 +50%、移速 +30%，5 秒
      if (!at(e, 500)) break;
      for (const o of Object.values(w.enemies)) {
        if (o.side !== e.side || Math.hypot(o.x - e.x, o.y - e.y) > 160) continue;
        applyBuff(w, o.id, BUFF.scale, 0.2, { percent: true, timeMs: 5000 }, ctx);
        applyBuff(w, o.id, BUFF.maxHp, 0.5, { percent: true, timeMs: 5000 }, ctx);
        applyBuff(w, o.id, BUFF.moveSpeed, 0.3, { percent: true, timeMs: 5000 }, ctx);
      }
      break;
    case 3: {
      // 孫尚香 拆遷：隨機一格沒有單位的己方可部署地，動畫後變成待開墾地
      if (!at(e, 500)) break;
      const cells: { x: number; y: number }[] = [];
      for (let x = 0; x < w.kind.length; x++) {
        for (let y = 0; y < w.kind[x]!.length; y++) {
          if (w.kind[x]![y] === 1 && w.camp[x]![y] === e.side && w.board[x]![y] == null) cells.push({ x, y });
        }
      }
      if (cells.length > 0) {
        const c = cells[nextInt(w.rng, 'combat', cells.length)]!;
        schedule(w, ticks(1000), { kind: 'demolish', side: e.side, x: c.x, y: c.y });
      }
      break;
    }
    case 6:
      // 華雄 鐵騎號令：三次各召一隻鐵騎從出生點進場（速度 80、當波血量）
      if (at(e, 600) || at(e, 1200) || at(e, 1800)) spawnEnemy(w, e.side, ctx, { kind: 'cavalry', speed: 80 });
      break;
    case 7:
      // 呂布 方天畫戟：650ms 後對快照目標壓制 5 秒
      if (!at(e, 650)) break;
      for (const id of (bs.castData.targets as number[] | undefined) ?? []) applyBuff(w, id, BUFF.suppression, 1, { timeMs: 5000 }, ctx);
      break;
    case 8: {
      // 董卓 饕餮：吞掉 120px 內同側敵人（不給獎勵），之後膨脹並加血
      if (!at(e, 500)) break;
      let n = 0;
      for (const o of Object.values(w.enemies)) {
        if (o.id === e.id || o.side !== e.side || Math.hypot(o.x - e.x, o.y - e.y) > 120) continue;
        removeEnemy(w, o);
        n += 1;
      }
      bs.castData.eaten = n;
      break;
    }
    case 9:
      // 典韋 徹底瘋狂：跳入落地後永久擊倒目標（升級才解除）
      if (at(e, 800) && typeof bs.castData.target === 'number') applyBuff(w, bs.castData.target, BUFF.knockdown, 1, { timeMs: -1 }, ctx);
      break;
    case 10:
      // 夏侯惇 噬目：1 秒後該側視野變暗 5 秒（純視覺）
      if (at(e, 1000)) w.blindUntil[e.side] = w.tick + ticks(5000);
      break;
  }
}

/** 施法結束：收尾才生效的效果（招魂關閉、董卓膨脹、甄宓下雨、曹操鎖鏈） */
function finishCast(w: World, e: Enemy, ctx: StepContext): void {
  const bs = e.bossState!;
  switch (bs.bossId) {
    case 1:
      w.soulCall[e.side] = -1;
      break;
    case 4:
      // 甄宓 巫山雲雨：該側所有普通兵與武將攻速 -20%，現有與之後新建都套用；Boss 死亡時撤除
      if (!bs.usedOnce) {
        bs.usedOnce = true;
        addGlobal(w, { sign: `rain${e.id}`, side: e.side, target: 'units', type: BUFF.attSpeed, num: -0.2, percent: true, timeMs: -1 }, ctx);
      }
      break;
    case 8: {
      const n = (bs.castData.eaten as number | undefined) ?? 0;
      if (n > 0) {
        e.scaleBonus += 0.01 * n;
        const add = 2 * enemyHp(w, w.wave.wave, ctx) * n;
        e.hp += add;
        e.maxHp += add;
      }
      break;
    }
    case 11: {
      // 曹操 一代梟雄：最高等級、未被鎖的普通兵；未滿級永久鎖，滿級鎖 10 秒
      let best: Actor | null = null;
      for (const a of soldiersOf(w, e.side)) if (!hasBuff(w, a.id, BUFF.lock) && (!best || a.level > best.level)) best = a;
      if (best) applyBuff(w, best.id, BUFF.lock, 1, { timeMs: best.level < 5 ? -1 : 10000 }, ctx);
      break;
    }
  }
  bs.cast = -1;
  bs.castData = {};
}

type BossAction = Extract<ScheduledAction, { kind: 'reviveZombie' | 'puppet' | 'demolish' }>;

export function isBossAction(a: ScheduledAction): a is BossAction {
  return a.kind === 'reviveZombie' || a.kind === 'puppet' || a.kind === 'demolish';
}

export function resolveBossAction(w: World, a: BossAction, ctx: StepContext, revive: (side: Side, x: number, y: number, idx: number) => void): void {
  if (a.kind === 'reviveZombie') return revive(a.side, a.x, a.y, a.pathIdx);
  if (a.kind === 'demolish') {
    if (w.kind[a.x]![a.y] === 1) {
      w.kind[a.x]![a.y] = 2;
      ctx.events.push({ type: 'expanded', x: a.x, y: a.y });
    }
    return;
  }
  // 貂蟬：Boss 仍在且士兵仍在，才把士兵變成傀儡
  const boss = w.enemies[a.bossId];
  const actor = w.actors[a.actorId];
  if (!boss || !actor || actor.loc.c !== 'board') return;
  const { x, y } = actor.loc;
  const level = actor.level;
  removeActor(w, actor);
  const path = w.paths[a.side];
  const idx = Math.min(path.length - 1, Math.max(1, boss.pathIdx + nextInt(w.rng, 'combat', 3) - 1));
  const hp = enemyHp(w, w.wave.wave, ctx) * (ctx.data.waves.puppetLevelHpMultiplier[level - 1] ?? 1);
  spawnEnemy(w, a.side, ctx, { kind: 'puppet', hp, speed: 10, at: { x: x * CELL + CELL / 2, y: y * CELL + CELL / 2, pathIdx: idx } });
}
