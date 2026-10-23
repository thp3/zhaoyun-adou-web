// 戰場繪製：純文字與幾何形狀，不載入任何圖片。只讀 World，不改狀態。
import type { GameData } from '../data';
import { CELL, type Actor, type BattleEvent, type World } from '../domain/battle/types';

export const BOARD_W = 640;
export const BOARD_H = 800;
export const BAR_H = 150;
export const VIEW_H = BOARD_H + BAR_H;
const SLOT_W = BOARD_W / 5;
const SLOT_PAD = 24;

export interface Palette {
  paper: string;
  paper2: string;
  ink: string;
  ink2: string;
  line: string;
  seal: string;
  sealInk: string;
  gold: string;
  road: string;
  deployOwn: string;
  deployAi: string;
  expand: string;
  ok: string;
  bad: string;
  unitText: string;
  unit: Record<string, string>;
}

export function readPalette(el: Element): Palette {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim() || '#888';
  return {
    paper: v('--paper'),
    paper2: v('--paper-2'),
    ink: v('--ink'),
    ink2: v('--ink-2'),
    line: v('--line'),
    seal: v('--seal'),
    sealInk: v('--seal-ink'),
    gold: v('--gold'),
    road: v('--road'),
    deployOwn: v('--deploy-own'),
    deployAi: v('--deploy-ai'),
    expand: v('--expand'),
    ok: v('--ok'),
    bad: v('--danger'),
    unitText: v('--u-text'),
    unit: {
      blade: v('--u-blade'),
      bow: v('--u-bow'),
      spear: v('--u-spear'),
      cavalry: v('--u-cavalry'),
      name: v('--u-name'),
      shovel: v('--u-shovel'),
    },
  };
}

export interface Effect {
  ev: BattleEvent;
  born: number;
}

export interface DragState {
  actorId: number;
  x: number;
  y: number;
  /** 目前懸停的落點與是否合法 */
  hover: { c: 'board'; x: number; y: number; ok: boolean } | { c: 'slot'; i: number; ok: boolean } | null;
}

export interface DrawOptions {
  data: GameData;
  palette: Palette;
  now: number;
  effects: Effect[];
  drag: DragState | null;
  showDamage: boolean;
}

const SERIF = "'Noto Serif TC','Songti TC','PMingLiU',serif";

export function slotRect(i: number) {
  return { x: i * SLOT_W + SLOT_PAD / 2, y: BOARD_H + 30, w: SLOT_W - SLOT_PAD, h: SLOT_W - SLOT_PAD };
}

