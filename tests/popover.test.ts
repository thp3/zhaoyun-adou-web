import { describe, expect, it } from 'vitest';
import { placeBeside, type Rect } from '../src/ui/popover';

const BW = 360;
const BH = 534;
const W = 150;
const H = 100;

const overlaps = (t: Rect, p: { left: number; top: number }) =>
  p.left < t.x + t.w && p.left + W > t.x && p.top < t.y + t.h && p.top + H > t.y;
const inside = (p: { left: number; top: number }) => p.left >= 0 && p.top >= 0 && p.left + W <= BW && p.top + H <= BH;

describe('placeBeside', () => {
  it('放在左側有空間的單位右邊，垂直對齊單位', () => {
    const t = { x: 20, y: 200, w: 45, h: 45 };
    expect(placeBeside(t, W, H, BW, BH)).toEqual({ left: 73, top: 173 });
  });

  it('右邊放不下時改放左邊', () => {
    const t = { x: 290, y: 200, w: 45, h: 45 };
    const p = placeBeside(t, W, H, BW, BH);
    expect(p.left + W).toBeLessThanOrEqual(t.x - 8);
    expect(inside(p)).toBe(true);
  });

  it('貼頂的單位：垂直方向夾回範圍內，仍放在旁邊', () => {
    const t = { x: 20, y: 0, w: 45, h: 45 };
    const p = placeBeside(t, W, H, BW, BH);
    expect(p.top).toBe(0);
    expect(overlaps(t, p)).toBe(false);
  });

  it('整排武將太寬時改放上方或下方', () => {
    const t = { x: 45, y: 300, w: 270, h: 45 };
    const p = placeBeside(t, W, H, BW, BH);
    expect(p.top + H).toBeLessThanOrEqual(t.y - 8);
    expect(inside(p)).toBe(true);
  });

  it('四邊都放不下時仍留在範圍內', () => {
    const t = { x: 0, y: 0, w: BW, h: BH };
    expect(inside(placeBeside(t, W, H, BW, BH))).toBe(true);
  });
});
