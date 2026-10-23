// 對局畫面：HUD、Canvas、拖曳輸入、暫停選單。同一場對局只建一次，狀態變化時呼叫 sync()。
import type { AppController, AppView } from '../app/appController';
import type { BattleSession } from '../app/battleSession';
import { previewMove } from '../domain/battle/commands';
import { CELL, type BattleEvent, type BoardLoc, type SlotLoc } from '../domain/battle/types';
import {
  BAR_H,
  BOARD_H,
  BOARD_W,
  VIEW_H,
  drawBattle,
  readPalette,
  slotRect,
  type DragState,
  type Effect,
  type Palette,
} from '../render/battleCanvas';
import { h } from './dom';

/** 首局教程提示（依步驟） */
const TUTORIAL_TIPS: Record<number, string> = {
  0: '教程：按「征兵」召集士兵。',
  1: '把下方征兵欄的兵拖到己方陣地（亮色格子）；同字同級疊上去可以合成升級。',
  2: '敵人要來了！守住右下角的阿斗。再征兵一次看看。',
  3: '把「黃」和「忠」左右相鄰排在同一列（姓在左），就會合成武將黃忠。鏟子可以拖到「荒」地開墾。',
};

const EFFECT_TTL = 1000;
const MAX_EFFECTS = 160;

export class BattleScreen {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx2d: CanvasRenderingContext2D;
  private readonly hud = {
    wave: h('span', { class: 'hud-wave' }),
    lives: h('span', { class: 'hud-lives' }),
    gold: h('strong', { class: 'hud-gold' }),
    recruit: h('button', { class: 'primary' }),
  };
  private readonly toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  private readonly overlay = h('div', { class: 'backdrop', hidden: true });
  private readonly itemBar = h('div', { class: 'item-bar', 'aria-label': '我方道具' });
  private readonly tip = h('div', { class: 'tutorial-tip', role: 'status', hidden: true });
  private readonly aiItems = h('div', { class: 'item-ai muted' });
  private itemSig = '';
  /** 已選取、等待點目標的道具欄位 */
  private armed: number | null = null;
  private effects: Effect[] = [];
  private drag: DragState | null = null;
  private palette: Palette;
  private rafId = 0;
  private toastTimer = 0;
  private confirmSurrender = false;
  private readonly offEvents: () => void;
  private view: AppView;

  constructor(
    readonly session: BattleSession,
    private readonly app: AppController,
    view: AppView,
  ) {
    this.view = view;
    this.canvas = h('canvas', { class: 'battle-canvas', 'aria-label': '戰場' });
    this.ctx2d = this.canvas.getContext('2d')!;
    this.hud.recruit.addEventListener('click', () => session.enqueue({ type: 'RECRUIT', side: 0 }));
    this.root = h(
      'main',
      { class: 'screen battle' },
      h(
        'header',
        { class: 'hud' },
        h('div', { class: 'hud-line' }, this.hud.wave, this.hud.lives),
        h(
          'div',
          { class: 'hud-line' },
          h('span', null, '資金 ', this.hud.gold),
          h('span', { class: 'hud-actions' }, this.hud.recruit, h('button', { onclick: () => app.pause('USER') }, '暫停')),
        ),
      ),
      this.tip,
      h('div', { class: 'canvas-wrap' }, this.canvas, this.toast),
      this.itemBar,
      this.aiItems,
      this.overlay,
    );
    this.palette = readPalette(document.documentElement);
    this.bindInput();
    this.offEvents = app.onBattleEvents((evs) => this.onEvents(evs));
    window.addEventListener('resize', this.resize);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', this.repaint);
    const loop = () => {
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
    queueMicrotask(this.resize);
    this.sync(view);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.toastTimer);
    this.offEvents();
    window.removeEventListener('resize', this.resize);
    matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', this.repaint);
  }

  /** 狀態變化（暫停／繼續）時更新覆蓋層 */
  sync(view: AppView): void {
    this.view = view;
    const paused = view.state === 'BATTLE_PAUSED';
    if (paused) this.cancelDrag();
    this.overlay.hidden = !paused;
    if (paused) this.overlay.replaceChildren(this.pauseDialog());
    else this.confirmSurrender = false;
  }

  private repaint = () => {
    this.palette = readPalette(document.documentElement);
  };

  private resize = () => {
    const cssW = this.canvas.clientWidth || BOARD_W;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(((cssW * VIEW_H) / BOARD_W) * dpr);
    this.repaint();
  };

