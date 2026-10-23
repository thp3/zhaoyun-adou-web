// 一次性資料抽取：把原版 1.0.9 的對照資料轉成本專案使用的固定 id JSON。
// 用法：node tools/extract/extract.mjs [--src D:/gathergame] [--out data]
// 輸出是確定性的（無時間戳），重跑結果應完全相同，方便以 git diff 檢查。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as OpenCC from 'opencc-js';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const SRC = resolve(argOf('--src', 'D:/gathergame'));
const OUT = resolve(argOf('--out', 'data'));

const SOURCES = {
  maps: '赵云与阿斗_1.0.9_全部遊戲邏輯/系統對照資料/四地圖定義.json',
  deck: '赵云与阿斗_1.0.9_全部遊戲邏輯/系統對照資料/牌庫與消耗.json',
  shop: '赵云与阿斗_1.0.9_全部遊戲邏輯/系統對照資料/商店輪盤經濟表.json',
  ranks: '赵云与阿斗_1.0.9_全部遊戲邏輯/系統對照資料/54段位配置.json',
  weaponImpl: '赵云与阿斗_1.0.9_全部遊戲邏輯/系統對照資料/全部武器實碼對照.json',
  weapons: '赵云与阿斗_1.0.9_還原程式碼/可讀腳本/tables/weapon.json',
  constants: '赵云与阿斗_1.0.9_還原程式碼/可讀腳本/tables/game_constants.json',
  skills: '赵云与阿斗_1.0.9_還原程式碼/可讀腳本/tables/skill_metadata.json',
};

const raw = {};
const sourceHashes = {};
for (const [key, rel] of Object.entries(SOURCES)) {
  const buf = readFileSync(join(SRC, rel));
  sourceHashes[key] = { path: rel, sha256: createHash('sha256').update(buf).digest('hex') };
  raw[key] = JSON.parse(buf.toString('utf8'));
}

const s2t = OpenCC.Converter({ from: 'cn', to: 'tw' });
// OpenCC 誤轉與原文錯字的修正（原文「范国」「井击倒」為發行包內的錯字）
const TEXT_FIXES = [
  ['禦敵', '御敵'],
  ['範國', '範圍'],
  ['井擊倒', '並擊倒'],
  ['硯臺', '硯台'],
  ['鉅鹿', '巨鹿'],
];
const tw = (s) => {
  if (typeof s !== 'string') return s;
  let out = s2t(s);
  for (const [from, to] of TEXT_FIXES) out = out.replaceAll(from, to);
  return out;
};
const C = raw.constants;
const constOf = (group) => C[group].values;

const fail = (msg) => {
  throw new Error(`[extract] ${msg}`);
};
const expectEq = (label, actual, expected) => {
  if (actual !== expected) fail(`${label}: 預期 ${expected}，實得 ${actual}`);
};

// ---------- 字牌 token ----------
// 內部一律用固定英文 id，顯示字另外存；避免「枪／槍」被當成兩種兵。
const TOKENS = [
  { id: 'blade', src: '刀', display: '刀', kind: 'soldier', soldierType: 0 },
  { id: 'bow', src: '弓', display: '弓', kind: 'soldier', soldierType: 1 },
  { id: 'spear', src: '枪', display: '槍', kind: 'soldier', soldierType: 2 },
  { id: 'cavalry', src: '骑', display: '騎', kind: 'soldier', soldierType: 3 },
  { id: 'shovel', src: '铲', display: '鏟', kind: 'tool' },
  { id: 'farmer', src: '农', display: '農', kind: 'farmer' },
  { id: 'zhao', src: '赵', display: '趙', kind: 'name', part: 'family' },
  { id: 'zhang', src: '张', display: '張', kind: 'name', part: 'family' },
  { id: 'ma', src: '马', display: '馬', kind: 'name', part: 'family' },
  { id: 'guan', src: '关', display: '關', kind: 'name', part: 'family' },
  { id: 'huang', src: '黄', display: '黃', kind: 'name', part: 'family' },
  { id: 'liu', src: '刘', display: '劉', kind: 'name', part: 'family' },
  { id: 'yun', src: '云', display: '雲', kind: 'name', part: 'given' },
  { id: 'fei', src: '飞', display: '飛', kind: 'name', part: 'given' },
  { id: 'chao', src: '超', display: '超', kind: 'name', part: 'given' },
  { id: 'yu', src: '羽', display: '羽', kind: 'name', part: 'given' },
  { id: 'zhong', src: '忠', display: '忠', kind: 'name', part: 'given' },
  { id: 'ping', src: '平', display: '平', kind: 'name', part: 'given' },
  { id: 'xing', src: '兴', display: '興', kind: 'name', part: 'given' },
  { id: 'bao', src: '苞', display: '苞', kind: 'name', part: 'given' },
  { id: 'yi', src: '翼', display: '翼', kind: 'name', part: 'given' },
  { id: 'gai', src: '盖', display: '蓋', kind: 'name', part: 'given' },
  { id: 'zu', src: '祖', display: '祖', kind: 'name', part: 'given' },
  { id: 'bei', src: '备', display: '備', kind: 'name', part: 'given' },
];
const tokenBySrc = new Map(TOKENS.map((t) => [t.src, t]));
const tokenIdOf = (src) => tokenBySrc.get(src)?.id ?? fail(`未知字牌「${src}」`);

