// data/*.json 的 schema。資料由 tools/extract 產生；遊戲啟動時以此驗證，壞資料停在載入頁。
import { z } from 'zod';

const int = z.number().int();
const nonNegInt = int.nonnegative();
const point = z.object({ x: int, y: int });
const tokenId = z.string().min(1);

export const TokenSchema = z.object({
  id: tokenId,
  display: z.string().length(1),
  kind: z.enum(['soldier', 'tool', 'farmer', 'name']),
  soldierType: int.min(0).max(3).optional(),
  part: z.enum(['family', 'given']).optional(),
  sourceText: z.string().length(1),
  aiValue: z.array(z.number()).nullable(),
});
export const TokensFileSchema = z.object({ tokens: z.array(TokenSchema) });

const grid = z.array(z.array(int.min(0).max(2)).length(10)).length(8);
export const MapSchema = z.object({
  id: nonNegInt,
  key: z.string(),
  name: z.string(),
  width: z.literal(8),
  height: z.literal(10),
  kind: grid,
  camp: z.array(z.array(int.min(0).max(1)).length(10)).length(8),
  points: z.object({
    playerEntry: point,
    playerPathStart: point,
    playerPathEnd: point,
    aiEntry: point,
    aiPathStart: point,
    aiPathEnd: point,
  }),
  divider: z.array(point).min(2),
  enemySet: nonNegInt,
});
export const MapsFileSchema = z.object({
  tileSize: z.literal(80),
  tileKinds: z.record(z.string()),
  camps: z.record(z.string()),
  rotation: z.object({
    firstDay: z.array(nonNegInt),
    firstDayGamesPerMap: int.positive(),
    weekdayMonToSun: z.array(nonNegInt).length(7),
  }),
  maps: z.array(MapSchema).length(4),
});

export const DeckFileSchema = z.object({
  baseDeck: z.array(tokenId).length(108),
  nonConsumable: z.array(tokenId),
  emptyFallback: tokenId,
  recruit: z.object({
    slots: z.literal(5),
    initialCost: int.positive(),
    costIncrement: int.positive(),
    refreshLockMs: nonNegInt,
    playerStaggerMs: nonNegInt,
    playerFlyMs: nonNegInt,
  }),
  earlyGameShovel: z.object({ maxRoundDay: int.positive(), divisor: int.positive() }),
  aiExtraShovelsByDifficulty: z.array(nonNegInt).length(4),
  tutorial: z.object({
    firstRefreshAvoid: z.array(tokenId),
    firstRefreshMaxRetry: int.positive(),
    firstRefreshFallback: tokenId,
    secondRefreshFixed: z.array(tokenId).length(5),
    aiDifficulty: nonNegInt,
    aiDamageMultiplier: z.number().positive(),
  }),
});

export const UnitsFileSchema = z.object({
  soldiers: z
    .array(
      z.object({
        id: tokenId,
        soldierType: int.min(0).max(3),
        damage: z.number().positive(),
        rangeCells: z.number().positive(),
        intervalSec: z.number().positive(),
        attackShape: z.enum(['single', 'pierce', 'area']),
        targetRule: z.enum(['nearest', 'closest_end']),
      }),
    )
    .length(4),
  soldierMaxLevel: z.literal(5),
  soldierLevelMultiplier: z.array(z.number().positive()).length(5),
  farmer: z.object({
    maxLevel: z.literal(5),
    periodMsByLevel: z.array(int.positive()).length(5),
    goldPerHarvest: z.number().positive(),
    crazy: z.object({ intervalMs: int.positive(), durationMs: int.positive() }),
    siltGoldMultiplier: z.number().positive(),
  }),
});

