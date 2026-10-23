// 建立一局的初始 World。所有隨機都來自 seed，同參數必得同初態。
import type { GameData } from '../../data';
import { lanePath, type Cell } from './path';
import { createRng, pickWeighted } from './rng';
import { CELL, type CampState, type Pt, type ScheduledAction, type World } from './types';

export interface CreateWorldParams {
  data: GameData;
  seed: number;
  mapId: number;
  /** 開局時的累計局數（新手血量係數用） */
  totalRounds: number;
  /** 本日第幾局（前 3 局追加鏟） */
  roundOfDay: number;
  /** 玩家段位的 addHp（第 10 波後敵人血量加成） */
  addHp: number;
  /** M2：AI 尚未出手；關閉時 AI 阿斗不扣命（原版 dh=false） */
  aiEnabled: boolean;
}

const center = (c: Cell): Pt => ({ x: c.x * CELL + CELL / 2, y: c.y * CELL + CELL / 2 });

function remainingLengths(path: Pt[]): number[] {
  const out = new Array<number>(path.length).fill(0);
  for (let i = path.length - 2; i >= 0; i--) {
    const a = path[i]!;
    const b = path[i + 1]!;
    out[i] = out[i + 1]! + Math.hypot(b.x - a.x, b.y - a.y);
  }
  return out;
}

export function createWorld(p: CreateWorldParams): World {
  const { data } = p;
  const map = data.maps.maps[p.mapId];
  if (!map) throw new Error(`未知地圖 ${p.mapId}`);
  const rng = createRng(p.seed);
  const lane = { ...map, width: map.width, height: map.height };
  const paths: [Pt[], Pt[]] = [lanePath(lane, 0).map(center), lanePath(lane, 1).map(center)];

  const deck = [...data.deck.baseDeck];
  if (p.roundOfDay <= data.deck.earlyGameShovel.maxRoundDay) {
    const extra = Math.floor(deck.filter((t) => t === 'shovel').length / data.deck.earlyGameShovel.divisor);
    for (let i = 0; i < extra; i++) deck.push('shovel');
  }
  const camp = (gold: number): CampState => ({
    lives: data.waves.adou.lives,
    gold,
    recruitCost: data.deck.recruit.initialCost,
    deck: [...deck],
    slots: Array.from({ length: data.deck.recruit.slots }, () => null),
    lastRecruitTick: -1_000_000,
    refreshed: false,
    kills: 0,
  });

  return {
    schema: 1,
    tick: 0,
    mapId: p.mapId,
    kind: map.kind.map((col) => [...col]),
    camp: map.camp.map((col) => [...col]),
    paths,
    remain: [remainingLengths(paths[0]), remainingLengths(paths[1])],
    board: map.kind.map((col) => col.map(() => null)),
    actors: {},
    enemies: {},
    projectiles: {},
    scheduled: [],
    seq: 0,
    nextId: 1,
    rng,
    camps: [camp(data.economy.battleStart.playerGold), camp(data.economy.battleStart.aiGold)],
    wave: { phase: 'ready', wave: 0, timer: 0, spawned: 0 },
    hpStrategy: pickWeighted(rng, 'combat', data.waves.hpStrategyWeights),
    totalRounds: p.totalRounds,
    addHp: p.addHp,
    aiEnabled: p.aiEnabled,
    result: null,
  };
}

export function allocId(w: World): number {
  return w.nextId++;
}

/** 加入延遲事件，保持 (due, seq) 排序 */
export function schedule(w: World, delayTicks: number, action: ScheduledAction): void {
  const item = { due: w.tick + Math.max(1, delayTicks), seq: w.seq++, action };
  let i = w.scheduled.length;
  while (i > 0 && w.scheduled[i - 1]!.due > item.due) i--;
  w.scheduled.splice(i, 0, item);
}
