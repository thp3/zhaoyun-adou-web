// 對局世界：純資料、可 JSON 序列化。不放函式、DOM 或資料表；規則表經 BattleRules 傳入。
import type { GameData } from '../../data';
import type { RngState } from './rng';

export const TICK_MS = 20;
export const CELL = 80;
export const ticks = (ms: number) => Math.max(1, Math.round(ms / TICK_MS));

/** 0 = 玩家（防守 lm=true 的敵人流），1 = AI */
export type Side = 0 | 1;

export type BoardLoc = { c: 'board'; x: number; y: number };
export type SlotLoc = { c: 'slot'; i: number };
/** 征兵飛行中：已占用刷新欄位，不可拖動 */
export type IncomingLoc = { c: 'incoming'; i: number };
export type Loc = BoardLoc | SlotLoc | IncomingLoc;

export type ActorKind = 'soldier' | 'name' | 'shovel';

export interface Actor {
  id: number;
  side: Side;
  token: string;
  kind: ActorKind;
  level: number;
  loc: Loc;
  /** 距離可以再次攻擊的 tick 數 */
  cooldown: number;
  /** 名字字：所屬已成形武將；未成形為 null */
  generalId: number | null;
  /** 名字字保留的武將經驗（拆開後再合仍沿用較大者） */
  exp: number;
}

/** 已成形的武將：由同一列相鄰、依序排列的名字字組成 */
export interface General {
  id: number;
  side: Side;
  /** data.generals 的索引 */
  type: number;
  /** 由左到右的組成字 actor id */
  partIds: number[];
  level: number;
  exp: number;
  cooldown: number;
}

export interface Enemy {
  id: number;
  side: Side;
  hp: number;
  maxHp: number;
  /** 像素／秒 */
  speed: number;
  x: number;
  y: number;
  /** 下一個要前往的路點索引 */
  pathIdx: number;
  boss: boolean;
  /** 曾造成傷害的武將 id（助攻經驗用） */
  hitBy: number[];
}

/** 攻擊來源：普通兵 actor 或武將 */
export type AttackSource = { kind: 'actor' | 'general'; id: number };

export interface Projectile {
  id: number;
  side: Side;
  src: AttackSource;
  targetId: number;
  x: number;
  y: number;
  speed: number;
  damage: number;
}

/** 延遲事件：只存資料，載入時由白名單 handler 依 kind 處理 */
export type ScheduledAction =
  | { kind: 'enterSlot'; actorId: number }
  | { kind: 'meleeHit'; src: AttackSource; targetId: number; damage: number }
  | { kind: 'fireArrow'; src: AttackSource; targetId: number; damage: number }
  | { kind: 'spearThrust'; src: AttackSource; targetId: number; damage: number }
  | { kind: 'cavalrySweep'; src: AttackSource; damage: number };

export interface Scheduled {
  due: number;
  seq: number;
  action: ScheduledAction;
}

export interface CampState {
  lives: number;
  /** 戰鬥資金（原版「饅頭」），與永久金幣無關 */
  gold: number;
  recruitCost: number;
  /** 該方當前牌庫（會被消耗） */
  deck: string[];
  /** 5 個刷新欄位放的 actor id */
  slots: (number | null)[];
  lastRecruitTick: number;
  /** 至少完成過一次征兵（原版 Ch / Uh） */
  refreshed: boolean;
  kills: number;
}

export type WavePhase = 'ready' | 'spawning' | 'intermission' | 'done';

export interface WaveState {
  phase: WavePhase;
  /** 目前波次，1 起；ready 時為 0 */
  wave: number;
  timer: number;
  spawned: number;
}

export type EndReason = 'player-dead' | 'ai-dead' | 'waves-cleared' | 'surrender';

export interface BattleResult {
  outcome: 'win' | 'lose';
  reason: EndReason;
  tick: number;
  wave: number;
}

export interface World {
  schema: 1;
  tick: number;
  mapId: number;
  kind: number[][];
  camp: number[][];
  /** 兩方敵人流的像素路點（格中心） */
  paths: [Pt[], Pt[]];
  /** 每個路點到終點的剩餘距離，供 closest_end 選敵 */
  remain: [number[], number[]];
  board: (number | null)[][];
  actors: Record<number, Actor>;
  generals: Record<number, General>;
  enemies: Record<number, Enemy>;
  projectiles: Record<number, Projectile>;
  scheduled: Scheduled[];
  seq: number;
  nextId: number;
  rng: RngState;
  camps: [CampState, CampState];
  wave: WaveState;
  /** 本局血量策略索引（整局一次） */
  hpStrategy: number;
  /** 開局凍結：累計局數、段位 addHp */
  totalRounds: number;
  addHp: number;
  aiEnabled: boolean;
  /** AI 難度 0–3 */
  difficulty: number;
  /** AI 單位傷害倍率（原版 nu.mh，教學 0.7） */
  aiDamageMultiplier: number;
  ai: AiState;
  result: BattleResult | null;
}

/** AI 五階段狀態；全部可序列化，恢復時不重設成 stage 1 */
export interface AiState {
  stage: 1 | 2 | 3 | 4 | 5;
  /** 距離下次決策累積的 tick */
  timer: number;
  /** stage 2：處理到第幾個刷新欄（原版 tX） */
  slotCursor: number;
  /** stage 3：盤面掃描游標 [x, y]（原版 pX） */
  scanCursor: [number, number];
  /** stage 5：佈局游標 [x, y]（原版 xX） */
  moveCursor: [number, number];
  /** stage 3 收集的名字字 id（原版 op） */
  names: number[];
  /** stage 5 佈局計畫：plan[x][y] = actor id（AI 半場，原版 vX） */
  plan: (number | null)[][];
  /** 每局一次的免費擴地已用（原版 UX） */
  usedFreeExpand: boolean;
}

export interface Pt {
  x: number;
  y: number;
}

/** 當 tick 產生、只給畫面用的事件；不存檔 */
export type BattleEvent =
  | { type: 'rejected'; side: Side; reason: string }
  | { type: 'recruited'; side: Side }
  | { type: 'attack'; src: AttackSource; kind: 'melee' | 'arrow' | 'spear' | 'sweep'; x: number; y: number; tx: number; ty: number; r?: number }
  | { type: 'damage'; enemyId: number; x: number; y: number; amount: number }
  | { type: 'enemyDied'; enemyId: number; side: Side; x: number; y: number; reward: number }
  | { type: 'adouHit'; side: Side; lives: number }
  | { type: 'merged'; actorId: number; level: number }
  | { type: 'generalFormed'; generalId: number; side: Side }
  | { type: 'generalLevel'; generalId: number; level: number }
  | { type: 'recycled'; actorId: number; side: Side }
  | { type: 'expanded'; x: number; y: number }
  | { type: 'waveStart'; wave: number }
  | { type: 'ended'; result: BattleResult };

export type BattleCommand =
  | { type: 'RECRUIT'; side: Side }
  | { type: 'MOVE'; side: Side; actorId: number; to: BoardLoc | SlotLoc };

export interface BattleRules {
  data: GameData;
}

export interface StepContext extends BattleRules {
  events: BattleEvent[];
}
