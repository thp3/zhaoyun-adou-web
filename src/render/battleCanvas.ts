// 戰場繪製：純文字與幾何形狀，不載入任何圖片。只讀 World，不改狀態。
import type { GameData } from '../data';
import { CELL, type Actor, type BattleEvent, type Enemy, type General, type World } from '../domain/battle/types';
import { actorKey, generalKey, type BattleFx } from './fx';

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
  /** 陣營色：我方藍、對方紅，用於領地底色與交界線 */
  campOwn: string;
  campAi: string;
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
    campOwn: v('--camp-own'),
    campAi: v('--camp-ai'),
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
  /** 繪製邊長；未指定為拖曳中的 68 */
  size?: number;
  /** 目前懸停的落點與是否合法 */
  hover: { c: 'board'; x: number; y: number; ok: boolean } | { c: 'slot'; i: number; ok: boolean } | null;
}

export interface DrawOptions {
  data: GameData;
  palette: Palette;
  now: number;
  effects: Effect[];
  drag: DragState | null;
  /** 點選中的單位：外框與射程圈 */
  selected?: Selection | null;
  showDamage: boolean;
  /** 打擊感特效狀態；沒有時照靜態畫（測試、縮圖） */
  fx?: BattleFx;
}

export interface Selection {
  side: 0 | 1;
  range: { x: number; y: number; r: number } | null;
  cells: { x: number; y: number; w: number }[];
}

const SERIF = "'Noto Serif TC','Songti TC','PMingLiU',serif";

export function slotRect(i: number) {
  return { x: i * SLOT_W + SLOT_PAD / 2, y: BOARD_H + 30, w: SLOT_W - SLOT_PAD, h: SLOT_W - SLOT_PAD };
}

export function drawBattle(ctx: CanvasRenderingContext2D, w: World, o: DrawOptions): void {
  const P = o.palette;
  ctx.fillStyle = P.paper;
  ctx.fillRect(0, 0, BOARD_W, VIEW_H);
  measureScale(ctx);
  // 震動只套用在戰場，不動征兵欄
  const sh = o.fx?.shakeOffset(o.now) ?? { x: 0, y: 0 };
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, BOARD_W, BOARD_H);
  ctx.clip();
  ctx.translate(sh.x, sh.y);
  drawGrid(ctx, w, o);
  drawCampBorder(ctx, w, o);
  drawLaneMarks(ctx, w, o);

  for (const g of Object.values(w.generals)) drawGeneralPlate(ctx, w, g, o);
  for (const a of Object.values(w.actors)) {
    if (o.drag?.actorId === a.id || a.loc.c !== 'board') continue;
    const m = motionOf(w, a, o);
    const size = (CELL - 12) * m.scale;
    drawActor(ctx, a, a.loc.x * CELL + CELL / 2 + m.x - size / 2, a.loc.y * CELL + CELL / 2 + m.y - size / 2, size, o, 1);
  }
  for (const g of Object.values(w.generals)) drawGeneral(ctx, w, g, o);
  if (o.selected) drawSelection(ctx, o.selected, o);
  for (const a of Object.values(w.actors)) if (a.loc.c === 'board' && o.drag?.actorId !== a.id) drawUnitStatus(ctx, w, a, o);
  for (const e of Object.values(w.enemies)) drawEnemy(ctx, w, e, o);
  drawSkillEntities(ctx, w, o);
  for (const p of Object.values(w.projectiles)) drawArrow(ctx, w, p.x, p.y, p.targetId, p.side, o);
  drawEffects(ctx, o);
  drawParticles(ctx, o);
  drawBlind(ctx, w);
  ctx.restore();
  drawHurt(ctx, o);
  drawBar(ctx, w, o);

  if (o.drag) {
    const a = w.actors[o.drag.actorId];
    const size = o.drag.size ?? 68;
    // 已放開等待套用（有 size）時照正式樣子畫，不再半透明
    if (a) drawActor(ctx, a, o.drag.x - size / 2, o.drag.y - size / 2, size, o, o.drag.size ? 1 : 0.9);
  }
}