const units = constOf('units');
// Gp：AI 對每個字的價值表（兵／農為各級價值）
const aiValue = new Map(units.Gp.mapEntries.map(([ch, v]) => [tokenIdOf(ch), v]));
const tokens = TOKENS.map(({ src, ...t }) => ({
  ...t,
  sourceText: src,
  aiValue: aiValue.get(t.id) ?? null,
}));

// ---------- 地圖 ----------
const POINT_KEYS = {
  $e: 'playerEntry',
  qe: 'playerPathStart',
  Ve: 'playerPathEnd',
  Qe: 'aiEntry',
  Ze: 'aiPathStart',
  Ke: 'aiPathEnd',
};
const MAP_KEYS = ['julu', 'yunmengze', 'hulaoguan', 'chibi'];
const maps = raw.maps.maps.map((m) => {
  const def = m.definition;
  expectEq(`地圖${m.id} 寬`, def.map.length, 8);
  const kind = def.map.map((col) => col.map((cell) => Number(cell.split('_')[0])));
  const camp = def.map.map((col) => col.map((cell) => Number(cell.split('_')[1])));
  for (const col of def.map) expectEq(`地圖${m.id} 高`, col.length, 10);
  const points = {};
  for (const [k, name] of Object.entries(POINT_KEYS)) points[name] = { x: def[k].x, y: def[k].y };
  return {
    id: m.id,
    key: MAP_KEYS[m.id],
    name: tw(m.name),
    width: 8,
    height: 10,
    // 索引方式與原版相同：kind[x][y]、camp[x][y]
    kind,
    camp,
    points,
    // Je：場景分界線端點（格座標，x 可為 8 表示右緣）
    divider: def.Je.map((p) => ({ x: p.x, y: p.y })),
    enemySet: def.ta,
  };
});
expectEq('地圖數', maps.length, 4);

const mapsOut = {
  tileSize: raw.maps.tile_pixel_size[0],
  tileKinds: { 0: 'road', 1: 'deploy', 2: 'expand' },
  camps: { 0: 'player', 1: 'ai' },
  rotation: {
    firstDay: raw.maps.first_day_rotation,
    firstDayGamesPerMap: raw.maps.first_day_games_per_map,
    weekdayMonToSun: raw.maps.weekday_rotation_mon_to_sun,
  },
  maps,
};

