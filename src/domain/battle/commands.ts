// 玩家與 AI 共用的命令入口：validate → apply。命令只表達「想做什麼」，結果由規則決定。
import type { GameData } from '../../data';
import { clearBuffs, inheritGlobals, onUnitLevelUp, unitPinned, unitSuppressed } from './buffs';
import { allocId, schedule } from './create';
import { expandCell, onFarmerPlaced, onNameDrawn, promotionChance, useItem } from './items';
import { dissolveGeneralOf, feedAmount, feedTarget, gainExp, generalMaxLevel, tryFormGeneral } from './generals';
import { nextFloat, nextInt } from './rng';
import {
  ticks,
  type Actor,
  type ActorKind,
  type BattleCommand,
  type BoardLoc,
  type Loc,
  type Side,
  type SlotLoc,
  type StepContext,
  type World,
} from './types';

export type CommandResult = { ok: true } | { ok: false; reason: string };
const ok = { ok: true } as const;
const no = (reason: string): CommandResult => ({ ok: false, reason });

const SOLDIER_TOKENS = new Set(['blade', 'bow', 'spear', 'cavalry']);
/** 與 data/units.json soldierMaxLevel 相同（schema 固定為 5） */
const SOLDIER_MAX_LEVEL = 5;
const kindOfToken = (token: string): ActorKind =>
  SOLDIER_TOKENS.has(token) ? 'soldier' : token === 'shovel' ? 'shovel' : token === 'farmer' ? 'farmer' : 'name';

/** 抽一張：均勻選條目；兵／鏟／農不移除，名字字移除；牌庫空回退刀。 */
export function drawToken(w: World, side: Side, ctx: StepContext): string {
  const deck = w.camps[side].deck;
  if (deck.length === 0) return ctx.data.deck.emptyFallback;
  const i = nextInt(w.rng, 'deck', deck.length);
  const token = deck[i]!;
  if (!ctx.data.deck.nonConsumable.includes(token)) {
    deck.splice(i, 1);
    onNameDrawn(w, side, token);
  }
  return token;
}

export function applyCommand(w: World, cmd: BattleCommand, ctx: StepContext): CommandResult {
  if (w.result) return no('對局已結束');
  const res =
    cmd.type === 'RECRUIT'
      ? recruit(w, cmd.side, ctx)
      : cmd.type === 'USE_ITEM'
        ? useItem(w, cmd.side, cmd.slot, cmd.to, ctx)
        : move(w, cmd.side, cmd.actorId, cmd.to, ctx);
  if (!res.ok) ctx.events.push({ type: 'rejected', side: cmd.side, reason: res.reason });
  return res;
}

// ---------- 征兵 ----------

function recruit(w: World, side: Side, ctx: StepContext): CommandResult {
  const camp = w.camps[side];
  const rules = ctx.data.deck.recruit;
  if (w.tick - camp.lastRecruitTick < ticks(rules.refreshLockMs)) return no('征兵太頻繁');
  if (camp.gold < camp.recruitCost) return no(`資金不足（需要 ${camp.recruitCost}）`);
  camp.gold -= camp.recruitCost;
  camp.recruitCost += rules.costIncrement;
  camp.lastRecruitTick = w.tick;
  // 清掉舊刷新欄（含飛行中的）
  camp.slots.forEach((id, i) => {
    if (id !== null) delete w.actors[id];
    camp.slots[i] = null;
  });
  const drawn = side === 0 && w.tutorial && w.tutorial.recruits < 2 ? tutorialDraw(w, ctx) : Array.from({ length: rules.slots }, () => drawToken(w, side, ctx));
  // AI 難度 ≥2：鏟子排到前面（原版 Ln.aG）
  if (side === 1 && w.difficulty >= 2) drawn.sort((a, b) => Number(b === 'shovel') - Number(a === 'shovel'));
  for (let i = 0; i < rules.slots; i++) {
    const token = drawn[i]!;
    const id = allocId(w);
    const kind = kindOfToken(token);
    // 升職令：刷新欄新建的 1 級普通兵有機率直接 2 級
    const level = kind === 'soldier' && nextFloat(w.rng, 'combat') < promotionChance(w, side, ctx.data) ? 2 : 1;
    const actor: Actor = { id, side, token, kind, level, loc: { c: 'incoming', i }, cooldown: 0, generalId: null, exp: 0 };
    w.actors[id] = actor;
    camp.slots[i] = id;
    if (actor.kind === 'soldier') inheritGlobals(w, id, side, 'units', ctx);
    // 玩家：每張錯開 100ms、飛行 500ms 後落位；AI 直接到位
    const delay = side === 0 ? rules.playerFlyMs + rules.playerStaggerMs * i : 0;
    schedule(w, ticks(delay), { kind: 'enterSlot', actorId: id });
  }
  ctx.events.push({ type: 'recruited', side });
  return ok;
}

