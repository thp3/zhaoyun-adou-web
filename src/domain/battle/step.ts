// 單一 tick 的固定更新次序。render 不是邏輯 tick；同一輸入序列必得同一結果。
import { aiWaveBonus, updateAi } from './ai/controller';
import { isBossAction, maybeSpawnBoss, resolveBossAction, updateBosses } from './bosses';
import { expireRoundBuffs, updateBuffs } from './buffs';
import { resolveAttack, updateAttackers, updateProjectiles } from './combat';
import { applyCommand } from './commands';
import { moveEnemies, reviveZombie, spawnEnemy } from './enemies';
import { isSkillAction, resolveSkill, updateSkillEntities } from './skills';
import { resolveWeaponFx, updateWeaponEntities } from './weapons';
import { resolveItemFx, updateItems } from './items';
import { nextFloat, nextInt } from './rng';
import { ticks, type TutorialState, type BattleCommand, type BattleEvent, type BattleResult, type BattleRules, type StepContext, type World } from './types';

export function stepWorld(w: World, commands: readonly BattleCommand[], rules: BattleRules): BattleEvent[] {
  const events: BattleEvent[] = [];
  if (w.result) return events;
  const ctx: StepContext = { ...rules, events };
  w.tick += 1;

  // 1. 到期排程
  while (w.scheduled.length > 0 && w.scheduled[0]!.due <= w.tick) {
    const { action } = w.scheduled.shift()!;
    if (action.kind === 'enterSlot') {
      const a = w.actors[action.actorId];
      if (a && a.loc.c === 'incoming') a.loc = { c: 'slot', i: a.loc.i };
      if (a && a.side === 0 && w.camps[0].slots.every((id) => id === null || w.actors[id]?.loc.c !== 'incoming')) {
        w.camps[0].refreshed = true;
      }
      if (a && a.side === 1) w.camps[1].refreshed = true;
    } else if (isSkillAction(action)) resolveSkill(w, action, ctx);
    else if (action.kind === 'weaponFx') resolveWeaponFx(w, action, ctx);
    else if (action.kind === 'itemFx') resolveItemFx(w, action, ctx);
    else if (isBossAction(action)) resolveBossAction(w, action, ctx, (side, x, y, idx) => reviveZombie(w, side, x, y, idx, ctx));
    else resolveAttack(w, action, ctx);
  }
  // 2. 命令：玩家命令，接著 AI 到決策點時產生命令（同一個驗證入口）
  for (const cmd of commands) applyCommand(w, cmd, ctx);
  updateAi(w, ctx);
  // 3. 教程、波次與出兵
  updateTutorial(w, ctx);
  updateWave(w, ctx);
  // 4. buff 到期與灼燒；Boss 冷卻與施法
  updateBuffs(w, ctx);
  updateItems(w, ctx);
  updateBosses(w, ctx);
  // 5. 敵人移動（含擊退）與抵達阿斗
  moveEnemies(w, ctx);
  // 6. 普通兵與武將出手（含技能接管）
  updateAttackers(w, ctx);
  // 7. 彈體與持續型技能
  updateProjectiles(w, ctx);
  updateSkillEntities(w, ctx);
  updateWeaponEntities(w, ctx);
  // 8. 終局判定（同 tick 先判玩家敗，再判 AI 敗，再判 20 波）
  const result = judge(w);
  if (result) {
    w.result = result;
    events.push({ type: 'ended', result });
  }
  return events;
}

function updateWave(w: World, ctx: StepContext): void {
  const v = ctx.data.waves;
  const s = w.wave;
  s.timer += 1;
  switch (s.phase) {
    case 'ready': {
      // 教程：等部署指引結束才開始出兵（原版初始延遲設為極大值）
      if (w.tutorial) {
        if (w.tutorial.step >= 2) startWave(w, 1, ctx);
        break;
      }
      const bothReady = w.camps[0].refreshed && (w.camps[1].refreshed || !w.aiEnabled);
      if (s.timer >= ticks(v.initialDelayMs) || bothReady) startWave(w, 1, ctx);
      break;
    }
    case 'spawning':
      // 每滿 1500ms 雙方各出一隻；跨門檻歸零、不補發
      if (s.timer >= ticks(v.spawnIntervalMs)) {
        s.timer = 0;
        spawnEnemy(w, 0, ctx, { carries: w.fragmentIndex[0] === s.spawned });
        spawnEnemy(w, 1, ctx, { carries: w.fragmentIndex[1] === s.spawned });
        s.spawned += 1;
        if (s.spawned >= waveCount(w, s.wave, ctx)) {
          s.phase = 'intermission';
          s.timer = 0;
        }
      }
      break;
    case 'intermission':
      if (s.timer >= ticks(v.intermissionMs)) {
        if (s.wave >= v.waveCount && !w.endless) s.phase = 'done';
        else startWave(w, s.wave + 1, ctx);
      }
      break;
    case 'done':
      break;
  }
}

function startWave(w: World, wave: number, ctx: StepContext): void {
  w.wave = { phase: 'spawning', wave, timer: 0, spawned: 0 };
  expireRoundBuffs(w);
  aiWaveBonus(w, wave, ctx.data);
  // 教程（無盡）不出 Boss
  if (!w.endless) maybeSpawnBoss(w, wave, ctx);
  // 本波帶碎片的敵人：雙方各以 6.5% 機率指定一個出兵序號
  const n = waveCount(w, wave, ctx);
  const fd = ctx.data.weapons.fragmentDrop;
  w.fragmentIndex = [0, 1].map(() => (w.weaponUnlocked && nextFloat(w.rng, 'combat') < fd.chancePerEnemy ? nextInt(w.rng, 'combat', n) : -1)) as [number, number];
  ctx.events.push({ type: 'waveStart', wave });
}

/** 每波出兵數；無盡模式超過 20 波每波多 2 隻 */
function waveCount(w: World, wave: number, ctx: StepContext): number {
  const counts = ctx.data.waves.spawnCountByWave;
  if (wave <= counts.length) return counts[wave - 1]!;
  return counts[counts.length - 1]! + ctx.data.waves.endlessExtraPerWave * (wave - counts.length);
}

/** 首局教程進度 */
function updateTutorial(w: World, ctx: StepContext): void {
  const t = w.tutorial;
  if (!t || t.step === 4) return;
  t.timer += 1;
  const next = (step: TutorialState['step']) => {
    t.step = step;
    t.timer = 0;
    ctx.events.push({ type: 'tutorial', step });
  };
  if (t.step === 0 && w.camps[0].refreshed) next(1);
  else if (t.step === 1 && t.timer >= ticks(5000)) next(2);
  else if (t.step === 2 && t.recruits >= 2) next(3);
  else if (t.step === 3 && t.timer >= ticks(8000)) next(4);
}

function judge(w: World): BattleResult | null {
  const base = { tick: w.tick, wave: w.wave.wave };
  if (w.camps[0].lives <= 0) return { ...base, outcome: 'lose', reason: 'player-dead' };
  if (w.aiEnabled && w.camps[1].lives <= 0) return { ...base, outcome: 'win', reason: 'ai-dead' };
  // 第 20 波出滿再等 5 秒即勝，不以清場為條件
  if (w.wave.phase === 'done') return { ...base, outcome: 'win', reason: 'waves-cleared' };
  return null;
}

/** 暫停選單「放棄」：唯一終局請求；已有結果時不覆蓋 */
export function surrender(w: World): BattleResult | null {
  if (w.result) return null;
  w.result = { outcome: 'lose', reason: 'surrender', tick: w.tick, wave: w.wave.wave };
  return w.result;
}