// ---------- 牌庫 ----------
const deckSrc = raw.deck.base_decks.te;
expectEq('牌庫張數', deckSrc.ordered_cards.length, 108);
for (const k of ['se', 'ie']) {
  if (JSON.stringify(raw.deck.base_decks[k].ordered_cards) !== JSON.stringify(deckSrc.ordered_cards)) {
    fail(`牌庫 ${k} 與 te 不同`);
  }
}
const deckOut = {
  baseDeck: deckSrc.ordered_cards.map(tokenIdOf),
  // 抽牌：在當前陣列均勻選；兵／鏟／農不移除，名字字移除。牌庫空時回退刀。
  nonConsumable: ['blade', 'bow', 'spear', 'cavalry', 'shovel', 'farmer'],
  emptyFallback: 'blade',
  recruit: {
    slots: raw.deck.recruit.slots,
    initialCost: raw.deck.recruit.initial_cost,
    costIncrement: raw.deck.recruit.cost_increment,
    refreshLockMs: 1000,
    playerStaggerMs: 100,
    playerFlyMs: 500,
  },
  // 前 3 局（roundDay<=3）：雙方各加 floor(玩家鏟數/5) 張鏟；難度 3 的 AI 另加 5 鏟
  earlyGameShovel: { maxRoundDay: 3, divisor: 5 },
  aiExtraShovelsByDifficulty: constOf('ai').ih,
  tutorial: {
    firstRefreshAvoid: ['huang', 'zhong'],
    firstRefreshMaxRetry: 30,
    firstRefreshFallback: 'blade',
    secondRefreshFixed: raw.deck.tutorial_fixed_refresh.map(tokenIdOf),
    aiDifficulty: 0,
    aiDamageMultiplier: 0.7,
  },
};

// ---------- 普通兵／農民 ----------
const SOLDIER_IDS = ['blade', 'bow', 'spear', 'cavalry'];
expectEq('普通兵種數', units._p.length, 4);
// 普通兵 1–5 級累積倍率由 Et.init 逐級連乘得到
const soldierLevelMult = [1, 1.5, 2.1, 2.73, 3.4125];
const soldiers = units._p.map((p, i) => ({
  id: SOLDIER_IDS[i],
  soldierType: i,
  damage: p.Sp,
  rangeCells: p.kp,
  intervalSec: p.xp,
  attackShape: { 单体: 'single', 贯穿: 'pierce', 范围: 'area' }[p.Mp] ?? fail(`未知攻擊型 ${p.Mp}`),
  targetRule: p.Pp,
}));
const farmer = constOf('farmer');
const unitsOut = {
  soldiers,
  soldierMaxLevel: 5,
  soldierLevelMultiplier: soldierLevelMult,
  farmer: {
    maxLevel: 5,
    periodMsByLevel: farmer.BP,
    goldPerHarvest: farmer.gold,
    crazy: { intervalMs: 1000, durationMs: 10000 },
    siltGoldMultiplier: 1.2,
  },
};

// ---------- 武將 ----------
const GENERAL_KEYS = [
  'zhaoyun', 'zhangfei', 'machao', 'guanyu', 'huangzhong', 'guanping',
  'guanxing', 'zhangbao', 'zhangyi', 'huanggai', 'liubei', 'huangzu',
];
// 具名技能（skill_metadata 的 symbol）與觸發攻擊次數，見戰鬥規格 5.2 表
const GENERAL_SKILLS = {
  zhaoyun: { skill: 'hn', triggerAttacks: 30 },
  zhangfei: { skill: 'Ca', triggerAttacks: 15, stunMs: 2000 },
  machao: { skill: 'Oa', triggerAttacks: 0 },
  guanyu: { skill: 'ta', triggerAttacks: 20 },
  huangzhong: { skill: 'Na', triggerAttacks: 30 },
  guanping: { skill: 'Ca', triggerAttacks: 15, stunMs: 1000 },
  guanxing: { skill: 'Oa', triggerAttacks: 0 },
  zhangbao: { skill: 'Oa', triggerAttacks: 0 },
  zhangyi: { skill: 'ta', triggerAttacks: 20 },
  huanggai: null,
  liubei: { skill: 'Ha', triggerAttacks: 20 },
  huangzu: { skill: 'qa', triggerAttacks: 30 },
};
expectEq('武將數', units.Gc.length, 12);
const generalValue = new Map(units.Xp.mapEntries);
const generals = units.Gc.map((name, i) => {
  const ap = units.Ap[i];
  const xc = units.Xc[i];
  if (xc.general !== name) fail(`Xc[${i}] 與 Gc 不一致`);
  const chars = units.Lp[i].map(tokenIdOf);
  return {
    id: i,
    key: GENERAL_KEYS[i],
    name: tw(name),
    chars,
    weaponType: xc.type,
    damage: ap.Sp,
    rangeCells: ap.kp,
    altRangeCells: ap.Ep,
    intervalSec: ap.xp,
    highTier: ap.Bp,
    maxLevel: ap.Bp ? 5 : 3,
    attackShape: ap.Mp,
    targetRule: ap.Pp,
    aiValue: generalValue.get(name) ?? fail(`缺 ${name} AI 價值`),
    skill: GENERAL_SKILLS[GENERAL_KEYS[i]],
  };
});
const skills = raw.skills.map((s) => ({ id: s.symbol, name: tw(s.skillName), description: tw(s.description) }));
const generalsOut = {
  generals,
  // 經驗門檻：高階組 Rp，普通組 Tp；餵字一律加 Rp[level]-Rp[level-1]
  expHighTier: units.Rp,
  expNormalTier: units.Tp,
  killCredit: { killerExp: 1, assistPoolByGeneral: 0.5, assistPoolByOther: 0.2 },
  skills,
};

