// 原版 AI（In/En/Bn/Pn）的五階段決策。每到難度對應的決策間隔做一步，所有落子都走與玩家相同的 applyCommand。
// stage 1 征兵（沒錢時極低機率免費擴地）→ 2 逐個處理 5 個刷新欄 → 3 掃盤面合成並收集名字字
// → 4 配字、依價值排序、規劃佈局 → 5 每步搬一個單位到規劃位置 → 回 1。
import type { GameData } from '../../../data';
import { applyCommand, removeActor } from '../commands';
import { aiUseItem } from '../items';
import { nextFloat, nextInt } from '../rng';
import { TICK_MS, type Actor, type BattleCommand, type StepContext, type World } from '../types';
import { aiBasePath, bestScoreAt, scoreFor, scoreMaps, type ScoreMaps } from './scoring';

const AI = 1 as const;
const SINGLE_ORDER = ['blade', 'cavalry', 'spear', 'bow'];
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

interface Cell {
  x: number;
  y: number;
}

class AiContext {
  readonly data: GameData;
  readonly maps: ScoreMaps;
  readonly path: Cell[];
  readonly width: number;
  readonly half: number;

  constructor(
    readonly w: World,
    readonly ctx: StepContext,
  ) {
    this.data = ctx.data;
    this.maps = scoreMaps(ctx.data, w.mapId, w.difficulty < 2);
    this.path = aiBasePath(ctx.data, w.mapId);
    this.width = w.kind.length;
    this.half = w.kind[0]!.length / 2;
  }

  get diff(): number {
    return this.w.difficulty;
  }

  rand(): number {
    return nextFloat(this.w.rng, 'ai');
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = nextInt(this.w.rng, 'ai', i + 1);
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }

  cmd(c: BattleCommand): boolean {
    return applyCommand(this.w, c, this.ctx).ok;
  }

  moveTo(a: Actor, x: number, y: number): boolean {
    return this.cmd({ type: 'MOVE', side: AI, actorId: a.id, to: { c: 'board', x, y } });
  }

  /** AI 半場（y < 高度一半）上的 actor */
  boardAt(x: number, y: number): Actor | undefined {
    const id = this.w.board[x]?.[y];
    const a = id == null ? undefined : this.w.actors[id];
    return a && a.side === AI ? a : undefined;
  }

  isDeploy(x: number, y: number): boolean {
    return this.w.kind[x]?.[y] === 1 && this.w.camp[x]?.[y] === AI;
  }

  /** 原版 Gp：普通兵依等級、名字字固定值 */
  value(a: Actor): number {
    const v = this.data.tokens.tokens.find((t) => t.id === a.token)?.aiValue ?? [0];
    return v[Math.min(v.length - 1, a.level - 1)] ?? 0;
  }

  /** 原版 lX：可配成角色的其他字，在基礎牌庫張數＋AI 現有名字字數的總和 */
  partnerPotential(token: string): number {
    const partners = new Set<string>();
    for (const g of this.data.generals.generals) if (g.chars.includes(token)) for (const c of g.chars) if (c !== token) partners.add(c);
    let n = 0;
    for (const p of partners) {
      n += this.data.deck.baseDeck.filter((t) => t === p).length;
      for (const a of Object.values(this.w.actors)) if (a.side === AI && a.kind === 'name' && a.token === p) n += 1;
    }
    return n;
  }

  /** 原版 rX：名字字價值；低難度再打折 */
  nameValue(a: Actor): number {
    const pot = this.partnerPotential(a.token);
    let v = pot > 0 ? this.value(a) + pot : 0;
    if (this.diff < 2) v *= this.data.ai.lowDifficultyValueMult[this.diff]!;
    return v;
  }

  roadNeighbors(x: number, y: number): number {
    return DIRS.filter(([dx, dy]) => this.w.kind[x + dx]?.[y + dy] === 0 && this.w.camp[x + dx]?.[y + dy] === AI).length;
  }

  /** 到 AI 路徑中段（15%–85%）的最短曼哈頓距離 */
  distToMidPath(x: number, y: number): number {
    const n = this.path.length;
    if (n === 0) return 1e9;
    const from = Math.floor(this.data.ai.pathTrim * n);
    const to = Math.min(n, Math.ceil((1 - this.data.ai.pathTrim) * n));
    let best = 1e9;
    for (let i = from; i < to; i++) best = Math.min(best, Math.abs(x - this.path[i]!.x) + Math.abs(y - this.path[i]!.y));
    return best;
  }