  private pauseDialog(): HTMLElement {
    const wave = this.session.world.wave.wave;
    const early = wave < this.view.data!.economy.battleReward.earlySurrenderWave;
    const hidden = this.session.pauseReasons.has('PAGE_HIDDEN');
    const restored = this.session.pauseReasons.has('RESTORE');
    return h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '已暫停' },
      h('h2', null, restored ? '已恢復對局' : '已暫停'),
      h(
        'p',
        { class: 'muted' },
        restored
          ? `已從最後保存點（第 ${this.session.world.wave.wave} 波）恢復；保存點之後的幾秒不會補回。按「繼續」開始。`
          : hidden
            ? '切換分頁時戰鬥會自動暫停，不會在背景繼續。'
            : '戰鬥計時與出兵都已停止。',
      ),
      this.confirmSurrender
        ? h(
            'div',
            null,
            h('p', null, `放棄會以敗北結算。${early ? `第 ${this.view.data!.economy.battleReward.earlySurrenderWave} 波前放棄不給金幣。` : '可得敗北金幣。'}`),
            h(
              'div',
              { class: 'actions' },
              h('button', { class: 'danger', onclick: () => this.app.surrender() }, '確定放棄'),
              h('button', { onclick: () => ((this.confirmSurrender = false), this.sync(this.view)) }, '返回'),
            ),
          )
        : h(
            'div',
            { class: 'actions' },
            h('button', { class: 'primary', onclick: () => this.app.resume() }, '繼續'),
            h('button', { class: 'danger', onclick: () => ((this.confirmSurrender = true), this.sync(this.view)) }, '放棄…'),
          ),
    );
  }

  private onEvents(events: BattleEvent[]): void {
    const now = performance.now();
    for (const ev of events) {
      if (ev.type === 'rejected' && ev.side === 0) this.showToast(ev.reason);
      else if (ev.type === 'waveStart') this.showToast(`第 ${ev.wave} 波`);
      else if (ev.type === 'adouHit' && ev.side === 0) this.showToast(`阿斗受傷！剩 ${Math.max(0, ev.lives)} 命`);
      else if (ev.type === 'drop') this.showToast(`獲得碎片：${this.view.data!.weapons.weapons.find((x) => x.id === ev.weaponId)?.name ?? ''}`);
      else if (ev.type === 'bossSpawn' && ev.side === 0) this.showToast(`Boss 出現：${this.view.data!.waves.bosses[ev.bossId]!.name}`);
      else if (ev.type === 'damage') {
        // 只顯示自己防區的傷害數字
        if (this.session.world.enemies[ev.enemyId]?.side !== 1) this.effects.push({ ev, born: now });
      } else if (ev.type === 'attack' || ev.type === 'enemyDied' || ev.type === 'blast' || ev.type === 'skill' || ev.type === 'bossCast') this.effects.push({ ev, born: now });
    }
    // 特效上限，避免密集戰鬥時堆疊
    if (this.effects.length > MAX_EFFECTS) this.effects.splice(0, this.effects.length - MAX_EFFECTS);
  }

  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toast.classList.remove('show'), 1500);
  }

  /** 道具欄：狀態有變才重建按鈕 */
  private updateItems(): void {
    const w = this.session.world;
    const data = this.view.data!;
    const running = this.view.state === 'BATTLE_RUNNING';
    const sig = JSON.stringify([w.items[0].map((i) => [i.itemId, i.level, Math.ceil(i.cd / 50)]), this.armed, running, w.items[1].map((i) => i.itemId)]);
    if (sig === this.itemSig) return;
    this.itemSig = sig;
    const buttons = w.items[0].map((it, slot) => {
      const def = data.items.items[it.itemId]!;
      const secs = Math.ceil((it.cd * 20) / 1000);
      const label = def.levels ? `${def.name} ${it.level}` : def.name;
      if (!def.active) return h('span', { class: 'item passive', title: def.intro.replace('{type}', '') }, label);
      return h(
        'button',
        {
          class: `item${this.armed === slot ? ' armed' : ''}`,
          disabled: !running || it.cd > 0,
          title: def.intro.replace('{type}', ''),
          onclick: () => this.onItemClick(slot, it.itemId),
        },
        label,
        it.cd > 0 && h('small', null, `${secs}s`),
      );
    });
    this.itemBar.replaceChildren(...(buttons.length ? buttons : [h('span', { class: 'muted' }, '沒有道具（商店於 M5 開放）')]));
    const ai = w.items[1].map((i) => data.items.items[i.itemId]!.name);
    this.aiItems.textContent = ai.length ? `對方道具：${ai.join('、')}` : '';
  }

  private onItemClick(slot: number, itemId: number): void {
    // 不需要目標的道具（推土車、包子）點了就用
    if (itemId === 1 || itemId === 5) {
      this.session.enqueue({ type: 'USE_ITEM', side: 0, slot, to: null });
      this.armed = null;
      return;
    }
    this.armed = this.armed === slot ? null : slot;
    if (this.armed !== null) this.showToast('點選要使用的目標');
  }

  private updateHud(): void {
    this.updateItems();
    const t = this.session.world.tutorial;
    const tipText = t ? TUTORIAL_TIPS[t.step] : '';
    this.tip.hidden = !tipText;
    setText(this.tip, tipText ?? '');
    const w = this.session.world;
    const data = this.view.data!;
    const s = w.wave;
    const secs = (ms: number) => Math.max(0, Math.ceil((ms - s.timer * 20) / 1000));
    const waveText =
      s.phase === 'ready'
        ? `準備中 ${secs(data.waves.initialDelayMs)} 秒（征兵後提前開戰）`
        : s.phase === 'spawning'
          ? `第 ${s.wave}/${data.waves.waveCount} 波 · 出兵 ${s.spawned}/${data.waves.spawnCountByWave[s.wave - 1]}`
          : s.phase === 'intermission'
            ? `第 ${s.wave}/${data.waves.waveCount} 波 · 休息 ${secs(data.waves.intermissionMs)} 秒`
            : '最後一波結束';
    setText(this.hud.wave, waveText);
    const hearts = (n: number) => (n <= 0 ? '—' : n <= 5 ? '♥'.repeat(n) : `♥×${n}`);
    setText(this.hud.lives, w.aiEnabled ? `我 ${hearts(w.camps[0].lives)}　敵 ${hearts(w.camps[1].lives)}` : `阿斗 ${hearts(w.camps[0].lives)}`);
    setText(this.hud.gold, String(Math.floor(w.camps[0].gold)));
    const cost = w.camps[0].recruitCost;
    setText(this.hud.recruit, `征兵 ${cost}`);
    this.hud.recruit.disabled = w.camps[0].gold < cost || this.view.state !== 'BATTLE_RUNNING';
  }

  private draw(): void {
    const now = performance.now();
    this.effects = this.effects.filter((e) => now - e.born < EFFECT_TTL);
    const scale = this.canvas.width / BOARD_W;
    const ctx = this.ctx2d;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    drawBattle(ctx, this.session.world, {
      data: this.view.data!,
      palette: this.palette,
      now,
      effects: this.effects,
      drag: this.drag,
      showDamage: this.view.profile?.settings.showDamageNumbers ?? true,
    });
    this.updateHud();
  }

  // ---------- 輸入：畫布像素 → 世界座標 → 命令 ----------

  private toWorld(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const k = BOARD_W / r.width;
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  }

  private locAt(x: number, y: number): BoardLoc | SlotLoc | null {
    if (y < BOARD_H) {
      if (x < 0 || x >= BOARD_W || y < 0) return null;
      return { c: 'board', x: Math.floor(x / CELL), y: Math.floor(y / CELL) };
    }
    if (y > BOARD_H + BAR_H) return null;
    for (let i = 0; i < 5; i++) {
      const r = slotRect(i);
      if (x >= r.x - 10 && x <= r.x + r.w + 10) return { c: 'slot', i };
    }
    return null;
  }

  private actorAt(loc: BoardLoc | SlotLoc): number | null {
    const w = this.session.world;
    const id = loc.c === 'board' ? w.board[loc.x]?.[loc.y] : w.camps[0].slots[loc.i];
    if (id == null) return null;
    const a = w.actors[id];
    return a && a.side === 0 && a.loc.c !== 'incoming' ? id : null;
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (this.view.state !== 'BATTLE_RUNNING' || this.drag || !e.isPrimary) return;
      const p = this.toWorld(e);
      const loc = this.locAt(p.x, p.y);
      if (this.armed !== null) {
        // 已選道具：這次點擊當作使用目標
        if (loc) this.session.enqueue({ type: 'USE_ITEM', side: 0, slot: this.armed, to: loc });
        this.armed = null;
        e.preventDefault();
        return;
      }
      const id = loc ? this.actorAt(loc) : null;
      if (id === null) return;
      c.setPointerCapture(e.pointerId);
      this.drag = { actorId: id, x: p.x, y: p.y, hover: null };
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag || !e.isPrimary) return;
      const p = this.toWorld(e);
      this.drag.x = p.x;
      this.drag.y = p.y;
      const loc = this.locAt(p.x, p.y);
      if (!loc) this.drag.hover = null;
      else {
        const ok = previewMove(this.session.world, 0, this.drag.actorId, loc, this.view.data!).ok;
        this.drag.hover = { ...loc, ok } as DragState['hover'];
      }
    });
    c.addEventListener('pointerup', (e) => {
      if (!this.drag || !e.isPrimary) return;
      const p = this.toWorld(e);
      const loc = this.locAt(p.x, p.y);
      const id = this.drag.actorId;
      this.drag = null;
      if (!loc) return;
      const w = this.session.world;
      const cur = w.actors[id]?.loc;
      const same = cur && cur.c === loc.c && (loc.c === 'board' ? cur.c === 'board' && cur.x === loc.x && cur.y === loc.y : cur.c === 'slot' && cur.i === loc.i);
      if (!same) this.session.enqueue({ type: 'MOVE', side: 0, actorId: id, to: loc });
    });
    c.addEventListener('pointercancel', () => this.cancelDrag());
    c.addEventListener('lostpointercapture', () => this.cancelDrag());
    window.addEventListener('blur', () => this.cancelDrag());
  }

  private cancelDrag(): void {
    this.drag = null;
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
