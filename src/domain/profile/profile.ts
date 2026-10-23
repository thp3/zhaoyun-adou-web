// 永久進度 Profile（重構格式，不直接沿用原版 43 欄位）。只有跨局資料放這裡。
import { z } from 'zod';
import type { DayKey } from '../time/calendar';

export const PROFILE_SCHEMA_VERSION = 1;
export const EQUIP_SLOTS = 12;

const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const nonNegInt = z.number().int().nonnegative();

export const ProfileSchema = z.object({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  /** 每次提交 +1；交易以此檢查是否基於最新資料 */
  revision: nonNegInt,
  createdAt: nonNegInt,
  registerDay: dayKey,
  /** 最近一次完成每日處理的日期 */
  lastProcessedDay: dayKey,
  consecutiveLoginDays: z.number().int().positive(),
  /** 永久金幣（原版「蜜獾幣」），不是戰鬥資金 */
  gold: nonNegInt,
  stamina: z.object({ value: nonNegInt, lastRecoverAt: nonNegInt }),
  rank: z.object({
    curStar: nonNegInt,
    /** 每日重置時的星數快照，用於段位每日獎勵 */
    lastStar: nonNegInt,
    rewardClaimedDay: dayKey.nullable(),
  }),
  stats: z.object({
    win: nonNegInt,
    lose: nonNegInt,
    winDay: nonNegInt,
    loseDay: nonNegInt,
    winStreak: nonNegInt,
  }),
  /** 每個武將槽裝備的武器 id；-1 表示空 */
  equip: z.array(z.number().int().min(-1)).length(EQUIP_SLOTS),
  /** weaponId → 累計碎片數（完整件數由碎片換算） */
  weaponFragments: z.record(z.string().regex(/^\d+$/), nonNegInt),
  weaponFree: z.boolean(),
  newWeaponIds: z.array(nonNegInt),
  /** 當日持有的對局道具；每日重置清空 */
  items: z.array(z.object({ id: nonNegInt, level: z.number().int().positive() })),
  /** 本日已降低抽中權重的道具 */
  lowPriorityItems: z.array(nonNegInt),
  openProps: z.boolean(),
  mergedGenerals: z.array(z.string()),
  tutorial: z.object({ firstBattleDone: z.boolean(), weaponDragGuideDone: z.boolean() }),
  settings: z.object({ showDamageNumbers: z.boolean() }),
});

export type Profile = z.infer<typeof ProfileSchema>;

export interface NewProfileRules {
  staminaMax: number;
}

export function createDefaultProfile(now: number, today: DayKey, rules: NewProfileRules): Profile {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    revision: 0,
    createdAt: now,
    registerDay: today,
    lastProcessedDay: today,
    consecutiveLoginDays: 1,
    gold: 0,
    stamina: { value: rules.staminaMax, lastRecoverAt: now },
    rank: { curStar: 0, lastStar: 0, rewardClaimedDay: null },
    stats: { win: 0, lose: 0, winDay: 0, loseDay: 0, winStreak: 0 },
    equip: Array.from({ length: EQUIP_SLOTS }, () => -1),
    weaponFragments: {},
    weaponFree: false,
    newWeaponIds: [],
    items: [],
    lowPriorityItems: [],
    openProps: false,
    mergedGenerals: [],
    tutorial: { firstBattleDone: false, weaponDragGuideDone: false },
    settings: { showDamageNumbers: true },
  };
}

/** 累計局數 */
export const totalRounds = (p: Profile) => p.stats.win + p.stats.lose;
/** 本日第幾局（原版 roundDay = winDay + loseDay + 1） */
export const roundOfDay = (p: Profile) => p.stats.winDay + p.stats.loseDay + 1;