/**
 * 首局教程的征兵（原版 Cn）：第一次隨機但避開黃／忠（最多重抽 30 次，仍命中回退刀）；
 * 第二次依欄位固定為 刀／弓／黃／忠／鏟（不從牌庫扣）。
 */
function tutorialDraw(w: World, ctx: StepContext): string[] {
  const t = w.tutorial!;
  const tut = ctx.data.deck.tutorial;
  t.recruits += 1;
  if (t.recruits === 2) return [...tut.secondRefreshFixed];
  return Array.from({ length: ctx.data.deck.recruit.slots }, () => {
    for (let i = 0; i < tut.firstRefreshMaxRetry; i++) {
      const token = drawToken(w, 0, ctx);
      if (!tut.firstRefreshAvoid.includes(token)) return token;
    }
    return tut.firstRefreshFallback;
  });
}

// ---------- 移動／交換／合成／開墾 ----------

function cellOk(w: World, a: Actor, to: BoardLoc): string | null {
  if (to.x < 0 || to.y < 0 || to.x >= w.kind.length || to.y >= w.kind[0]!.length) return '超出地圖';
  if (w.camp[to.x]![to.y] !== a.side) return '只能放在己方陣地';
  const k = w.kind[to.x]![to.y];
  if (a.kind === 'shovel') return k === 2 ? null : '鏟子只能用在待開墾地';
  // 農民可放己方已開墾或待開墾地
  if (a.kind === 'farmer') return k === 1 || k === 2 ? null : '道路上不能部署';
  if (k === 2) return '這塊地還沒開墾';
  if (k !== 1) return '道路上不能部署';
  return null;
}

/** 某 actor 放到某位置是否合法（不考慮該位置上現有的 actor） */
function placeOk(w: World, a: Actor, to: Loc): string | null {
  if (to.c === 'incoming') return '援軍正在趕來';
  if (to.c === 'slot') return to.i >= 0 && to.i < w.camps[a.side].slots.length ? null : '無法放在這裡';
  return cellOk(w, a, to);
}

function occupant(w: World, side: Side, to: BoardLoc | SlotLoc): number | null {
  return to.c === 'board' ? (w.board[to.x]?.[to.y] ?? null) : (w.camps[side].slots[to.i] ?? null);
}

function setLoc(w: World, a: Actor, to: Loc): void {
  if (to.c === 'board') w.board[to.x]![to.y] = a.id;
  else if (to.c === 'slot') w.camps[a.side].slots[to.i] = a.id;
  a.loc = to;
}

function clearLoc(w: World, a: Actor): void {
  const l = a.loc;
  if (l.c === 'board' && w.board[l.x]![l.y] === a.id) w.board[l.x]![l.y] = null;
  else if ((l.c === 'slot' || l.c === 'incoming') && w.camps[a.side].slots[l.i] === a.id) w.camps[a.side].slots[l.i] = null;
}

export function removeActor(w: World, a: Actor): void {
  dissolveGeneralOf(w, a);
  clearBuffs(w, a.id);
  clearLoc(w, a);
  delete w.actors[a.id];
}

/** 不改 World 的預檢，給 UI 標示合法落點；最終仍以 applyCommand 為準。 */
export function previewMove(w: World, side: Side, actorId: number, to: BoardLoc | SlotLoc, data: GameData): CommandResult {
  return checkMove(w, side, actorId, to, data).result;
}

type MovePlan =
  | { result: CommandResult & { ok: false } }
  | { result: typeof ok; plan: 'move' | 'merge' | 'swap' | 'expand' | 'feed'; actor: Actor; other: Actor | null };