/** 單位的動態：待機浮動、出手衝刺（武將整組一起動）、橫掃時放大 */
function motionOf(w: World, a: Actor, o: DrawOptions): { x: number; y: number; scale: number } {
  const fx = o.fx;
  if (!fx) return { x: 0, y: 0, scale: 1 };
  const key = a.generalId !== null && w.generals[a.generalId] ? generalKey(a.generalId) : actorKey(a.id);
  const off = fx.offset(key, o.now);
  const seed = a.generalId ?? a.id;
  const bob = fx.reduced ? 0 : Math.sin(o.now / 650 + seed * 1.7) * 1.4;
  return { x: off.x, y: off.y + bob, scale: fx.pulse(key, o.now) };
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
      // 領地底色：整個陣營（含道路、荒地）都染上陣營色
      ctx.globalAlpha = CAMP_TINT;
      ctx.fillStyle = own ? P.campOwn : P.campAi;
      ctx.fillRect(px, py, CELL, CELL);
      ctx.globalAlpha = 1;
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

const CAMP_TINT = 0.13;
const BORDER_W = 4;

/** 雙方交界：沿陣營不同的格邊畫雙色線，靠我方一側藍、靠對方一側紅 */
function drawCampBorder(ctx: CanvasRenderingContext2D, w: World, o: DrawOptions): void {
  const P = o.palette;
  const color = (side: number | undefined) => (side === 0 ? P.campOwn : P.campAi);
  const half = BORDER_W / 2;
  ctx.lineWidth = BORDER_W;
  ctx.lineCap = 'square';
  for (let x = 0; x < w.camp.length; x++) {
    for (let y = 0; y < w.camp[x]!.length; y++) {
      const a = w.camp[x]![y];
      const right = w.camp[x + 1]?.[y];
      if (right !== undefined && right !== a) {
        const ex = (x + 1) * CELL;
        line(ctx, ex - half, y * CELL, ex - half, (y + 1) * CELL, color(a));
        line(ctx, ex + half, y * CELL, ex + half, (y + 1) * CELL, color(right));
      }
      const below = w.camp[x]![y + 1];
      if (below !== undefined && below !== a) {
        const ey = (y + 1) * CELL;
        line(ctx, x * CELL, ey - half, (x + 1) * CELL, ey - half, color(a));
        line(ctx, x * CELL, ey + half, (x + 1) * CELL, ey + half, color(below));
      }
    }
  }
  ctx.lineCap = 'butt';
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
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
    ctx.fillStyle = side === 0 ? P.campOwn : P.campAi;
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

// ---------- 預繪快取：棋子與敵人的漸層、影子、字每幀重畫太貴，改畫一次後貼上 ----------

interface Sprite {
  img: HTMLCanvasElement;
  /** 邏輯尺寸（未乘裝置倍率）的寬高與中心 */
  w: number;
  h: number;
  cx: number;
  cy: number;
}
const sprites = new Map<string, Sprite>();
const MAX_SPRITES = 400;

/** 這一幀畫布的裝置倍率（drawBattle 開頭量一次，不受命中壓扁等局部縮放影響）；快取依倍率分開，避免模糊 */
let frameScale = 1;
function measureScale(ctx: CanvasRenderingContext2D): void {
  const t = ctx.getTransform();
  frameScale = Math.round(Math.hypot(t.a, t.b) * 100) / 100;
}

function sprite(key: string, w: number, h: number, cx: number, cy: number, paint: (c: CanvasRenderingContext2D) => void): Sprite {
  const k = frameScale;
  const full = `${key}|${k}`;
  const hit = sprites.get(full);
  if (hit) return hit;
  if (sprites.size >= MAX_SPRITES) sprites.clear();
  const img = document.createElement('canvas');
  img.width = Math.ceil(w * k);
  img.height = Math.ceil(h * k);
  const c = img.getContext('2d')!;
  c.scale(k, k);
  paint(c);
  const s = { img, w, h, cx, cy };
  sprites.set(full, s);
  return s;
}

function blit(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number, scale = 1): void {
  ctx.drawImage(s.img, x - s.cx * scale, y - s.cy * scale, s.w * scale, s.h * scale);
}

function drawActor(ctx: CanvasRenderingContext2D, a: Actor, x: number, y: number, size: number, o: DrawOptions, alpha: number): void {
  const P = o.palette;
  // 快取以 4px 為級距；衝刺放大時直接縮放貼圖
  const nominal = Math.max(8, Math.round(size / 4) * 4);
  const pad = nominal * 0.14;
  const box = nominal + pad * 2;
  const key = `p|${a.token}|${a.kind}|${a.side}|${a.level}|${nominal}|${tokenColor(a, P)}|${P.unitText}|${P.ink2}`;
  const s = sprite(key, box, box, box / 2, box / 2, (c) => {
    const cx = box / 2;
    const cy = box / 2;
    const r = nominal * 0.47;
    // 落在棋盤上的影子
    c.fillStyle = 'rgba(0,0,0,0.28)';
    c.beginPath();
    c.ellipse(cx + nominal * 0.03, cy + nominal * 0.07, r, r * 0.96, 0, 0, Math.PI * 2);
    c.fill();
    paintPiece(c, a, cx, cy, nominal, o);
  });
  ctx.globalAlpha = alpha;
  blit(ctx, s, x + size / 2, y + size / 2, size / nominal);
  ctx.globalAlpha = 1;
}

function paintPiece(ctx: CanvasRenderingContext2D, a: Actor, cx: number, cy: number, size: number, o: DrawOptions): void {
  const P = o.palette;
  const tok = o.data.tokens.tokens.find((t) => t.id === a.token);
  const base = tokenColor(a, P);
  const r = size * 0.47;
  // 木質棋子：左上受光的放射漸層
  const grad = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
  grad.addColorStop(0, shade(base, 0.38));
  grad.addColorStop(0.7, base);
  grad.addColorStop(1, shade(base, -0.28));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // 外緣與刻線
  ctx.strokeStyle = a.side === 0 ? shade(base, -0.5) : P.ink2;
  ctx.lineWidth = Math.max(2, size * 0.04);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = Math.max(1, size * 0.02);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
  ctx.stroke();
  // 字：先壓一層暗色做出刻字感
  const leveled = a.kind === 'soldier' || a.kind === 'farmer';
  const lift = leveled ? size * 0.05 : 0;
  const glyph = tok?.display ?? '?';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(size * 0.5)}px ${SERIF}`;
  ctx.fillStyle = shade(base, -0.55);
  ctx.fillText(glyph, cx + 1, cy - lift + 1.5);
  ctx.fillStyle = P.unitText;
  ctx.fillText(glyph, cx, cy - lift);
  if (leveled) {
    // 等級：沿棋子下緣排列的亮點
    const n = a.level;
    const pr = Math.max(2, size * 0.035);
    const step = 0.3;
    const a0 = Math.PI / 2 + ((n - 1) * step) / 2;
    for (let i = 0; i < n; i++) {
      const ang = a0 - i * step;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(ang) * r * 0.62, cy + Math.sin(ang) * r * 0.62, pr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** 已成形武將的底座：印章底板，畫在組成字下面 */
function drawGeneralPlate(ctx: CanvasRenderingContext2D, w: World, g: General, o: DrawOptions): void {
  const first = w.actors[g.partIds[0]!];
  if (!first || first.loc.c !== 'board') return;
  const P = o.palette;
  const off = o.fx?.offset(generalKey(g.id), o.now) ?? { x: 0, y: 0 };
  ctx.fillStyle = g.side === 0 ? P.gold : P.ink2;
  ctx.globalAlpha = 0.22;
  roundRect(ctx, first.loc.x * CELL + 3 + off.x, first.loc.y * CELL + 3 + off.y, g.partIds.length * CELL - 6, CELL - 6, 12);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/** 選取：射程圈（淡色填滿＋虛線）與格子外框 */
function drawSelection(ctx: CanvasRenderingContext2D, sel: Selection, o: DrawOptions): void {
  const P = o.palette;
  const color = sel.side === 0 ? P.gold : P.bad;
  if (sel.range) {
    ctx.beginPath();
    ctx.arc(sel.range.x, sel.range.y, sel.range.r, 0, Math.PI * 2);
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  for (const c of sel.cells) {
    roundRect(ctx, c.x * CELL + 1, c.y * CELL + 1, c.w * CELL - 2, CELL - 2, 12);
    ctx.stroke();
  }
}

/** 已成形武將：在組成字外框一個跨格的印框，標名字與等級 */
function drawGeneral(ctx: CanvasRenderingContext2D, w: World, g: General, o: DrawOptions): void {
  const first = w.actors[g.partIds[0]!];
  if (!first || first.loc.c !== 'board') return;
  const P = o.palette;
  const def = o.data.generals.generals[g.type]!;
  const off = o.fx?.offset(generalKey(g.id), o.now) ?? { x: 0, y: 0 };
  const x = first.loc.x * CELL + 3 + off.x;
  const y = first.loc.y * CELL + 3 + off.y;
  const wpx = g.partIds.length * CELL - 6;
  // 印框：粗外框加細內框
  ctx.strokeStyle = g.side === 0 ? P.gold : P.ink2;
  ctx.lineWidth = 4;
  roundRect(ctx, x, y, wpx, CELL - 6, 12);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  roundRect(ctx, x + 5, y + 5, wpx - 10, CELL - 16, 8);
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
  const fade = own ? 1 : 0.45;
  const flash = o.fx?.flash(e.id, o.now) ?? 0;
  // 走路時一顛一顛（依走過的距離，停下就不動）
  const walk = o.fx && !o.fx.reduced ? -Math.abs(Math.sin((e.x + e.y) / 11)) * 3 : 0;
  const x = e.x;
  const y = e.y + walk;
  const bs = e.bossState;
  const r = (bs ? 26 : 17) * scale;
  ctx.globalAlpha = fade;
  // 影子留在地上，不跟著顛
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(e.x, e.y + r * 0.8, r * 0.9, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  // 命中時壓扁再彈回
  ctx.scale(1 + 0.16 * flash, 1 - 0.14 * flash);
  const body = bs ? o.data.waves.bosses[bs.bossId]!.color : own ? P.ink : P.ink2;
  if (bs) {
    // Boss 光暈
    ctx.globalAlpha = fade * 0.3;
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r * (1.28 + 0.06 * Math.sin(o.now / 260)), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = fade;
  }
  const label = bs ? o.data.waves.bosses[bs.bossId]!.name : ENEMY_GLYPH[e.kind];
  const rq = Math.max(4, Math.round(r));
  const half = rq * 1.9;
  const s = sprite(`e|${body}|${rq}|${label}|${!!bs}|${P.seal}|${P.paper}|${P.unitText}`, half * 2, half * 2, half, half, (c) => {
    c.translate(half, half);
    if (!bs) {
      // 小兵背後插一面旗
      c.strokeStyle = body;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(rq * 0.55, -rq * 0.2);
      c.lineTo(rq * 0.55, -rq * 1.75);
      c.stroke();
      c.fillStyle = P.seal;
      c.beginPath();
      c.moveTo(rq * 0.55, -rq * 1.75);
      c.lineTo(rq * 1.35, -rq * 1.5);
      c.lineTo(rq * 0.55, -rq * 1.2);
      c.closePath();
      c.fill();
    }
    const grad = c.createRadialGradient(-rq * 0.35, -rq * 0.4, rq * 0.1, 0, 0, rq);
    grad.addColorStop(0, shade(body, 0.3));
    grad.addColorStop(1, shade(body, -0.25));
    c.fillStyle = grad;
    c.beginPath();
    c.arc(0, 0, rq, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = bs ? P.unitText : P.paper;
    c.font = `bold ${bs ? (label.length > 2 ? 14 : 17) : 18}px ${SERIF}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, 0, 1);
  });
  blit(ctx, s, 0, 0, r / rq);
  if (bs && bs.cast >= 0) {
    ctx.strokeStyle = P.gold;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (flash > 0) {
    ctx.globalAlpha = 0.75 * flash * fade;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = fade;
  }
  ctx.restore();
  // 血條
  const bw = bs ? 60 : 36;
  const bh = bs ? 6 : 5;
  // 小兵的血條放在旗子上方，避免被旗面蓋住
  const by = bs ? y - r - 12 : y - r * 1.75 - 8;
  ctx.fillStyle = P.line;
  ctx.fillRect(x - bw / 2, by, bw, bh);
  ctx.fillStyle = ratio > 0.5 ? P.ok : ratio > 0.25 ? P.gold : P.bad;
  ctx.fillRect(x - bw / 2, by, bw * ratio, bh);
  if (e.carries) {
    // 帶碎片的敵人：金色外圈
    ctx.strokeStyle = P.gold;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, (bs ? 30 : 21) * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  const g = statusGlyph(w, e.id);
  if (g) drawBadge(ctx, x + 16, y - 14, g, o);
  ctx.globalAlpha = 1;
}

/** 飛行中的箭：箭頭加一條漸淡的尾跡 */
function drawArrow(ctx: CanvasRenderingContext2D, w: World, x: number, y: number, targetId: number, side: number, o: DrawOptions): void {
  const P = o.palette;
  const t = w.enemies[targetId];
  const ang = t ? Math.atan2(t.y - y, t.x - x) : 0;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  ctx.globalAlpha = side === 0 ? 1 : 0.45;
  const trail = ctx.createLinearGradient(x - c * 34, y - s * 34, x, y);
  trail.addColorStop(0, 'rgba(0,0,0,0)');
  trail.addColorStop(1, P.ink2);
  ctx.strokeStyle = trail;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - c * 34, y - s * 34);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.strokeStyle = P.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x - c * 12, y - s * 12);
  ctx.lineTo(x + c * 4, y + s * 4);
  ctx.stroke();
  ctx.fillStyle = P.ink;
  ctx.beginPath();
  ctx.moveTo(x + c * 10, y + s * 10);
  ctx.lineTo(x + c * 2 - s * 4, y + s * 2 + c * 4);
  ctx.lineTo(x + c * 2 + s * 4, y + s * 2 - c * 4);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawParticles(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  const fx = o.fx;
  if (!fx) return;
  const P = o.palette;
  for (const p of fx.particles) {
    const k = 1 - (o.now - p.born) / p.life;
    if (k <= 0) continue;
    const color = p.tone === 'ink' ? P.ink : p.tone === 'gold' ? P.gold : P.seal;
    ctx.globalAlpha = k;
    if (p.kind === 'dot') {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.6 + 0.4 * k), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = p.size;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** 我方阿斗受傷：戰場四周泛紅後淡出 */
function drawHurt(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  const t = o.fx ? o.now - o.fx.hurtAt : Infinity;
  const life = 500;
  if (t > life) return;
  const g = ctx.createRadialGradient(BOARD_W / 2, BOARD_H / 2, BOARD_H * 0.3, BOARD_W / 2, BOARD_H / 2, BOARD_H * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, o.palette.bad);
  ctx.globalAlpha = 0.55 * (1 - t / life);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, BOARD_W, BOARD_H);
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
      drawAttackFx(ctx, ev, age, fx.born, o);
    } else if (ev.type === 'damage' && o.showDamage) {
      // 傷害數字：彈出放大後縮回、上飄淡出；數字越大字越大
      const life = 650;
      if (age > life) continue;
      const k = age / life;
      const pop = age < 90 ? 1.45 - (0.45 * age) / 90 : 1;
      const jitter = ((fx.born * 7.3) % 1) * 16 - 8;
      const text = formatDamage(ev.amount);
      const ty = ev.y - 30 - 28 * (1 - (1 - k) * (1 - k));
      ctx.globalAlpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      ctx.font = `bold ${Math.round((14 + Math.min(10, Math.log10(Math.max(1, ev.amount)) * 4)) * pop)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = P.paper;
      ctx.strokeText(text, ev.x + jitter, ty);
      ctx.fillStyle = P.seal;
      ctx.fillText(text, ev.x + jitter, ty);
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

type AttackEvent = Extract<BattleEvent, { type: 'attack' }>;

/** 出手特效：刀＝目標上一道斬痕、槍＝漸細的刺擊、騎＝繞身一圈的刀光；弓箭在飛行中畫 */
function drawAttackFx(ctx: CanvasRenderingContext2D, ev: AttackEvent, age: number, born: number, o: DrawOptions): void {
  const P = o.palette;
  if (ev.kind === 'melee') {
    const life = 200;
    if (age > life) return;
    const k = age / life;
    const dir = Math.atan2(ev.ty - ev.y, ev.tx - ev.x);
    const sweep = Math.min(1, age / 70);
    ctx.globalAlpha = 1 - k;
    ctx.lineCap = 'round';
    ctx.strokeStyle = P.seal;
    ctx.lineWidth = 6 * (1 - k * 0.6);
    ctx.beginPath();
    ctx.arc(ev.tx - Math.cos(dir) * 10, ev.ty - Math.sin(dir) * 10, 22, dir - 1.1, dir - 1.1 + 2.2 * sweep);
    ctx.stroke();
    ctx.strokeStyle = P.paper;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineCap = 'butt';
  } else if (ev.kind === 'spear') {
    const life = 220;
    if (age > life) return;
    const k = age / life;
    const reach = Math.min(1, age / 80);
    const tx = ev.x + (ev.tx - ev.x) * reach;
    const ty = ev.y + (ev.ty - ev.y) * reach;
    const len = Math.hypot(tx - ev.x, ty - ev.y) || 1;
    const nx = -(ty - ev.y) / len;
    const ny = (tx - ev.x) / len;
    ctx.globalAlpha = 0.9 * (1 - k);
    ctx.fillStyle = P.seal;
    ctx.beginPath();
    ctx.moveTo(ev.x + nx * 7, ev.y + ny * 7);
    ctx.lineTo(tx, ty);
    ctx.lineTo(ev.x - nx * 7, ev.y - ny * 7);
    ctx.closePath();
    ctx.fill();
  } else if (ev.kind === 'sweep') {
    const life = 260;
    if (age > life) return;
    const k = age / life;
    const r = (ev.r ?? 80) * 0.7;
    const a0 = (born / 97) % (Math.PI * 2);
    const head = a0 + Math.PI * 1.7 * Math.min(1, age / 160);
    ctx.globalAlpha = 0.85 * (1 - k);
    ctx.lineCap = 'round';
    ctx.strokeStyle = P.seal;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(ev.x, ev.y, r, Math.max(a0, head - 1.6), head);
    ctx.stroke();
    ctx.strokeStyle = P.paper;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
  ctx.globalAlpha = 1;
}

/** 調亮（amt>0）或調暗（amt<0）色碼；結果快取 */
const shadeCache = new Map<string, string>();
function shade(color: string, amt: number): string {
  const key = color + amt;
  const hit = shadeCache.get(key);
  if (hit) return hit;
  let hex = color.trim().replace('#', '');
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return color;
  const n = parseInt(hex, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt)));
  const out = `rgb(${ch[0]},${ch[1]},${ch[2]})`;
  shadeCache.set(key, out);
  return out;
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