// ---------- 敵人、波次、Boss ----------
const enemy = constOf('enemy');
const BOSSES = [
  ['zhangliang', '張梁'], ['zhangbao_boss', '張寶'], ['zhangjiao', '張角'],
  ['sunshangxiang', '孫尚香'], ['zhenmi', '甄宓'], ['diaochan', '貂蟬'],
  ['huaxiong', '華雄'], ['lvbu', '呂布'], ['dongzhuo', '董卓'],
  ['dianwei', '典韋'], ['xiahoudun', '夏侯惇'], ['caocao', '曹操'],
];
expectEq('Boss 數', enemy.ce.length, 12);
const bosses = enemy.ce.map((b, i) => ({
  id: i,
  key: BOSSES[i][0],
  name: BOSSES[i][1],
  mapId: Math.floor(i / 3),
  hpMultiplier: b.ne,
  speed: b.speed,
  rangeCells: b.ue,
  cooldownSec: b.pe,
  skillName: tw(b.skillName),
  skillIntro: tw(b.skillIntro),
  color: b.color,
}));
expectEq('波數', enemy.he.length, 20);
const wavesOut = {
  waveCount: 20,
  spawnCountByWave: enemy.he,
  spawnIntervalMs: 1500,
  intermissionMs: 5000,
  initialDelayMs: constOf('battle').delayTime,
  endlessExtraPerWave: 2,
  endlessHp: { base: 10, growth: 1.5 },
  // 每張地圖的普通敵人基礎 HP（依波次）與速度
  baseHpByMap: enemy.ae.map((a) => a.ne),
  speedByMap: enemy.ae.map((a) => a.speed),
  // 整局選一個血量策略，權重 [5,2,3]
  hpStrategies: enemy.fe,
  hpStrategyWeights: enemy.ye,
  // 累計局數 <10 且波 ≤10 時，依累計局數索引的新手係數
  rookieHpByRound: enemy.ee,
  puppetLevelHpMultiplier: enemy.ge,
  bossWaves: enemy.oe,
  bossChance: enemy.le,
  bossFragmentChance: 0.3,
  bosses,
  adou: { lives: constOf('battle').fh, attackCooldownMs: 500 },
};

// ---------- AI ----------
const ai = constOf('ai');
const aiOut = {
  decisionIntervalMs: [2000, 1500, 1000, 500],
  initialBonusGold: ai.Zi,
  waveBonusWaves: ai.Ki,
  waveBonusGoldByDifficulty: ai.Qi.map((row) => row[0]),
  expandChanceWhenBroke: ai.th,
  extraShovelsByDifficulty: ai.ih,
  lowDifficultyValueMult: [0.2, 0.3],
  minValueToDeploy: 2,
  replaceFactor: { soldier: 2, general: 3, scale: 0.1 },
  clusterPenalty: { radius: 3, factor: 0.62 },
  pathTrim: 0.15,
  propUseMinIntervalMs: 5000,
  // 尚未確認語義的原始常數，保留供 M3 對照
  unresolved: { Ji: ai.Ji, sh: ai.sh },
};