  /** 原版 hX：找可部署空格並依難度排序 */
  freeDeployCells(key: string | null): Cell[] {
    const cells: Cell[] = [];
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.half; y++) if (this.isDeploy(x, y) && this.w.board[x]![y] == null) cells.push({ x, y });
    }
    if (cells.length === 0 || this.diff < 2) return this.shuffle(cells);
    const rows = cells.map((c) => ({
      c,
      road: this.roadNeighbors(c.x, c.y),
      dist: this.distToMidPath(c.x, c.y),
      score: this.diff === 3 ? scoreFor(this.maps, key, c.x, c.y) : 0,
    }));
    rows.sort((a, b) =>
      this.diff === 2
        ? b.road - a.road || a.dist - b.dist
        : b.score - a.score || b.road - a.road || a.dist - b.dist,
    );
    if (this.diff === 2 && rows.length > 3) {
      const head = this.shuffle(rows.splice(0, Math.min(5, rows.length)));
      rows.unshift(...head);
    }
    return rows.map((r) => r.c);
  }

  /** 原版 Pn.XG：選要開墾的 AI 待開墾格 */
  expandTargets(count: number): Cell[] {
    const cands: Cell[] = [];
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.w.kind[x]!.length; y++) {
        if (this.w.kind[x]![y] === 2 && this.w.camp[x]![y] === AI && this.w.board[x]![y] == null) cands.push({ x, y });
      }
    }
    if (cands.length === 0 || count <= 0) return [];
    if (this.diff <= 1) return this.shuffle(cands).slice(0, count);
    const rows = cands.map((c) => ({
      c,
      road: this.roadNeighbors(c.x, c.y),
      dist: this.distToMidPath(c.x, c.y),
      // 難度 3：開墾後相鄰可部署格的最高分（原版 GG）
      near: Math.max(0, ...DIRS.filter(([dx, dy]) => this.isDeploy(c.x + dx, c.y + dy)).map(([dx, dy]) => bestScoreAt(this.maps, c.x + dx, c.y + dy))),
    }));
    rows.sort((a, b) => (this.diff === 3 ? b.near - a.near || b.road - a.road : b.road - a.road || a.dist - b.dist));
    return rows.slice(0, count).map((r) => r.c);
  }

  recycle(a: Actor): void {
    removeActor(this.w, a);
    this.ctx.events.push({ type: 'recycled', actorId: a.id, side: AI });
  }

  /** 原版 iX：在盤面找可合成（兵同字同級）或可餵字（同字已成形武將）的目標並執行 */
  tryCombine(a: Actor): boolean {
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.half; y++) {
        const b = this.boardAt(x, y);
        if (!b || b.id === a.id) continue;
        if (a.kind === 'name') {
          if (this.diff < 2) return false;
          if (b.token === a.token && b.generalId !== null) {
            const g = this.w.generals[b.generalId];
            if (g && g.level !== 5) this.moveTo(a, x, y);
            else if (a.loc.c === 'board') this.recycle(a);
            return true;
          }
        } else if (a.kind === 'soldier') {
          if (b.kind === 'soldier' && b.token === a.token && b.level === a.level) {
            this.moveTo(a, x, y);
            return true;
          }
        }
      }
    }
    return false;
  }

  /** 原版 nX：盤面上是否已有能和這個名字字搭配的字（姓找同姓、名找其姓） */
  hasMateOnBoard(a: Actor): boolean {
    if (this.diff < 2) return false;
    const defs = this.data.generals.generals;
    const isFamily = defs.some((g) => g.chars[0] === a.token);
    const wanted = isFamily ? [a.token] : defs.filter((g) => g.chars[1] === a.token).map((g) => g.chars[0]!);
    if (wanted.length === 0) return false;
    for (let x = 0; x < this.width; x++) for (let y = 0; y < this.half; y++) if (wanted.includes(this.boardAt(x, y)?.token ?? '')) return true;
    return false;
  }

  /** 原版 oX：沒有空格時，以機率換掉盤面上價值最低的單位 */
  tryReplace(a: Actor, incomingValue: number): void {
    let min: Actor | null = null;
    let minValue = 100;
    for (let x = 0; x < this.width; x++) {
      for (let y = 0; y < this.half; y++) {
        const b = this.boardAt(x, y);
        if (!b || !this.isDeploy(x, y)) continue;
        let v: number;
        if (b.kind === 'name') {
          const pot = this.partnerPotential(b.token);
          v = pot > 0 ? this.value(b) + pot : 0;
        } else v = this.value(b);
        if (v < minValue) {
          min = b;
          minValue = v;
        }
      }
    }
    if (!min || min.loc.c !== 'board') return;
    const factor = min.kind === 'soldier' ? this.data.ai.replaceFactor.soldier : this.data.ai.replaceFactor.general;
    if (this.rand() < (incomingValue - minValue) * factor * this.data.ai.replaceFactor.scale) this.moveTo(a, min.loc.x, min.loc.y);
  }
}

