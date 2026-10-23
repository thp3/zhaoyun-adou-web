// 道具商店與輪盤（原版 Yo / Zh / F）。商店解鎖：段位 id ≥ 1。
// 商店一次活動最多 3 件商品，買任一件即整組售罄；行軍丹直接補體力、不佔道具槽。
// 輪盤：8 格依「選入權重」不放回抽出，再依「中獎權重」先決定獎項才播動畫。原版需看完廣告才能轉，
// 本版未接廣告服務，介面不開放；規則保留並測試，接上平台後可直接使用。
import type { GameData } from '../../data';
import { addStamina, type StaminaRules } from './stamina';
import type { Profile } from './profile';

type ItemDef = GameData['items']['items'][number];

export interface Offer {
  itemId: number;
  /** 購買後的等級（升級道具為下一級） */
  level: number;
  price: number;
}

export interface ShopSession {
  sessionId: string;
  createdAt: number;
  offers: Offer[];
  soldOut: boolean;
}

function ownedLevel(p: Profile, id: number): number {
  return p.items.find((i) => i.id === id)?.level ?? 0;
}

/** 可上架的候選（原版 Zh.YB）：排除鏟子、推土車；一般道具只選未持有，升級道具可選未滿級；行軍丹一律在內 */
export function shopCandidates(p: Profile, data: GameData): Offer[] {
  const out: Offer[] = [];
  for (const def of data.items.items) {
    if (data.items.shopExcluded.includes(def.key)) continue;
    const owned = ownedLevel(p, def.id);
    if (def.levels) {
      if (owned >= def.levels.length) continue;
      const lv = def.levels[owned]!;
      out.push({ itemId: def.id, level: owned + 1, price: lv.goldPrice });
    } else if (def.key === data.items.staminaItem || owned === 0) {
      out.push({ itemId: def.id, level: 1, price: def.goldPrice });
    }
  }
  return out;
}

export function createShopSession(p: Profile, data: GameData, rand: () => number, now: number, sessionId: string): ShopSession {
  const pool = shopCandidates(p, data);
  const offers: Offer[] = [];
  while (offers.length < data.items.shopItemsPerVisit && pool.length > 0) offers.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
  return { sessionId, createdAt: now, offers, soldOut: false };
}

function capacityOk(p: Profile, def: ItemDef, data: GameData): boolean {
  // 已持有的升級道具與行軍丹不佔新格
  if (def.key === data.items.staminaItem || ownedLevel(p, def.id) > 0) return true;
  const isActive = (id: number) => data.items.items[id]!.active;
  const count = p.items.filter((i) => isActive(i.id) === def.active).length;
  return count < (def.active ? data.items.capacity.active : data.items.capacity.passive);
}

/** 給予道具：升級道具加一級，其餘加入；行軍丹補體力 */
export function grantItem(p: Profile, itemId: number, level: number, data: GameData, now: number, stamina: StaminaRules): Profile {
  const def = data.items.items[itemId]!;
  if (def.key === data.items.staminaItem) {
    return { ...p, stamina: addStamina(p.stamina, data.economy.stamina.marchPillReward, now, stamina) };
  }
  const items = p.items.filter((i) => i.id !== itemId);
  items.push({ id: itemId, level });
  return { ...p, items };
}

export type ShopResult = { ok: true; profile: Profile; session: ShopSession } | { ok: false; reason: string };

export function purchase(p: Profile, s: ShopSession, index: number, data: GameData, now: number, stamina: StaminaRules): ShopResult {
  if (s.soldOut) return { ok: false, reason: '本次商品已售罄' };
  const offer = s.offers[index];
  if (!offer) return { ok: false, reason: '沒有這個商品' };
  const def = data.items.items[offer.itemId]!;
  if (!capacityOk(p, def, data)) return { ok: false, reason: def.active ? '主動道具最多 2 個' : '被動道具最多 6 個' };
  if (ownedLevel(p, def.id) >= offer.level) return { ok: false, reason: '已經擁有' };
  if (p.gold < offer.price) return { ok: false, reason: `金幣不足（需要 ${offer.price}）` };
  const paid = { ...p, gold: p.gold - offer.price };
  return { ok: true, profile: grantItem(paid, offer.itemId, offer.level, data, now, stamina), session: { ...s, soldOut: true } };
}

