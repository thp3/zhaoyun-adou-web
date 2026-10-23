// 戰場繪製：純文字與幾何形狀，不載入任何圖片。只讀 World，不改狀態。
import type { GameData } from '../data';
import { CELL, type Actor, type BattleEvent, type Enemy, type General, type World } from '../domain/battle/types';

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
  for (const g of Object.values(w.generals)) drawGeneral(ctx, w, g, o);
  for (const a of Object.values(w.actors)) if (a.loc.c === 'board' && o.drag?.actorId !== a.id) drawUnitStatus(ctx, w, a, o);
  for (const e of Object.values(w.enemies)) drawEnemy(ctx, w, e, o);
  drawSkillEntities(ctx, w, o);
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
  drawBlind(ctx, w);
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

/** 已成形武將：在組成字外框一個跨格的印框，標名字與等級 */
function drawGeneral(ctx: CanvasRenderingContext2D, w: World, g: General, o: DrawOptions): void {
  const first = w.actors[g.partIds[0]!];
  if (!first || first.loc.c !== 'board') return;
  const P = o.palette;
  const def = o.data.generals.generals[g.type]!;
  const x = first.loc.x * CELL + 3;
  const y = first.loc.y * CELL + 3;
  const wpx = g.partIds.length * CELL - 6;
  ctx.strokeStyle = g.side === 0 ? P.gold : P.ink2;
  ctx.lineWidth = 4;
  roundRect(ctx, x, y, wpx, CELL - 6, 12);
  ctx.stroke();
  // 等級與經驗條
  const table = def.highTier ? o.data.generals.expHighTier : o.data.generals.expNormalTier;
  const cur = table[g.level - 1] ?? 0;
  const next = table[g.level];
  const ratio = next === undefined ? 1 : Math.min(1, (g.exp - cur) / (next - cur));
  ctx.fillStyle = P.paper;
  ctx.fillRect(x + 8, y + CELL - 14, wpx - 16, 4);
  ctx.fillStyle = P.gold;
  ctx.fillRect(x + 8, y + CELL - 14, (wpx - 16) * ratio, 4);
  ctx.fillStyle = g.side === 0 ? P.gold : P.ink2;
  roundRect(ctx, x + wpx - 30, y - 2, 32, 18, 6);
  ctx.fill();
  ctx.fillStyle = P.unitText;
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`Lv${g.level}`, x + wpx - 14, y + 7);
}

const ENEMY_GLYPH: Record<Enemy['kind'], string> = { mob: '賊', zombie: '屍', cavalry: '騎', puppet: '傀' };
/** 狀態符號：控制類在單位或敵人右上角標一個字 */
const STATUS_GLYPH: Record<number, string> = { 8: '暈', 9: '倒', 10: '刺', 11: '電', 13: '亂', 14: '燃', 15: '困', 16: '鎖', 17: '倒', 18: '壓', 19: '惑' };

function statusGlyph(w: World, id: number): string | null {
  for (const b of w.buffs[id] ?? []) {
    const g = STATUS_GLYPH[b.type];
    if (g) return g;
  }
  return null;
}