// ---------------- 各階段 ----------------

function stage1(c: AiContext): void {
  const { w } = c;
  const camp = w.camps[AI];
  if (camp.gold >= camp.recruitCost) {
    c.cmd({ type: 'RECRUIT', side: AI });
    w.ai.slotCursor = 0;
    w.ai.stage = 2;
    return;
  }
  if (c.rand() <= c.data.ai.expandChanceWhenBroke[c.diff]!) {
    // 每局一次免費開墾 2 格（原版 VX）
    if (w.ai.usedFreeExpand) return;
    w.ai.usedFreeExpand = true;
    for (const t of c.expandTargets(2)) {
      w.kind[t.x]![t.y] = 1;
      c.ctx.events.push({ type: 'expanded', x: t.x, y: t.y });
    }
    return;
  }
  // 原版 KO：沒錢時使用主動道具
  aiUseItem(w, c.ctx);
}

function stage2(c: AiContext): void {
  const { w } = c;
  const slots = w.camps[AI].slots;
  while (w.ai.slotCursor < slots.length) {
    const id = slots[w.ai.slotCursor++];
    const a = id == null ? undefined : w.actors[id];
    if (!a || a.loc.c !== 'slot') continue;
    if (a.kind === 'shovel') {
      const t = c.expandTargets(1)[0];
      if (!t) continue;
      c.moveTo(a, t.x, t.y);
      break;
    }
    if (a.kind === 'soldier') {
      if (!c.tryCombine(a)) {
        const cell = c.freeDeployCells(a.token)[0];
        if (cell) c.moveTo(a, cell.x, cell.y);
      }
      break;
    }
    // 名字字
    if (c.hasMateOnBoard(a)) {
      c.tryCombine(a);
      break;
    }
    const v = c.nameValue(a);
    const cell = c.freeDeployCells(a.token)[0];
    if (cell) {
      if (!(c.diff < 2 && v < c.data.ai.minValueToDeploy)) c.moveTo(a, cell.x, cell.y);
    } else c.tryReplace(a, v);
    break;
  }
  if (w.ai.slotCursor >= slots.length) {
    w.ai.names = [];
    w.ai.scanCursor = [0, 0];
    w.ai.stage = 3;
  }
}

function stage3(c: AiContext): void {
  const { w } = c;
  const cur = w.ai.scanCursor;
  if (cur[0] >= c.width) {
    w.ai.stage = 4;
    return;
  }
  let first = true;
  for (let x = cur[0]; x < c.width; x++) {
    const y0 = first ? cur[1] : 0;
    first = false;
    for (let y = y0; y < c.half; y++) {
      w.ai.scanCursor = y + 1 >= c.half ? [x + 1, 0] : [x, y + 1];
      const a = c.boardAt(x, y);
      if (!a) continue;
      if (c.tryCombine(a)) return;
      if (a.kind === 'name') w.ai.names.push(a.id);
    }
  }
}

type PlanItem = Actor[] | Actor;