export const GeneralsFileSchema = z.object({
  generals: z
    .array(
      z.object({
        id: nonNegInt,
        key: z.string(),
        name: z.string().length(2),
        chars: z.array(tokenId).length(2),
        weaponType: int.min(0).max(3),
        damage: z.number().positive(),
        rangeCells: z.number().positive(),
        altRangeCells: z.number().positive(),
        intervalSec: z.number().positive(),
        highTier: z.boolean(),
        maxLevel: z.union([z.literal(3), z.literal(5)]),
        attackShape: z.string(),
        targetRule: z.enum(['nearest', 'closest_end']),
        aiValue: z.number().positive(),
        skill: z
          .object({ skill: z.string(), triggerAttacks: nonNegInt, stunMs: int.positive().optional() })
          .nullable(),
      }),
    )
    .length(12),
  expHighTier: z.array(nonNegInt).length(5),
  expNormalTier: z.array(nonNegInt).length(3),
  killCredit: z.object({
    killerExp: z.number(),
    assistPoolByGeneral: z.number(),
    assistPoolByOther: z.number(),
  }),
  skills: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })).length(7),
});

export const WavesFileSchema = z.object({
  waveCount: z.literal(20),
  spawnCountByWave: z.array(int.positive()).length(20),
  spawnIntervalMs: int.positive(),
  intermissionMs: int.positive(),
  initialDelayMs: int.positive(),
  endlessExtraPerWave: nonNegInt,
  endlessHp: z.object({ base: z.number().positive(), growth: z.number().positive() }),
  baseHpByMap: z.array(z.array(z.number().positive()).length(20)).length(4),
  speedByMap: z.array(z.number().positive()).length(4),
  hpStrategies: z.array(z.array(z.number().positive()).length(20)).length(3),
  hpStrategyWeights: z.array(nonNegInt).length(3),
  rookieHpByRound: z.array(z.number().positive()).length(10),
  puppetLevelHpMultiplier: z.array(z.number().positive()).length(5),
  bossWaves: z.array(int.positive()).length(6),
  bossChance: z.array(z.number().min(0).max(1)).length(6),
  bossFragmentChance: z.number().min(0).max(1),
  bosses: z
    .array(
      z.object({
        id: nonNegInt,
        key: z.string(),
        name: z.string(),
        mapId: int.min(0).max(3),
        hpMultiplier: z.number().positive(),
        speed: z.number().positive(),
        rangeCells: z.number().nonnegative(),
        cooldownSec: z.number().positive(),
        skillName: z.string(),
        skillIntro: z.string(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      }),
    )
    .length(12),
  adou: z.object({ lives: int.positive(), attackCooldownMs: int.positive() }),
});

export const AiFileSchema = z.object({
  decisionIntervalMs: z.array(int.positive()).length(4),
  initialBonusGold: nonNegInt,
  waveBonusWaves: z.array(int.positive()),
  waveBonusGoldByDifficulty: z.array(nonNegInt).length(4),
  expandChanceWhenBroke: z.array(z.number()).length(4),
  extraShovelsByDifficulty: z.array(nonNegInt).length(4),
  lowDifficultyValueMult: z.array(z.number()).length(2),
  minValueToDeploy: z.number(),
  replaceFactor: z.object({ soldier: z.number(), general: z.number(), scale: z.number() }),
  clusterPenalty: z.object({ radius: int.positive(), factor: z.number() }),
  pathTrim: z.number(),
  propUseMinIntervalMs: int.positive(),
  unresolved: z.record(z.unknown()),
});

const itemLevel = z.object({
  level: int.positive(),
  promoteChancePct: z.number().nullable(),
  rarity: int.min(0).max(3),
  goldPrice: int.positive(),
  lotteryInclusionWeight: z.number().nonnegative(),
  lotteryWinWeight: z.number().nonnegative(),
});
export const ItemsFileSchema = z.object({
  capacity: z.object({ active: z.literal(2), passive: z.literal(6) }),
  shopItemsPerVisit: z.literal(3),
  shopExcluded: z.array(z.string()),
  shopUnlockRankId: nonNegInt,
  staminaItem: z.string(),
  lotterySlots: z.literal(8),
  rarityNames: z.array(z.string()).length(4),
  rarityColors: z.array(z.string()).length(4),
  aiItemCountFirstDay: z.array(z.tuple([nonNegInt, nonNegInt])).length(30),
  aiItemCountLater: z.array(z.tuple([nonNegInt, nonNegInt])).length(30),
  items: z
    .array(
      z.object({
        id: nonNegInt,
        key: z.string(),
        name: z.string(),
        intro: z.string(),
        active: z.boolean(),
        cooldownMs: nonNegInt.nullable(),
        rarity: int.min(0).max(3),
        goldPrice: int.positive(),
        lotteryInclusionWeight: z.number().nonnegative().nullable(),
        lotteryWinWeight: z.number().nonnegative().nullable(),
        levels: z.array(itemLevel).nullable(),
      }),
    )
    .length(25),
});

export const BuffsFileSchema = z.object({
  buffs: z.array(z.object({ id: nonNegInt, key: z.string(), category: z.enum(['stat', 'custom', 'state']) })).length(20),
});

export const WeaponsFileSchema = z.object({
  types: z.array(z.string()).length(4),
  typeNames: z.array(z.string()).length(4),
  rarityNames: z.array(z.string()).length(5),
  rarityColors: z.array(z.string()).length(5),
  defaults: z.array(z.object({ type: int.min(0).max(3) })).length(4),
  weapons: z
    .array(
      z.object({
        id: nonNegInt,
        type: int.min(0).max(3),
        name: z.string(),
        shortName: z.string().length(1),
        rarity: int.min(0).max(4),
        addAttPower: z.number(),
        fragmentsRequired: int.positive(),
        exclusive: z.unknown(),
        intro: z.string(),
        summary: z.string(),
      }),
    )
    .length(44),
  fragmentDrop: z.object({
    chancePerEnemy: z.number(),
    roundThresholds: z.array(nonNegInt).length(7),
    rarityWeightsByBracket: z.array(z.array(nonNegInt).length(5)).length(7),
  }),
  recycle: z.object({
    allowedRarities: z.array(nonNegInt),
    goldPerFragmentByRarity: z.array(int.positive()),
  }),
  unlockOnRegisterDay: int.positive(),
  starterTypeOrder: z.array(int.min(0).max(3)).length(4),
  equipSlots: z.literal(12),
});

export const RanksFileSchema = z.object({
  ranks: z
    .array(
      z.object({
        id: nonNegInt,
        name: z.string(),
        level: int.positive(),
        reward: nonNegInt,
        addHp: z.number().nonnegative(),
        aiWeaponRarityCount: z.array(nonNegInt).length(5),
        difficultyWeights: z.array(nonNegInt).length(4),
        mapLabel: z.string(),
      }),
    )
    .length(54),
  starsPerRank: z.literal(5),
  emperorStarBase: z.literal(250),
  emperorStages: z.array(int.positive()).length(3),
  opponent: z.object({
    groupStartRankIds: z.array(nonNegInt).length(4),
    starDiffRanges: z.array(z.tuple([int, int])).length(10),
    starDiffWeightsByGroup: z.array(z.array(nonNegInt).length(10)).length(4),
  }),
});

export const EconomyFileSchema = z.object({
  stamina: z.object({
    max: int.positive(),
    recoverIntervalMs: int.positive(),
    battleCost: int.positive(),
    videoReward: int.positive(),
    shareReward: int.positive(),
    shareDailyLimit: int.positive(),
    shareCooldownMs: int.positive(),
    marchPillReward: int.positive(),
  }),
  battleReward: z.object({ winGold: nonNegInt, loseGold: nonNegInt, earlySurrenderWave: int.positive() }),
  battleStart: z.object({ playerGold: nonNegInt, aiGold: nonNegInt, startCooldownMs: nonNegInt }),
  calendarZone: z.string(),
});

export const ManifestSchema = z.object({
  generator: z.string(),
  rulesetVersion: z.string(),
  sources: z.record(z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  counts: z.record(nonNegInt),
});
