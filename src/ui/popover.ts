// 浮窗貼著目標擺放：純函式，座標系由呼叫端決定（對局畫面用畫布的 CSS 像素）。

export type Rect = { x: number; y: number; w: number; h: number };

const GAP = 8;

/** 候選位置依序：目標右、左、上、下；副軸對齊目標中心 */
const SIDES: ((t: Rect, w: number, h: number) => { left: number; top: number })[] = [
  (t, _w, h) => ({ left: t.x + t.w + GAP, top: t.y + (t.h - h) / 2 }),
  (t, w, h) => ({ left: t.x - GAP - w, top: t.y + (t.h - h) / 2 }),
  (t, w, h) => ({ left: t.x + (t.w - w) / 2, top: t.y - GAP - h }),
  (t, w, _h) => ({ left: t.x + (t.w - w) / 2, top: t.y + t.h + GAP }),
];

/**
 * 大小 w×h 的浮窗在 bw×bh 範圍內的位置。每個候選先夾回範圍內，
 * 夾完仍不蓋到目標就採用（副軸被夾不算失敗，貼邊的單位也能放旁邊）；
 * 都不行時放在左右較寬的一側。
 */
export function placeBeside(target: Rect, w: number, h: number, bw: number, bh: number): { left: number; top: number } {
  const clampIn = (p: { left: number; top: number }) => ({
    left: Math.round(Math.max(0, Math.min(p.left, bw - w))),
    top: Math.round(Math.max(0, Math.min(p.top, bh - h))),
  });
  const covers = (p: { left: number; top: number }) =>
    p.left < target.x + target.w && p.left + w > target.x && p.top < target.y + target.h && p.top + h > target.y;
  for (const side of SIDES) {
    const p = clampIn(side(target, w, h));
    if (!covers(p)) return p;
  }
  const roomRight = bw - target.x - target.w;
  return clampIn(SIDES[roomRight >= target.x ? 0 : 1]!(target, w, h));
}