function checkMove(w: World, side: Side, actorId: number, to: BoardLoc | SlotLoc, data: GameData): MovePlan {
  const a = w.actors[actorId];
  if (!a) return { result: { ok: false, reason: '單位已不存在' } };
  if (a.side !== side) return { result: { ok: false, reason: '不是己方單位' } };
  if (a.loc.c === 'incoming') return { result: { ok: false, reason: '援軍還在路上' } };
  if (unitPinned(w, a.id)) return { result: { ok: false, reason: '單位受控制，無法移動' } };
  const from = a.loc;
  if (from.c === to.c && (from.c === 'board' ? from.x === (to as BoardLoc).x && from.y === (to as BoardLoc).y : from.i === (to as SlotLoc).i)) {
    return { result: { ok: false, reason: '位置沒有改變' } };
  }
  const err = placeOk(w, a, to);
  if (err) return { result: { ok: false, reason: err } };
  const otherId = occupant(w, side, to);
  if (otherId === null) {
    return { result: ok, plan: a.kind === 'shovel' && to.c === 'board' ? 'expand' : 'move', actor: a, other: null };
  }
  const b = w.actors[otherId];
  if (!b) return { result: { ok: false, reason: '目標不存在' } };
  if (b.loc.c === 'incoming') return { result: { ok: false, reason: '援軍正在趕來' } };
  if (unitPinned(w, b.id)) return { result: { ok: false, reason: '目標受控制，無法交換' } };
  if (a.kind === 'shovel' && to.c === 'board') return { result: { ok: false, reason: '這塊地上已有單位' } };
  // 同字同級才合成；同字不同級當作一般交換
  if ((a.kind === 'soldier' || a.kind === 'farmer') && a.kind === b.kind && a.token === b.token && a.level === b.level) {
    if (unitSuppressed(w, a.id) || unitSuppressed(w, b.id)) return { result: { ok: false, reason: '受壓制不能合成' } };
    if (b.level >= SOLDIER_MAX_LEVEL) return { result: { ok: false, reason: '已達最高等級' } };
    return { result: ok, plan: 'merge', actor: a, other: b };
  }
  // 名字字拖到已成形武將的同字上：餵經驗
  const g = feedTarget(w, a, b);
  if (g) {
    if (g.level >= generalMaxLevel(g, data)) return { result: { ok: false, reason: '武將已達最高等級' } };
    return { result: ok, plan: 'feed', actor: a, other: b };
  }
  // 交換：對方也必須能放到我原本的位置
  const backErr = placeOk(w, b, from);
  if (backErr) return { result: { ok: false, reason: `無法交換：${backErr}` } };
  return { result: ok, plan: 'swap', actor: a, other: b };
}

function move(w: World, side: Side, actorId: number, to: BoardLoc | SlotLoc, ctx: StepContext): CommandResult {
  const c = checkMove(w, side, actorId, to, ctx.data);
  if (!c.result.ok) return c.result;
  const { plan, actor: a, other: b } = c as Extract<MovePlan, { plan: string }>;
  const from = a.loc;
  switch (plan) {
    case 'move':
      dissolveGeneralOf(w, a);
      clearLoc(w, a);
      setLoc(w, a, to);
      tryFormGeneral(w, a, ctx);
      onFarmerPlaced(w, a);
      break;
    case 'feed': {
      const g = w.generals[b!.generalId!]!;
      removeActor(w, a);
      gainExp(w, g, feedAmount(g, ctx.data), ctx);
      break;
    }
    case 'expand': {
      const t = to as BoardLoc;
      removeActor(w, a);
      expandCell(w, side, t.x, t.y, ctx);
      break;
    }
    case 'merge':
      removeActor(w, a);
      b!.level += 1;
      onUnitLevelUp(w, b!.id);
      ctx.events.push({ type: 'merged', actorId: b!.id, level: b!.level });
      break;
    case 'swap':
      dissolveGeneralOf(w, a);
      dissolveGeneralOf(w, b!);
      clearLoc(w, a);
      clearLoc(w, b!);
      setLoc(w, a, to);
      setLoc(w, b!, from);
      tryFormGeneral(w, a, ctx);
      tryFormGeneral(w, b!, ctx);
      onFarmerPlaced(w, a);
      onFarmerPlaced(w, b!);
      break;
  }
  return ok;
}