// ---------- 道具 ----------
const propConst = constOf('props');
expectEq('道具數', raw.shop.props.length, 25);
const items = raw.shop.props.map((p, i) => {
  const c = propConst.Ga[i];
  if (c.name !== p.name) fail(`道具 ${i} 名稱不一致`);
  return {
    id: p.id,
    key: p.name,
    name: tw(p.txt),
    intro: tw(c.intro),
    active: p.cooldown !== -1,
    cooldownMs: p.cooldown > 0 ? p.cooldown : p.cooldown === -1 ? null : 0,
    rarity: p.rarity,
    goldPrice: p.gold_price,
    lotteryInclusionWeight: p.lottery_inclusion_weight,
    lotteryWinWeight: p.lottery_win_weight,
    levels: p.upgrade_values
      ? p.upgrade_values.map((lv, k) => ({
          level: lv,
          promoteChancePct: c.Wa?.[k] ?? null,
          rarity: p.rarity_by_level[k],
          goldPrice: p.gold_price_by_level[k],
          lotteryInclusionWeight: p.lottery_inclusion_weight_by_level[k],
          lotteryWinWeight: p.lottery_win_weight_by_level[k],
        }))
      : null,
  };
});
const itemsOut = {
  capacity: raw.shop.capacity,
  shopItemsPerVisit: raw.shop.shop_items_per_visit,
  shopExcluded: ['shovel', 'bulldozer'],
  shopUnlockRankId: 1,
  staminaItem: 'marchPill',
  lotterySlots: raw.shop.lottery_slots,
  rarityNames: propConst.rn.map(tw),
  rarityColors: propConst.ln,
  // AI 開局道具數量 [min,max]，依 roundDay 截到 30 列；首日用 firstDay
  aiItemCountFirstDay: propConst.an,
  aiItemCountLater: propConst.nn,
  items,
};

// ---------- buff ----------
const BUFFS = [
  ['attPower', 'stat'], ['attSpeed', 'stat'], ['attRange', 'stat'], ['moveSpeed', 'stat'],
  ['maxHp', 'stat'], ['hp', 'stat'], ['scale', 'stat'], ['custom', 'custom'],
  ['stun', 'state'], ['fall', 'state'], ['pierce', 'state'], ['electrocute', 'state'],
  ['knockback', 'state'], ['chaos', 'state'], ['burnStatic', 'state'], ['limit', 'state'],
  ['lock', 'state'], ['knockdown', 'state'], ['suppression', 'state'], ['charm', 'state'],
];
const buffsOut = { buffs: BUFFS.map(([key, category], id) => ({ id, key, category })) };

// ---------- 武器 ----------
const weaponImpl = new Map(raw.weaponImpl.weapons.map((w) => [w.id, w]));
expectEq('武器數', raw.weapons.length, 44);
const weights = constOf('weaponWeights');
const weaponsOut = {
  types: ['bow', 'spear', 'blade', 'sword'],
  typeNames: ['弓', '槍', '刀', '劍'],
  rarityNames: weights.rn.map(tw),
  rarityColors: weights.ln,
  defaults: raw.weaponImpl.defaults.map((d) => ({ type: d.type })),
  weapons: raw.weapons.map((w) => {
    const name = tw(w.txt);
    // 簡稱取全名中對應位置的字，避免單字轉換脫離詞境（干→幹）
    const rare = w.rareTxt ?? w.txt.slice(0, 1);
    const idx = w.txt.indexOf(rare);
    return {
    id: w.id,
    type: w.type,
    name,
    shortName: idx >= 0 && name.length === w.txt.length ? name[idx] : tw(rare),
    rarity: w.rarity,
    addAttPower: w.addAttPower,
    fragmentsRequired: w.fragmentNum,
    exclusive: tw(weaponImpl.get(w.id)?.exclusive ?? null),
    intro: tw(w.intro),
    summary: weaponImpl.get(w.id)?.summary ?? '',
    };
  }),
  fragmentDrop: {
    chancePerEnemy: 0.065,
    roundThresholds: weights.iu,
    rarityWeightsByBracket: weights.hu,
  },
  recycle: { allowedRarities: [0, 1, 2], goldPerFragmentByRarity: [1, 2, 3] },
  unlockOnRegisterDay: 3,
  starterTypeOrder: [2, 1, 0, 3],
  equipSlots: 12,
};