function drawBadge(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, o: DrawOptions): void {
  const P = o.palette;
  ctx.fillStyle = P.bad;
  ctx.beginPath();
  ctx.arc(x, y, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = P.unitText;
  ctx.font = `bold 12px ${SERIF}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + 1);
}

function drawUnitStatus(ctx: CanvasRenderingContext2D, w: World, a: Actor, o: DrawOptions): void {
  if (a.loc.c !== 'board') return;
  const g = statusGlyph(w, a.id);
  if (g) drawBadge(ctx, a.loc.x * CELL + CELL - 12, a.loc.y * CELL + 12, g, o);
}

function drawEnemy(ctx: CanvasRenderingContext2D, w: World, e: Enemy, o: DrawOptions): void {
  const P = o.palette;
  const own = e.side === 0;
  const max = e.maxHp + (w.buffs[e.id] ?? []).filter((b) => b.type === 4).reduce((s, b) => s + (b.percent ? e.maxHp * b.num : b.num), 0);
  const ratio = Math.max(0, e.hp / max);
  const scale = 1 + e.scaleBonus + (w.buffs[e.id] ?? []).filter((b) => b.type === 6).reduce((s, b) => s + b.num, 0);
  // 對方防區的敵人淡化，與自己要防守的敵人區分
  ctx.globalAlpha = own ? 1 : 0.45;
  const bs = e.bossState;
  if (bs) {
    const def = o.data.waves.bosses[bs.bossId]!;
    const r = 26 * scale;
    ctx.fillStyle = def.color;
    ctx.beginPath();
    ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (bs.cast >= 0) {
      ctx.strokeStyle = P.gold;
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    ctx.fillStyle = P.unitText;
    ctx.font = `bold ${def.name.length > 2 ? 14 : 17}px ${SERIF}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.name, e.x, e.y + 1);
    ctx.fillStyle = P.line;
    ctx.fillRect(e.x - 30, e.y - r - 12, 60, 6);
    ctx.fillStyle = ratio > 0.5 ? P.ok : ratio > 0.25 ? P.gold : P.bad;
    ctx.fillRect(e.x - 30, e.y - r - 12, 60 * ratio, 6);
  } else {
    const r = 17 * scale;
    ctx.fillStyle = own ? P.ink : P.ink2;
    ctx.beginPath();
    ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = P.paper;
    ctx.font = `bold 18px ${SERIF}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ENEMY_GLYPH[e.kind], e.x, e.y + 1);
    ctx.fillStyle = P.line;
    ctx.fillRect(e.x - 18, e.y - r - 10, 36, 5);
    ctx.fillStyle = ratio > 0.5 ? P.ok : ratio > 0.25 ? P.gold : P.bad;
    ctx.fillRect(e.x - 18, e.y - r - 10, 36 * ratio, 5);
  }
  if (e.carries) {
    // 帶碎片的敵人：金色外圈
    ctx.strokeStyle = P.gold;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(e.x, e.y, (bs ? 30 : 21) * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  const g = statusGlyph(w, e.id);
  if (g) drawBadge(ctx, e.x + 16, e.y - 14, g, o);
  ctx.globalAlpha = 1;
}

function drawSkillEntities(ctx: CanvasRenderingContext2D, w: World, o: DrawOptions): void {
  const P = o.palette;
  for (const s of Object.values(w.skills)) {
    ctx.globalAlpha = s.side === 0 ? 0.85 : 0.4;
    if (s.kind === 'phantom') {
      const g = w.generals[s.generalId];
      const name = g ? o.data.generals.generals[g.type]!.name : '影';
      ctx.strokeStyle = P.gold;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      roundRect(ctx, s.x - 38, s.y - 22, 76, 44, 10);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = P.gold;
      ctx.font = `bold 20px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, s.x, s.y + 1);
    } else if (s.kind === 'zone') {
      ctx.fillStyle = P.seal;
      ctx.globalAlpha = s.side === 0 ? 0.25 : 0.12;
      ctx.fillRect(s.x - CELL / 2 + 4, s.y - CELL / 2 + 4, CELL - 8, CELL - 8);
      ctx.globalAlpha = s.side === 0 ? 0.8 : 0.35;
      ctx.font = `bold 22px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.left < 0 ? '蛇' : '火', s.x, s.y);
    } else if (s.kind === 'shot') {
      ctx.fillStyle = P.gold;
      ctx.font = `bold ${Math.round(s.radius)}px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.fx.label ?? '●', s.x, s.y);
    } else if (s.kind === 'trap' || s.kind === 'dozer') {
      ctx.globalAlpha = s.side === 0 ? 0.9 : 0.45;
      ctx.fillStyle = s.kind === 'dozer' ? P.gold : P.ink2;
      ctx.font = `bold 24px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.kind === 'dozer' ? '車' : s.mine ? '雷' : '阱', s.x, s.y);
    } else {
      ctx.strokeStyle = P.gold;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(s.x - s.dx * 30, s.y - s.dy * 30);
      ctx.lineTo(s.x + s.dx * 20, s.y + s.dy * 20);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** 夏侯惇噬目：玩家防區變暗 */
function drawBlind(ctx: CanvasRenderingContext2D, w: World): void {
  if (w.blindUntil[0] <= w.tick) return;
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  for (let x = 0; x < w.camp.length; x++) for (let y = 0; y < w.camp[x]!.length; y++) if (w.camp[x]![y] === 0) ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
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
    } else if (ev.type === 'blast') {
      const life = 300;
      if (age > life) continue;
      ctx.globalAlpha = 0.6 * (1 - age / life);
      ctx.strokeStyle = P.seal;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(ev.x, ev.y, ev.r * (0.6 + (0.4 * age) / life), 0, Math.PI * 2);
      ctx.stroke();
    } else if (ev.type === 'skill' || ev.type === 'bossCast') {
      const life = 900;
      if (age > life) continue;
      const text = ev.type === 'skill' ? ev.name : o.data.waves.bosses[ev.bossId]!.skillName;
      ctx.globalAlpha = 1 - age / life;
      ctx.fillStyle = ev.type === 'skill' ? P.gold : P.seal;
      ctx.font = `bold 22px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.fillText(text, ev.x, ev.y - 40 - age / 30);
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
