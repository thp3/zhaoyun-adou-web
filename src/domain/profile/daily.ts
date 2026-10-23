// 每日處理：只在「向前跨日」時套用。裝置日期倒退不重置、也不倒回 lastProcessedDay。
import { dayNumber, type DayKey } from '../time/calendar';
import type { Profile } from './profile';

export type DailyOutcome =
  | { kind: 'same-day' }
  | { kind: 'clock-behind' }
  | { kind: 'deferred' }
  | { kind: 'reset'; daysPassed: number; profile: Profile };

/**
 * @param hasActiveBattle 有未結算對局時延後重置，避免清掉當局快照依賴的道具與設定
 */
export function applyDailyReset(p: Profile, today: DayKey, hasActiveBattle: boolean): DailyOutcome {
  const diff = dayNumber(today) - dayNumber(p.lastProcessedDay);
  if (diff === 0) return { kind: 'same-day' };
  if (diff < 0) return { kind: 'clock-behind' };
  if (hasActiveBattle) return { kind: 'deferred' };
  return {
    kind: 'reset',
    daysPassed: diff,
    profile: {
      ...p,
      lastProcessedDay: today,
      consecutiveLoginDays: diff === 1 ? p.consecutiveLoginDays + 1 : 1,
      items: [],
      lowPriorityItems: [],
      stats: { ...p.stats, winDay: 0, loseDay: 0 },
      // 昨日段位快照與領獎標記同一次更新
      rank: { ...p.rank, lastStar: p.rank.curStar, rewardClaimedDay: null },
    },
  };
}

/** 註冊後第幾個日曆日（註冊當日為 1）。 */
export function registerDayIndex(p: Profile, today: DayKey): number {
  return Math.max(1, dayNumber(today) - dayNumber(p.registerDay) + 1);
}
