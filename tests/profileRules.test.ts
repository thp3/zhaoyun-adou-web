import { describe, expect, it } from 'vitest';
import { applyDailyReset, registerDayIndex } from '../src/domain/profile/daily';
import { createDefaultProfile } from '../src/domain/profile/profile';
import { rankToStar, starToRank } from '../src/domain/profile/rank';
import { addStamina, msUntilNextStamina, recoverStamina, spendStamina } from '../src/domain/profile/stamina';
import { dayKeyOf, dayNumber, weekdayMonFirst } from '../src/domain/time/calendar';

const RULES = { max: 30, recoverIntervalMs: 300_000 };
const MIN = 60_000;

describe('日曆', () => {
  it('依時區切日：台北 00:00 與 UTC 前一天', () => {
    const t = Date.UTC(2026, 9, 22, 16, 0, 0); // 台北 10/23 00:00
    expect(dayKeyOf(t, 'Asia/Taipei')).toBe('2026-10-23');
    expect(dayKeyOf(t - 1, 'Asia/Taipei')).toBe('2026-10-22');
    expect(dayKeyOf(t, 'UTC')).toBe('2026-10-22');
  });
  it('日序相減為天數、週一為 0', () => {
    expect(dayNumber('2026-03-01') - dayNumber('2026-02-28')).toBe(1);
    expect(weekdayMonFirst('2026-10-19')).toBe(0); // 週一
    expect(weekdayMonFirst('2026-10-25')).toBe(6); // 週日
  });
});

describe('體力', () => {
  it('整段補計並保留餘數', () => {
    const s = recoverStamina({ value: 10, lastRecoverAt: 1_000 }, 1_000 + 12 * MIN, RULES);
    expect(s).toEqual({ value: 12, lastRecoverAt: 1_000 + 10 * MIN });
  });
  it('補到上限即停，不累積額外體力', () => {
    const s = recoverStamina({ value: 28, lastRecoverAt: 1 }, 1 + 1000 * MIN, RULES);
    expect(s.value).toBe(30);
  });
  it('滿額時不改恢復起點', () => {
    const full = { value: 30, lastRecoverAt: 5 };
    expect(recoverStamina(full, 10 * MIN, RULES)).toBe(full);
  });
  it('裝置時間倒退不產生恢復，只重設起點', () => {
    const s = recoverStamina({ value: 10, lastRecoverAt: 100 * MIN }, 50 * MIN, RULES);
    expect(s).toEqual({ value: 10, lastRecoverAt: 50 * MIN });
  });
  it('由滿額扣 5 時恢復起點設為現在', () => {
    const s = spendStamina({ value: 30, lastRecoverAt: 1 }, 5, 99 * MIN, RULES);
    expect(s).toEqual({ value: 25, lastRecoverAt: 99 * MIN });
  });
  it('不足時不扣', () => {
    expect(spendStamina({ value: 4, lastRecoverAt: 10 * MIN }, 5, 10 * MIN + 1, RULES)).toBeNull();
  });
  it('補給封頂 30', () => {
    expect(addStamina({ value: 25, lastRecoverAt: 1 }, 10, 1, RULES).value).toBe(30);
  });
  it('下一點倒數', () => {
    expect(msUntilNextStamina({ value: 10, lastRecoverAt: 1 }, 1 + 2 * MIN, RULES)).toBe(3 * MIN);
    expect(msUntilNextStamina({ value: 30, lastRecoverAt: 1 }, 2, RULES)).toBeNull();
  });
});

describe('每日重置', () => {
  const base = () => {
    const p = createDefaultProfile(0, '2026-10-20', { staminaMax: 30 });
    return {
      ...p,
      gold: 77,
      items: [{ id: 5, level: 1 }],
      lowPriorityItems: [3],
      stats: { win: 4, lose: 2, winDay: 3, loseDay: 1, winStreak: 2 },
      rank: { curStar: 12, lastStar: 8, rewardClaimedDay: '2026-10-20' },
      weaponFragments: { '3': 5 },
    };
  };
  it('同一天不重置', () => {
    expect(applyDailyReset(base(), '2026-10-20', false).kind).toBe('same-day');
  });
  it('向前跨日：清當日道具與勝敗，保留永久進度', () => {
    const r = applyDailyReset(base(), '2026-10-21', false);
    if (r.kind !== 'reset') throw new Error('應重置');
    expect(r.profile.items).toEqual([]);
    expect(r.profile.lowPriorityItems).toEqual([]);
    expect(r.profile.stats).toEqual({ win: 4, lose: 2, winDay: 0, loseDay: 0, winStreak: 2 });
    expect(r.profile.rank).toEqual({ curStar: 12, lastStar: 12, rewardClaimedDay: null });
    expect(r.profile.gold).toBe(77);
    expect(r.profile.weaponFragments).toEqual({ '3': 5 });
    expect(r.profile.consecutiveLoginDays).toBe(2);
    expect(r.profile.lastProcessedDay).toBe('2026-10-21');
  });
  it('隔多天連登歸 1', () => {
    const r = applyDailyReset(base(), '2026-10-25', false);
    expect(r.kind === 'reset' && r.profile.consecutiveLoginDays).toBe(1);
  });
  it('日期倒退不重置', () => {
    expect(applyDailyReset(base(), '2026-10-19', false).kind).toBe('clock-behind');
  });
  it('有未完成對局時延後', () => {
    expect(applyDailyReset(base(), '2026-10-21', true).kind).toBe('deferred');
  });
  it('註冊第幾天', () => {
    expect(registerDayIndex(base(), '2026-10-20')).toBe(1);
    expect(registerDayIndex(base(), '2026-10-22')).toBe(3);
  });
});

describe('段位星數', () => {
  it.each([
    [0, 0, 1],
    [1, 0, 1],
    [5, 0, 5],
    [6, 1, 1],
    [250, 49, 5],
    [251, 50, 1],
    [275, 50, 25],
    [276, 51, 26],
    [326, 53, 76],
    [400, 53, 150],
  ])('curStar %i → rank %i 第 %i 星', (star, rankId, level) => {
    expect(starToRank(star)).toEqual({ rankId, level });
  });
  it('1..400 星互逆', () => {
    for (let s = 1; s <= 400; s++) expect(rankToStar(starToRank(s))).toBe(s);
  });
});