export function drawBattle(ctx: CanvasRenderingContext2D, w: World, o: DrawOptions): void {
  const P = o.palette;
  ctx.fillStyle = P.paper;
  ctx.fillRect(0, 0, BOARD_W, VIEW_H);
  drawGrid(ctx, w, o);
  drawLaneMarks(ctx, w, o);

  for (const a of Object.values(w.actors)) {
    if (o.drag?.actorId === a.id) continue;
    if (a.loc.c === 'board') drawActor(ctx, a, a.loc.x * CELL + 6, a.loc.y * CELL + 6, CELL - 12, o, 1);
  }
  for (const e of Object.values(w.enemies)) drawEnemy(ctx, e.x, e.y, e.hp / e.maxHp, e.side === 0, o);
  ctx.strokeStyle = P.ink;
  ctx.lineWidth = 3;
  for (const p of Object.values(w.projectiles)) {
    const t = w.enemies[p.targetId];
    const ang = t ? Math.atan2(t.y - p.y, t.x - p.x) : 0;
    ctx.beginPath();
    ctx.moveTo(p.x - Math.cos(ang) * 12, p.y - Math.sin(ang) * 12);
    ctx.lineTo(p.x + Math.cos(ang) * 6, p.y + Math.sin(ang) * 6);
    ctx.stroke();
  }
  drawEffects(ctx, o);
  drawBar(ctx, w, o);

  if (o.drag) {
    const a = w.actors[o.drag.actorId];
    if (a) drawActor(ctx, a, o.drag.x - 34, o.drag.y - 34, 68, o, 0.9);
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, w: World, o: DrawOptions): void {
  const P = o.palette;
  for (let x = 0; x < w.kind.length; x++) {
    for (let y = 0; y < w.kind[x]!.length; y++) {
      const k = w.kind[x]![y];
      const own = w.camp[x]![y] === 0;
      const px = x * CELL;
      const py = y * CELL;
      ctx.fillStyle = k === 0 ? P.road : k === 1 ? (own ? P.deployOwn : P.deployAi) : P.expand;
      ctx.fillRect(px, py, CELL, CELL);
      ctx.strokeStyle = P.line;
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
      if (k === 2) {
        ctx.fillStyle = P.ink2;
        ctx.globalAlpha = 0.35;
        ctx.font = `28px ${SERIF}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('荒', px + CELL / 2, py + CELL / 2);
        ctx.globalAlpha = 1;
      }
      const hv = o.drag?.hover;
      if (hv && hv.c === 'board' && hv.x === x && hv.y === y) {
        ctx.strokeStyle = hv.ok ? P.ok : P.bad;
        ctx.lineWidth = 4;
        ctx.strokeRect(px + 3, py + 3, CELL - 6, CELL - 6);
      }
    }
  }
}

function drawLaneMarks(ctx: CanvasRenderingContext2D, w: World, o: DrawOptions): void {
  const P = o.palette;
  for (const side of [0, 1] as const) {
    const path = w.paths[side];
    const end = path[path.length - 1]!;
    const start = path[0]!;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `20px ${SERIF}`;
    ctx.fillStyle = P.ink2;
    ctx.fillText('入', start.x, start.y);
    // 阿斗
    ctx.fillStyle = side === 0 ? P.seal : P.ink2;
    roundRect(ctx, end.x - 26, end.y - 26, 52, 52, 8);
    ctx.fill();
    ctx.fillStyle = P.sealInk;
    ctx.font = `bold 30px ${SERIF}`;
    ctx.fillText('斗', end.x, end.y - 4);
    ctx.font = `13px sans-serif`;
    ctx.fillText(`×${Math.max(0, w.camps[side].lives)}`, end.x, end.y + 17);
  }
}

function tokenColor(a: Actor, P: Palette): string {
  if (a.kind === 'soldier') return P.unit[a.token] ?? P.ink2;
  return a.kind === 'shovel' ? P.unit.shovel! : P.unit.name!;
}

function drawActor(ctx: CanvasRenderingContext2D, a: Actor, x: number, y: number, size: number, o: DrawOptions, alpha: number): void {
  const P = o.palette;
  const tok = o.data.tokens.tokens.find((t) => t.id === a.token);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = tokenColor(a, P);
  roundRect(ctx, x, y, size, size, 10);
  ctx.fill();
  ctx.strokeStyle = a.side === 0 ? P.ink : P.ink2;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = P.unitText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(size * 0.55)}px ${SERIF}`;
  ctx.fillText(tok?.display ?? '?', x + size / 2, y + size / 2 - (a.kind === 'soldier' ? 4 : 0));
  if (a.kind === 'soldier') {
    // 等級以底部圓點表示
    const n = a.level;
    const r = Math.max(2.5, size * 0.045);
    const gap = r * 2.6;
    const sx = x + size / 2 - ((n - 1) * gap) / 2;
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.arc(sx + i * gap, y + size - r * 2.2, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawEnemy(ctx: CanvasRenderingContext2D, x: number, y: number, hpRatio: number, own: boolean, o: DrawOptions): void {
  const P = o.palette;
  // 對方防區的敵人淡化，與自己要防守的敵人區分
  ctx.globalAlpha = own ? 1 : 0.45;
  ctx.fillStyle = own ? P.ink : P.ink2;
  ctx.beginPath();
  ctx.arc(x, y, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = P.paper;
  ctx.font = `bold 18px ${SERIF}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('賊', x, y + 1);
  ctx.fillStyle = P.line;
  ctx.fillRect(x - 18, y - 27, 36, 5);
  ctx.fillStyle = hpRatio > 0.5 ? P.ok : hpRatio > 0.25 ? P.gold : P.bad;
  ctx.fillRect(x - 18, y - 27, 36 * Math.max(0, hpRatio), 5);
  ctx.globalAlpha = 1;
}

function drawEffects(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  const P = o.palette;
  for (const fx of o.effects) {
    const age = o.now - fx.born;
    const ev = fx.ev;
    if (ev.type === 'attack') {
      const life = 220;
      if (age > life) continue;
      ctx.globalAlpha = 1 - age / life;
      ctx.strokeStyle = P.seal;
      ctx.lineWidth = ev.kind === 'spear' ? 5 : 3;
      if (ev.kind === 'sweep') {
        ctx.beginPath();
        ctx.arc(ev.x, ev.y, (ev.r ?? 80) * (0.5 + age / life / 2), 0, Math.PI * 2);
        ctx.stroke();
      } else if (ev.kind !== 'arrow') {
        ctx.beginPath();
        ctx.moveTo(ev.x, ev.y);
        ctx.lineTo(ev.tx, ev.ty);
        ctx.stroke();
      }
    } else if (ev.type === 'damage' && o.showDamage) {
      const life = 600;
      if (age > life) continue;
      ctx.globalAlpha = 1 - age / life;
      ctx.fillStyle = P.seal;
      ctx.font = `bold 16px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(formatDamage(ev.amount), ev.x, ev.y - 30 - age / 25);
    } else if (ev.type === 'enemyDied') {
      const life = 500;
      if (age > life) continue;
      ctx.globalAlpha = 1 - age / life;
      ctx.fillStyle = P.gold;
      ctx.font = `bold 15px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(`+${ev.reward}`, ev.x, ev.y - age / 20);
    }
    ctx.globalAlpha = 1;
  }
}

function drawBar(ctx: CanvasRenderingContext2D, w: World, o: DrawOptions): void {
  const P = o.palette;
  ctx.fillStyle = P.paper2;
  ctx.fillRect(0, BOARD_H, BOARD_W, BAR_H);
  ctx.fillStyle = P.ink2;
  ctx.font = `14px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('征兵欄：拖到己方陣地部署；同字同級疊上去合成；鏟子拖到「荒」地開墾', 10, BOARD_H + 15);
  w.camps[0].slots.forEach((id, i) => {
    const r = slotRect(i);
    const hv = o.drag?.hover;
    ctx.strokeStyle = hv && hv.c === 'slot' && hv.i === i ? (hv.ok ? P.ok : P.bad) : P.line;
    ctx.lineWidth = hv && hv.c === 'slot' && hv.i === i ? 4 : 1.5;
    ctx.setLineDash([6, 4]);
    roundRect(ctx, r.x, r.y, r.w, r.h, 10);
    ctx.stroke();
    ctx.setLineDash([]);
    const a = id === null ? null : w.actors[id];
    if (!a || o.drag?.actorId === a.id) return;
    const incoming = a.loc.c === 'incoming';
    drawActor(ctx, a, r.x, r.y, r.w, o, incoming ? 0.35 : 1);
  });
}

function formatDamage(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '');
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
