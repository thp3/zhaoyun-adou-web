// 星數 ↔ 段位（原版 H.sr / H.ir）。id 0–49 每階 5 星；超過 250 星為皇帝四階，level 直接等於皇帝星數。

export interface RankPosition {
  rankId: number;
  level: number;
}

const STARS_PER_RANK = 5;
const EMPEROR_BASE = 250;

export function starToRank(curStar: number): RankPosition {
  if (curStar <= 0) return { rankId: 0, level: 1 };
  if (curStar <= EMPEROR_BASE) {
    const rankId = Math.floor((curStar - 1) / STARS_PER_RANK);
    return { rankId, level: curStar - rankId * STARS_PER_RANK };
  }
  const a = Math.max(1, curStar - EMPEROR_BASE);
  const rankId = a <= 25 ? 50 : a <= 50 ? 51 : a <= 75 ? 52 : 53;
  return { rankId, level: a };
}

export function rankToStar(pos: RankPosition): number {
  if (pos.rankId <= 49) return STARS_PER_RANK * pos.rankId + pos.level;
  return EMPEROR_BASE + Math.max(1, pos.level);
}
