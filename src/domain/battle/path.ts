// 道路尋路。原版 A* 雖寫了對角成本，但鄰點迴圈排除對角，實際只走上下左右；這裡直接用四方向。

export interface Cell {
  x: number;
  y: number;
}

/** 在 passable(x,y) 為真的格子上找最短四方向路徑（含起終點）；找不到回傳 null。 */
export function findPath(
  width: number,
  height: number,
  passable: (x: number, y: number) => boolean,
  start: Cell,
  goal: Cell,
): Cell[] | null {
  const key = (x: number, y: number) => y * width + x;
  const h = (x: number, y: number) => Math.abs(x - goal.x) + Math.abs(y - goal.y);
  const g = new Map<number, number>([[key(start.x, start.y), 0]]);
  const parent = new Map<number, number>();
  const open: { x: number; y: number; f: number; order: number }[] = [
    { x: start.x, y: start.y, f: h(start.x, start.y), order: 0 },
  ];
  const closed = new Set<number>();
  let order = 1;
  while (open.length > 0) {
    // f 最小優先；同 f 取較早加入者，結果確定
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[i]!;
      const b = open[best]!;
      if (a.f < b.f || (a.f === b.f && a.order < b.order)) best = i;
    }
    const cur = open.splice(best, 1)[0]!;
    const ck = key(cur.x, cur.y);
    if (closed.has(ck)) continue;
    if (cur.x === goal.x && cur.y === goal.y) {
      const path: Cell[] = [];
      let k: number | undefined = ck;
      while (k !== undefined) {
        path.push({ x: k % width, y: Math.floor(k / width) });
        k = parent.get(k);
      }
      return path.reverse();
    }
    closed.add(ck);
    for (const [dx, dy] of [
      [0, -1],
      [1, 0],
      [0, 1],
      [-1, 0],
    ] as const) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || !passable(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = g.get(ck)! + 1;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        parent.set(nk, ck);
        open.push({ x: nx, y: ny, f: ng + h(nx, ny), order: order++ });
      }
    }
  }
  return null;
}

export interface LaneMap {
  kind: number[][];
  camp: number[][];
  width: number;
  height: number;
  points: {
    playerEntry: Cell;
    playerPathStart: Cell;
    playerPathEnd: Cell;
    aiEntry: Cell;
    aiPathStart: Cell;
    aiPathEnd: Cell;
  };
}

/** 回傳某一方敵人流的格子路徑：外入口 → 起點 → … → 終點（阿斗）。只走該方陣營的道路。 */
export function lanePath(map: LaneMap, side: 0 | 1): Cell[] {
  const p = map.points;
  const [entry, start, end] =
    side === 0 ? [p.playerEntry, p.playerPathStart, p.playerPathEnd] : [p.aiEntry, p.aiPathStart, p.aiPathEnd];
  const road = (x: number, y: number) => map.kind[x]![y] === 0;
  const path =
    findPath(map.width, map.height, (x, y) => road(x, y) && map.camp[x]![y] === side, start, end) ??
    findPath(map.width, map.height, road, start, end);
  if (!path) throw new Error(`地圖沒有 ${side === 0 ? '玩家' : 'AI'} 方道路`);
  const same = entry.x === start.x && entry.y === start.y;
  return same ? path : [{ ...entry }, ...path];
}