function stage4(c: AiContext): void {
  const { w, data } = c;
  const names = w.ai.names.map((id) => w.actors[id]).filter((a): a is Actor => !!a && a.loc.c !== 'incoming');
  // 配字（原版 fX）：依價值高到低，姓找第一個可配的名；同一個姓多出來的名回收
  names.sort((a, b) => c.value(b) - c.value(a));
  const pairs: Actor[][] = [];
  for (let s = 0; s < names.length; s++) {
    const fam = names[s]!;
    const givens = data.generals.generals.filter((g) => g.chars[0] === fam.token).map((g) => g.chars[1]!);
    if (givens.length === 0) continue;
    let paired = false;
    for (const e of givens) {
      const i = names.findIndex((n) => n.token === e);
      if (i < 0) continue;
      if (paired) {
        c.recycle(names[i]!);
        names.splice(i, 1);
        if (i <= s) s -= 1;
      } else {
        pairs.push([fam, names[i]!]);
        const famIdx = s;
        names.splice(i, 1);
        const fi = i < famIdx ? famIdx - 1 : famIdx;
        names.splice(fi, 1);
        s = fi - 1;
        paired = true;
      }
    }
  }
  // 排序（原版 LX）：武將組合依價值，再依 刀／騎／槍／弓 加入盤面上的普通兵
  const items: PlanItem[] = pairs
    .map((p) => {
      const def = data.generals.generals.find((g) => g.chars[0] === p[0]!.token && g.chars[1] === p[1]!.token);
      return { p, v: def?.aiValue ?? 10 };
    })
    .sort((a, b) => b.v - a.v)
    .map((x) => x.p);
  for (const tok of SINGLE_ORDER) {
    for (let x = 0; x < c.width; x++) for (let y = 0; y < c.half; y++) {
      const a = c.boardAt(x, y);
      if (a?.kind === 'soldier' && a.token === tok) items.push(a);
    }
  }
  // 佈局（原版 wX）：逐項找分數最高且未被規劃的格；難度 ≥2 對鄰近格打折避免擠在一起
  const plan = w.ai.plan;
  for (const col of plan) col.fill(null);
  const penalty = Array.from({ length: c.width }, () => new Array<number>(c.half).fill(1));
  const { radius, factor } = data.ai.clusterPenalty;
  for (const item of items) {
    const isPair = Array.isArray(item);
    const key = isPair ? (data.generals.generals.find((g) => g.chars[0] === item[0]!.token && g.chars[1] === item[1]!.token)?.key ?? '') : item.token;
    const grid = c.maps.get(key);
    if (!grid) continue;
    const best = { x: 0, y: 0, value: -1 };
    for (let x = 0; x < c.width; x++) {
      for (let y = 0; y < c.half; y++) {
        if (!c.isDeploy(x, y) || plan[x]![y] != null) continue;
        const v = grid[x]![y]! * penalty[x]![y]!;
        if (v <= best.value) continue;
        if (isPair) {
          let okCells = 0;
          for (let k = 1; k < item.length; k++) if (x + k < c.width && c.isDeploy(x + k, y) && plan[x + k]![y] == null) okCells++;
          if (okCells === item.length - 1) Object.assign(best, { x, y, value: v });
        } else Object.assign(best, { x, y, value: v });
      }
    }
    if (best.value < 0) continue;
    if (isPair) item.forEach((a, k) => (plan[best.x + k]![best.y] = a.id));
    else plan[best.x]![best.y] = item.id;
    if (c.diff >= 2) {
      for (let x = 0; x < c.width; x++) for (let y = 0; y < c.half; y++) {
        if (Math.abs(x - best.x) + Math.abs(y - best.y) <= radius) penalty[x]![y]! *= factor;
      }
    }
  }
  w.ai.moveCursor = [0, 0];
  w.ai.stage = 5;
}

function stage5(c: AiContext): void {
  const { w } = c;
  const cur = w.ai.moveCursor;
  if (cur[0] >= c.width) {
    w.ai.stage = 1;
    return;
  }
  let first = true;
  for (let x = cur[0]; x < c.width; x++) {
    const y0 = first ? cur[1] : 0;
    first = false;
    for (let y = y0; y < c.half; y++) {
      w.ai.moveCursor = y + 1 >= c.half ? [x + 1, 0] : [x, y + 1];
      const id = w.ai.plan[x]![y];
      if (id == null) continue;
      const a = w.actors[id];
      if (!a || a.loc.c === 'incoming') {
        w.ai.plan[x]![y] = null;
        continue;
      }
      if (w.board[x]![y] !== id) {
        c.moveTo(a, x, y);
        return;
      }
    }
  }
}

/** 每 tick 呼叫；到決策間隔才做一步 */
export function updateAi(w: World, ctx: StepContext): void {
  if (!w.aiEnabled || w.result) return;
  w.ai.timer += 1;
  if (w.ai.timer * TICK_MS < ctx.data.ai.decisionIntervalMs[w.difficulty]!) return;
  w.ai.timer = 0;
  const c = new AiContext(w, ctx);
  switch (w.ai.stage) {
    case 1:
      return stage1(c);
    case 2:
      return stage2(c);
    case 3:
      return stage3(c);
    case 4:
      return stage4(c);
    case 5:
      return stage5(c);
  }
}

/** 波次補助：第 3/5/8/11/14/17 波開始時依難度給 AI 戰鬥資金 */
export function aiWaveBonus(w: World, wave: number, data: GameData): void {
  if (!w.aiEnabled) return;
  const i = data.ai.waveBonusWaves.indexOf(wave);
  if (i >= 0) w.camps[AI].gold += data.ai.waveBonusGoldByDifficulty[w.difficulty]!;
}

