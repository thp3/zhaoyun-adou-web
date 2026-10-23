// 可序列化的亂數流（mulberry32）。狀態只是一個 uint32，存進快照即可完整還原。

export type RngStream = 'deck' | 'combat' | 'ai';
export type RngState = Record<RngStream, number>;

export function nextFloat(rng: RngState, stream: RngStream): number {
  let t = (rng[stream] + 0x6d2b79f5) >>> 0;
  rng[stream] = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** [0, n) 均勻整數 */
export function nextInt(rng: RngState, stream: RngStream, n: number): number {
  return Math.floor(nextFloat(rng, stream) * n);
}

/** 依權重選索引；權重總和必須 > 0 */
export function pickWeighted(rng: RngState, stream: RngStream, weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new Error('權重總和必須大於 0');
  let r = nextFloat(rng, stream) * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!;
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/** 由一個 seed 派生三條互不相干的亂數流 */
export function createRng(seed: number): RngState {
  const mix = (k: number) => (Math.imul(seed ^ k, 0x9e3779b1) >>> 0) || 1;
  return { deck: mix(0x1234), combat: mix(0x5678), ai: mix(0x9abc) };
}