// ---------------- 輪盤 ----------------

export interface LotteryDraw {
  slots: Offer[];
  winner: number;
}

function weightedIndex(weights: number[], rand: () => number): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return -1;
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

function weightsOf(def: ItemDef, level: number): { inclusion: number; win: number } {
  const lv = def.levels?.[level - 1];
  return {
    inclusion: lv?.lotteryInclusionWeight ?? def.lotteryInclusionWeight ?? 0,
    win: lv?.lotteryWinWeight ?? def.lotteryWinWeight ?? 0,
  };
}

/**
 * 抽一次輪盤：候選不足 8 不開放（回傳 null）。本日已降權的道具選入權重 ×0.5、中獎權重 ×0.2
 *（原版首次加入時的比例；重讀存檔分支是 ×0.8，兩者不一致，這裡採首次分支）。
 */
export function drawLottery(p: Profile, data: GameData, rand: () => number): LotteryDraw | null {
  const cands = shopCandidates(p, data);
  if (cands.length < data.items.lotterySlots) return null;
  const low = (id: number) => p.lowPriorityItems.includes(id);
  const inclusion = cands.map((c) => weightsOf(data.items.items[c.itemId]!, c.level).inclusion * (low(c.itemId) ? 0.5 : 1));
  const slots: Offer[] = [];
  for (let k = 0; k < data.items.lotterySlots; k++) {
    const i = weightedIndex(inclusion, rand);
    if (i < 0) break;
    slots.push(cands[i]!);
    inclusion[i] = 0;
  }
  const win = slots.map((s) => weightsOf(data.items.items[s.itemId]!, s.level).win * (low(s.itemId) ? 0.2 : 1));
  const winner = weightedIndex(win, rand);
  return winner < 0 ? null : { slots, winner };
}

export type ClaimResult =
  | { kind: 'granted'; profile: Profile }
  /** 道具槽已滿：玩家選要替換的舊道具，或放棄 */
  | { kind: 'needsReplacement'; offer: Offer };

export function claimLottery(p: Profile, offer: Offer, data: GameData, now: number, stamina: StaminaRules): ClaimResult {
  const def = data.items.items[offer.itemId]!;
  if (!capacityOk(p, def, data)) return { kind: 'needsReplacement', offer };
  return { kind: 'granted', profile: grantItem(p, offer.itemId, offer.level, data, now, stamina) };
}

/** 槽滿時的決定：替換掉 replaceId，或放棄（replaceId=null）；兩者都把新道具本日降權，替換時舊道具也降權 */
export function resolveReplacement(p: Profile, offer: Offer, replaceId: number | null, data: GameData, now: number, stamina: StaminaRules): Profile {
  const low = new Set(p.lowPriorityItems);
  low.add(offer.itemId);
  let next: Profile = { ...p, lowPriorityItems: [...low] };
  if (replaceId !== null) {
    low.add(replaceId);
    next = { ...next, items: next.items.filter((i) => i.id !== replaceId), lowPriorityItems: [...low] };
    next = grantItem(next, offer.itemId, offer.level, data, now, stamina);
  }
  return next;
}

// ---------------- 段位每日獎勵 ----------------

/** 每日一次：依昨日段位快照（lastStar）領該段位的金幣 */
export function rankRewardAvailable(p: Profile, today: string): boolean {
  return p.rank.rewardClaimedDay !== today;
}

/** 段位每日金幣：依 lastStar 所在段位的 reward */
export function claimRankReward(p: Profile, today: string, data: GameData, starToRankId: (star: number) => number): { profile: Profile; gold: number } | null {
  if (!rankRewardAvailable(p, today)) return null;
  const gold = data.ranks.ranks[starToRankId(p.rank.lastStar)]!.reward;
  return { gold, profile: { ...p, gold: p.gold + gold, rank: { ...p.rank, rewardClaimedDay: today } } };
}
