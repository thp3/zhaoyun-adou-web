// 本機對手生成（原版 Pt.Yu）：依玩家段位抽難度與對手展示星數。用對局 seed 派生亂數，紀錄可重現。
// 這是本機產生的對手資料，不是真人配對。
import type { GameData } from '../../data';
import { createRng, nextInt, pickWeighted } from '../battle/rng';
import { starToRank } from './rank';

export interface OpponentSetup {
  difficulty: number;
  aiStar: number;
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
  return { difficulty, aiStar: Math.max(0, playerStar + diff) };
}
