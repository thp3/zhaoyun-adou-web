// AI 落點評分圖（原版 Mn）。只依地圖資料計算，不存進 World；同地圖同難度組結果固定，做記憶快取。
// 低難度（0/1，CG）：攻擊圓與 AI 路徑格相交的數量。
// 高難度（2/3，bG）：依路徑進度 p 加權，跳過前後 15%：單體 nearest 1.2p、closest_end p³、範圍 4p(1−p)。
import type { GameData } from '../../../data';
import { findPath, type Cell } from '../path';
import { CELL } from '../types';

/** key：普通兵 token id（blade/bow/spear/cavalry）或武將 key；值為 score[x][y]（AI 半場） */
export type ScoreMaps = Map<string, number[][]>;

const cache = new Map<string, ScoreMaps>();

/** 圓與矩形相交（原版 d.Si） */
function circleHitsRect(r: number, cx: number, cy: number, rx: number, ry: number, w: number, h: number): boolean {
  const nx = Math.max(rx, Math.min(cx, rx + w));
  const ny = Math.max(ry, Math.min(cy, ry + h));
  return (cx - nx) ** 2 + (cy - ny) ** 2 <= r * r;
}

/** 基礎地圖上的 AI 路徑（原版 Sa(map,false)：起點 → 終點，不含外入口） */
export function aiBasePath(data: GameData, mapId: number): Cell[] {
  const m = data.maps.maps[mapId]!;
  const road = (x: number, y: number) => m.kind[x]![y] === 0;
  const p = m.points;
  return (
    findPath(m.width, m.height, (x, y) => road(x, y) && m.camp[x]![y] === 1, p.aiPathStart, p.aiPathEnd) ??
    findPath(m.width, m.height, road, p.aiPathStart, p.aiPathEnd) ??
    []
  );
}

/** 該格可作為 AI 單位（寬 d 格）的左端：本身與右端都是 AI 的可部署或待開墾地（原版 UG） */
function footprintOk(kind: number[][], camp: number[][], x: number, y: number, d: number): boolean {
  const ok = (cx: number) => cx < kind.length && (kind[cx]![y] === 1 || kind[cx]![y] === 2) && camp[cx]![y] === 1;
  return ok(x) && (d <= 1 || (x + d <= kind.length && ok(x + d - 1)));
}

export function scoreMaps(data: GameData, mapId: number, lowDifficulty: boolean): ScoreMaps {
  const key = `${mapId}_${lowDifficulty ? 's' : 'f'}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const m = data.maps.maps[mapId]!;
  const half = m.height / 2;
  const path = aiBasePath(data, mapId);
  const n = path.length;
  const denom = n > 1 ? n - 1 : 1;
  const weight = { single: [] as number[], end: [] as number[], group: [] as number[] };
  for (let a = 0; a < n; a++) {
    const t = a / denom;
    const out = t < 0.15 || t > 0.85;
    weight.single[a] = out ? 0 : 1.2 * t;
    weight.end[a] = out ? 0 : t * t * t;
    weight.group[a] = out ? 0 : 4 * t * (1 - t);
  }

  const units: { key: string; range: number; width: number; rule: string; shape: string }[] = [
    ...data.units.soldiers.map((s) => ({
      key: s.id,
      range: s.rangeCells,
      width: 1,
      rule: s.targetRule,
      shape: s.attackShape === 'area' ? 'area' : 'single',
    })),
    ...data.generals.generals.map((g) => ({
      key: g.key,
      range: g.rangeCells,
      width: g.chars.length,
      rule: g.targetRule,
      shape: g.attackShape === '范围' ? 'area' : 'single',
    })),
  ];

  const maps: ScoreMaps = new Map();
  for (const u of units) {
    const r = u.range * CELL;
    const w = u.shape === 'area' ? weight.group : u.rule === 'closest_end' ? weight.end : weight.single;
    const grid: number[][] = [];
    for (let x = 0; x < m.width; x++) {
      grid.push([]);
      const cx = x * CELL + CELL / 2;
      for (let y = 0; y < half; y++) {
        if (!footprintOk(m.kind, m.camp, x, y, u.width)) {
          grid[x]!.push(0);
          continue;
        }
        const cy = y * CELL + CELL / 2;
        let score = 0;
        for (let i = 0; i < n; i++) {
          const c = path[i]!;
          if (!circleHitsRect(r, cx, cy, c.x * CELL, c.y * CELL, CELL, CELL)) continue;
          score += lowDifficulty ? 1 : w[i]!;
        }
        grid[x]!.push(score);
      }
    }
    maps.set(u.key, grid);
  }
  cache.set(key, maps);
  return maps;
}

/** 某格對所有單位的最高分（原版 YG） */
export function bestScoreAt(maps: ScoreMaps, x: number, y: number): number {
  let best = 0;
  for (const g of maps.values()) {
    const v = g[x]?.[y];
    if (v != null && v > best) best = v;
  }
  return best;
}

/** 指定單位的分數，沒有該單位的圖時用全單位最高分（原版 OG） */
export function scoreFor(maps: ScoreMaps, key: string | null, x: number, y: number): number {
  const v = key ? maps.get(key)?.[x]?.[y] : undefined;
  return v ?? bestScoreAt(maps, x, y);
}
