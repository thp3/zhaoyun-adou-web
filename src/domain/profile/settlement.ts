// 對局結算：由不可變的 ResultDraft 算出 Profile 變化。只在結算交易內呼叫一次。
import type { GameData } from '../../data';
import type { EndReason } from '../battle/types';
import { dayKeyOf, weekdayMonFirst } from '../time/calendar';
import { registerDayIndex } from './daily';
import { roundOfDay, type Profile } from './profile';
import { addFragments } from './inventory';
import { rankToStar, starToRank } from './rank';

export interface ResultDraft {
  battleId: string;
  rulesetVersion: string;
  outcome: 'win' | 'lose';
  reason: EndReason;
  /** 終局時的波次（放棄規則依此判斷） */
  wave: number;
  tick: number;
  kills: number;
  /** 玩家防區已確認的碎片掉落（weaponId，可重複） */
  drops: number[];
  /** 本局成形過的武將 key（圖鑑解鎖） */
  formed: string[];
}

export interface SettlementDelta {
  outcome: 'win' | 'lose';
  goldDelta: number;
  starBefore: number;
  starAfter: number;
  /** 入帳的碎片 */
  drops: number[];
}

/** 原版 Pt.Cu：勝 +1、敗 -1，跨段位時依各段 level 閾值處理；皇帝 53 不封頂。 */
export function changeRankStar(curStar: number, delta: 1 | -1, ranks: GameData['ranks']['ranks']): number {
  const pos = starToRank(curStar);
  let id = pos.rankId;
  let level = pos.level + delta;
  const cfg = (i: number) => ranks[i]!.level;
  if (delta > 0) {
    if (level > cfg(id)) {
      if (id !== 53) id += 1;
      if (id <= 50) level = 1;
    }
  } else if (id > 50) {
    if (level <= cfg(id - 1)) {
      level = cfg(id - 1);
      id -= 1;
    }
  } else if (id > 0) {
    if (level <= 0) {
      level = cfg(id - 1);
      id -= 1;
    }
  } else if (level <= 0) {
    level = 1;
  }
  return rankToStar({ rankId: id, level });
}

/** 普通結算金幣：勝 20、敗 5；第 5 波前放棄 0 */
export function settlementGold(draft: ResultDraft, data: GameData): number {
  const r = data.economy.battleReward;
  if (draft.outcome === 'win') return r.winGold;
  if (draft.reason === 'surrender' && draft.wave < r.earlySurrenderWave) return 0;
  return r.loseGold;
}

export function applySettlement(p: Profile, draft: ResultDraft, data: GameData): { profile: Profile; delta: SettlementDelta } {
  const win = draft.outcome === 'win';
  const goldDelta = settlementGold(draft, data);
  const starBefore = p.rank.curStar;
  const starAfter = changeRankStar(starBefore, win ? 1 : -1, data.ranks.ranks);
  const rankId = starToRank(starAfter).rankId;
  return {
    delta: { outcome: draft.outcome, goldDelta, starBefore, starAfter, drops: [...draft.drops] },
    profile: {
      ...addFragments(p, draft.drops, data),
      mergedGenerals: [...new Set([...p.mergedGenerals, ...draft.formed])],
      gold: p.gold + goldDelta,
      rank: { ...p.rank, curStar: starAfter },
      stats: {
        win: p.stats.win + (win ? 1 : 0),
        lose: p.stats.lose + (win ? 0 : 1),
        winDay: p.stats.winDay + (win ? 1 : 0),
        loseDay: p.stats.loseDay + (win ? 0 : 1),
        winStreak: win ? p.stats.winStreak + 1 : 0,
      },
      openProps: p.openProps || rankId >= data.items.shopUnlockRankId,
      tutorial: { ...p.tutorial, firstBattleDone: true },
    },
  };
}

/** 本局地圖：註冊首日每 7 局輪換前三圖；之後依星期（週一至週日）。 */
export function selectMapId(p: Profile, now: number, data: GameData): number {
  const today = dayKeyOf(now, data.economy.calendarZone);
  const rot = data.maps.rotation;
  if (registerDayIndex(p, today) <= 1) {
    const i = Math.floor((roundOfDay(p) - 1) / rot.firstDayGamesPerMap) % rot.firstDay.length;
    return rot.firstDay[i]!;
  }
  // 星期以日曆時區的日期為準
  return rot.weekdayMonToSun[weekdayMonFirst(today)]!;
}