// ---------- 段位 ----------
expectEq('段位數', raw.ranks.ranks.length, 54);
const ranksOut = {
  ranks: raw.ranks.ranks.map((r) => ({
    id: r.id,
    name: tw(r.rank),
    level: r.level,
    reward: r.reward,
    addHp: r.addHp,
    aiWeaponRarityCount: [r.weapon0, r.weapon1, r.weapon2, r.weapon3, r.weapon4],
    difficultyWeights: [r.difficulty0, r.difficulty1, r.difficulty2, r.difficulty3],
    mapLabel: tw(r.map),
  })),
  starsPerRank: 5,
  emperorStarBase: 250,
  emperorStages: [25, 50, 75],
  // 對手展示星數生成（Pt.Yu）：依玩家 rank.id 分組，選星差區間再均勻取整數
  opponent: {
    groupStartRankIds: [0, 5, 10, 15],
    starDiffRanges: [[-25, -21], [-20, -16], [-15, -11], [-10, -6], [-5, -1], [0, 5], [6, 10], [11, 15], [16, 20], [21, 25]],
    starDiffWeightsByGroup: [
      [0, 0, 0, 0, 10, 10, 0, 0, 0, 0],
      [0, 0, 2, 4, 10, 10, 5, 3, 0, 0],
      [0, 1, 2, 4, 10, 10, 5, 3, 2, 1],
      [1, 1, 2, 4, 10, 10, 6, 4, 3, 2],
    ],
  },
};

// ---------- 局外經濟與體力 ----------
const st = constOf('stamina');
const economyOut = {
  stamina: {
    max: st.$p,
    recoverIntervalMs: st.qp,
    battleCost: st.Vp,
    videoReward: st.Qp,
    shareReward: st.Jp,
    shareDailyLimit: st.sy,
    shareCooldownMs: st.iy,
    marchPillReward: 10,
  },
  battleReward: { winGold: 20, loseGold: 5, earlySurrenderWave: 5 },
  battleStart: {
    playerGold: constOf('battle').rh,
    aiGold: constOf('battle').rh + ai.Zi,
    startCooldownMs: 5000,
  },
  calendarZone: 'Asia/Taipei',
};

// ---------- 寫檔 ----------
mkdirSync(join(OUT, 'legacy'), { recursive: true });
const outputs = {
  'tokens.json': { tokens },
  'maps.json': mapsOut,
  'deck.json': deckOut,
  'units.json': unitsOut,
  'generals.json': generalsOut,
  'waves.json': wavesOut,
  'ai.json': aiOut,
  'items.json': itemsOut,
  'buffs.json': buffsOut,
  'weapons.json': weaponsOut,
  'ranks.json': ranksOut,
  'economy.json': economyOut,
  // 原版常數原樣保留（含尚未解讀的混淆欄位），只供後續里程碑查證
  'legacy/constants.json': C,
};
for (const [name, value] of Object.entries(outputs)) {
  writeFileSync(join(OUT, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}
const manifest = {
  generator: 'tools/extract/extract.mjs',
  rulesetVersion: 'web-ai-v1',
  sources: sourceHashes,
  counts: {
    tokens: tokens.length,
    maps: maps.length,
    deck: deckOut.baseDeck.length,
    soldiers: soldiers.length,
    generals: generals.length,
    skills: skills.length,
    bosses: bosses.length,
    waves: wavesOut.spawnCountByWave.length,
    items: items.length,
    buffs: buffsOut.buffs.length,
    weapons: weaponsOut.weapons.length,
    weaponDefaults: weaponsOut.defaults.length,
    ranks: ranksOut.ranks.length,
  },
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`[extract] 完成，輸出至 ${OUT}`);
console.table(manifest.counts);
