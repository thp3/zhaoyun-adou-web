// 本機對手生成（原版 Pt.Yu）：依玩家段位抽難度與對手展示星數。用對局 seed 派生亂數，紀錄可重現。
// 這是本機產生的對手資料，不是真人配對。
import type { GameData } from '../../data';
import { generateAiItems } from '../battle/items';
import { createRng, nextFloat, nextInt, pickWeighted } from '../battle/rng';
import { starToRank } from './rank';

export interface OpponentSetup {
  difficulty: number;
  aiStar: number;
  /** AI 12 個武將槽的武器 id（-1 預設） */
  aiEquip: number[];
  /** AI 開局道具 */
  aiItems: { id: number; level: number }[];
}

export function generateOpponent(
  data: GameData,
  seed: number,
  playerStar: number,
  registerDay: number,
  roundOfDay: number,
): OpponentSetup {
  const rng = createRng(seed ^ 0x51ed);
  const rankId = starToRank(playerStar).rankId;
  const row = data.ranks.ranks[rankId]!;
  // 難度依玩家段位列的權重；註冊第 2 天起，每天第 1 局固定難度 1
  let difficulty = pickWeighted(rng, 'ai', row.difficultyWeights);
  if (registerDay >= 2 && roundOfDay === 1) difficulty = 1;

  const op = data.ranks.opponent;
  let group = 0;
  op.groupStartRankIds.forEach((start, i) => {
    if (rankId >= start) group = i;
  });
  const [lo, hi] = op.starDiffRanges[pickWeighted(rng, 'ai', op.starDiffWeightsByGroup[group]!)]!;
  const diff = lo + nextInt(rng, 'ai', hi - lo + 1);
  const aiStar = Math.max(0, playerStar + diff);

  // AI 配裝：依 AI 展示段位列的各稀有度件數抽武器，再配給同類型、尚未配裝的武將
  const aiRow = data.ranks.ranks[starToRank(aiStar).rankId]!;
  const aiEquip = new Array<number>(data.generals.generals.length).fill(-1);
  aiRow.aiWeaponRarityCount.forEach((count, rarity) => {
    for (let k = 0; k < count; k++) {
      const type = nextInt(rng, 'ai', data.weapons.types.length);
      const pool = data.weapons.weapons.filter((w) => w.type === type && w.rarity === rarity);
      if (pool.length === 0) continue;
      const weapon = pool[nextInt(rng, 'ai', pool.length)]!;
      const cands = data.generals.generals.filter((g) => g.weaponType === type && aiEquip[g.id] === -1);
      if (cands.length === 0) continue;
      aiEquip[cands[nextInt(rng, 'ai', cands.length)]!.id] = weapon.id;
    }
  });
  const aiItems = generateAiItems(data, () => nextFloat(rng, 'ai'), registerDay <= 1, roundOfDay);
  return { difficulty, aiStar, aiEquip, aiItems };
}
