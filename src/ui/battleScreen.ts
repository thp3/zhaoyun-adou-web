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
import { BattleFx } from '../render/fx';
import { h } from './dom';
import { placeBeside, type Rect } from './popover';
import { describeActor, type UnitInfo } from './unitInfo';

/** 首局教程提示（依步驟） */
const TUTORIAL_TIPS: Record<number, string> = {
  0: '初陣：按「征兵」召集士兵。',
  1: '把下方征兵欄的兵拖到己方陣地（藍色區域）；同字同級疊上去可以合成升級。',
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
  };
  private readonly recruit = h('button', { class: 'primary recruit-bar' });
  /** 戰場區：佔滿 HUD 與下方按鈕以外的高度，畫布在裡面等比縮放 */
  private readonly stage = h('div', { class: 'stage' });
  private readonly stageObserver = new ResizeObserver(() => this.resize());
  /** 畫布目前的 CSS 尺寸，也是單位資訊浮窗的座標範圍 */
  private cssSize = { w: 0, h: 0 };
  private readonly toast = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  private readonly overlay = h('div', { class: 'backdrop', hidden: true });
  private readonly itemBar = h('div', { class: 'item-bar', 'aria-label': '我方道具' });
  private readonly tip = h('div', { class: 'tutorial-tip', role: 'status', hidden: true });
  private readonly aiItems = h('span', { class: 'hud-ai muted' });
  private readonly unitPanel = h('section', { class: 'unit-info', 'aria-label': '單位資訊', 'aria-live': 'polite', hidden: true });
  private unitSig = '';
  private popPos = '';
  /** 點選中的單位（點一下顯示資訊，再點一次或點空地取消） */
  private selected: number | null = null;
  private selectedInfo: UnitInfo | null = null;
  private itemSig = '';
  /** 已選取、等待點目標的道具欄位 */
  private armed: number | null = null;
  private effects: Effect[] = [];
  /** 打擊感：衝刺、閃白、粒子、震動（純視覺） */
  private readonly fx = new BattleFx();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private lastFrame = performance.now();
  private drag: DragState | null = null;
  /**
   * 剛放開、等待下一個 tick 套用的移動：命令要到下個 tick 才改世界，
   * 這段期間把單位畫在目標格，避免原位置閃一下。tick 前進後清掉（被拒絕時自然回到原位）。
   */
  private settling: { drag: DragState; tick: number } | null = null;
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
    this.recruit.addEventListener('click', () => session.enqueue({ type: 'RECRUIT', side: 0 }));
    this.stage.append(h('div', { class: 'stage-inner' }, this.canvas, this.tip, this.toast, this.unitPanel));
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
          this.aiItems,
          h('button', { onclick: () => app.pause('USER') }, '暫停'),
        ),
      ),
      this.stage,
      this.itemBar,
      this.recruit,
      this.overlay,
    );
    this.palette = readPalette(document.documentElement);
    this.bindInput();
    this.offEvents = app.onBattleEvents((evs) => this.onEvents(evs));
    this.stageObserver.observe(this.stage);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', this.repaint);
    const loop = () => {
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
    this.sync(view);
  }

  destroy(): void {
    cancelAnimationFrame(this.rafId);
    clearTimeout(this.toastTimer);
    this.offEvents();
    this.stageObserver.disconnect();
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

  /** 畫布等比放到戰場區裝得下的最大尺寸（寬、高都不超出） */
  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.stage;
    if (!w || !h) return;
    const cssW = Math.floor(Math.min(w, (h * BOARD_W) / VIEW_H));
    const cssH = (cssW * VIEW_H) / BOARD_W;
    this.cssSize = { w: cssW, h: cssH };
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.repaint();
  }

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
          ? `戰局回到第 ${this.session.world.wave.wave} 波，最後幾秒的佈置可能需要重做。按「繼續」再戰。`
          : hidden
            ? '離開畫面時，戰鬥會自動暫停。'
            : '敵我雙方都已停下，按「繼續」回到戰場。',
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
    this.fx.onEvents(events, this.session.world, now);
    for (const ev of events) {
      if (ev.type === 'rejected' && ev.side === 0) this.showToast(ev.reason);
      else if (ev.type === 'waveStart') this.showToast(`第 ${ev.wave} 波`);
      else if (ev.type === 'adouHit' && ev.side === 0) this.showToast(`阿斗受傷！剩 ${Math.max(0, ev.lives)} 命`);
      else if (ev.type === 'drop') this.showToast(`獲得碎片：${this.view.data!.weapons.weapons.find((x) => x.id === ev.weaponId)?.name ?? ''}`);
      else if (ev.type === 'bossSpawn' && ev.side === 0) this.showToast(`敵將${this.view.data!.waves.bosses[ev.bossId]!.name}來襲！`);
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
    this.itemBar.replaceChildren(...(buttons.length ? buttons : [h('span', { class: 'muted' }, '未攜帶道具')]));
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

  /** 單位資訊浮窗：拖曳中隱藏；內容有變才重建，位置有變才寫入 */
  private updateUnitPanel(dragging: boolean): void {
    const info = this.selectedInfo;
    const rect = dragging ? null : this.selectedRect();
    this.unitPanel.hidden = !info || !rect;
    if (!info || !rect) return;
    this.fillUnitPanel(info);
    const k = this.cssSize.w / BOARD_W;
    const p = placeBeside(
      { x: rect.x * k, y: rect.y * k, w: rect.w * k, h: rect.h * k },
      this.unitPanel.offsetWidth,
      this.unitPanel.offsetHeight,
      this.cssSize.w,
      this.cssSize.h,
    );
    const pos = `${p.left},${p.top}`;
    if (pos === this.popPos) return;
    this.popPos = pos;
    this.unitPanel.style.left = `${p.left}px`;
    this.unitPanel.style.top = `${p.top}px`;
  }

  private fillUnitPanel(info: UnitInfo): void {
    const sig = JSON.stringify([info.title, info.rows, info.notes]);
    if (sig === this.unitSig) return;
    this.unitSig = sig;
    this.unitPanel.classList.toggle('enemy', info.side === 1);
    this.unitPanel.replaceChildren(
      h(
        'div',
        { class: 'unit-info-head' },
        h('h2', null, info.title),
        h('button', { class: 'unit-info-close', 'aria-label': '關閉單位資訊', onclick: () => this.select(null) }, '×'),
      ),
      ...(info.rows.length ? [h('dl', null, ...info.rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))] : []),
      ...info.notes.map((n) => h('p', { class: 'muted small' }, n)),
    );
  }

  /** 選取單位的外框（世界座標）：陣地上取組成格，征兵欄取欄位 */
  private selectedRect(): Rect | null {
    const cell = this.selectedInfo?.cells[0];
    if (cell) return { x: cell.x * CELL, y: cell.y * CELL, w: cell.w * CELL, h: CELL };
    const loc = this.selected === null ? undefined : this.session.world.actors[this.selected]?.loc;
    return loc?.c === 'slot' ? slotRect(loc.i) : null;
  }

  private select(id: number | null): void {
    this.selected = id;
    this.selectedInfo = id === null ? null : describeActor(this.session.world, id, this.view.data!);
    if (!this.selectedInfo) this.selected = null;
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
        ? w.tutorial
          ? '初陣：照提示佈陣後敵軍才會出現'
          : `備戰 ${secs(data.waves.initialDelayMs)} 秒（征兵即開戰）`
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
    setText(this.recruit, `征兵 ${cost}`);
    this.recruit.disabled = w.camps[0].gold < cost || this.view.state !== 'BATTLE_RUNNING';
  }

  private draw(): void {
    const now = performance.now();
    this.effects = this.effects.filter((e) => now - e.born < EFFECT_TTL);
    // 系統「減少動態效果」或遊戲設定任一開啟就減少特效；暫停時特效凍結
    this.fx.reduced = this.reducedMotion.matches || (this.view.profile?.settings.reduceEffects ?? false);
    if (this.view.state === 'BATTLE_RUNNING') this.fx.tick(now, now - this.lastFrame);
    this.lastFrame = now;
    const scale = this.canvas.width / BOARD_W;
    const ctx = this.ctx2d;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // 選取的單位可能已被合成、回收或移動：每幀重算
    if (this.selected !== null) this.select(this.selected);
    if (this.settling && this.session.world.tick !== this.settling.tick) this.settling = null;
    const drag = this.drag ?? this.settling?.drag ?? null;
    drawBattle(ctx, this.session.world, {
      data: this.view.data!,
      palette: this.palette,
      now,
      effects: this.effects,
      drag,
      selected: drag ? null : this.selectedInfo,
      fx: this.fx,
      showDamage: this.view.profile?.settings.showDamageNumbers ?? true,
    });
    this.updateHud();
    this.updateUnitPanel(drag !== null);
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

  /** 該位置上的單位；征兵欄只看我方。mine=true 時只回傳我方（可拖動） */
  private actorAt(loc: BoardLoc | SlotLoc, mine = true): number | null {
    const w = this.session.world;
    const id = loc.c === 'board' ? w.board[loc.x]?.[loc.y] : w.camps[0].slots[loc.i];
    if (id == null) return null;
    const a = w.actors[id];
    return a && (!mine || a.side === 0) && a.loc.c !== 'incoming' ? id : null;
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
      if (id === null) {
        // 對方單位只能查看；點空地取消選取
        const other = loc ? this.actorAt(loc, false) : null;
        this.select(other !== null && other !== this.selected ? other : null);
        return;
      }
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
      // 原地放開＝點一下：切換選取，顯示攻擊、攻速、等級等資訊
      if (same) return this.select(this.selected === id ? null : id);
      this.session.enqueue({ type: 'MOVE', side: 0, actorId: id, to: loc });
      if (previewMove(w, 0, id, loc, this.view.data!).ok) this.settling = { drag: landedAt(id, loc), tick: w.tick };
    });
    c.addEventListener('pointercancel', () => this.cancelDrag());
    c.addEventListener('lostpointercapture', () => this.cancelDrag());
    window.addEventListener('blur', () => this.cancelDrag());
  }

  private cancelDrag(): void {
    this.drag = null;
  }
}

/** 單位落在目標格（或征兵欄）時的繪製位置與大小，與正式繪製一致 */
function landedAt(actorId: number, loc: BoardLoc | SlotLoc): DragState {
  if (loc.c === 'board') return { actorId, x: loc.x * CELL + CELL / 2, y: loc.y * CELL + CELL / 2, size: CELL - 12, hover: null };
  const r = slotRect(loc.i);
  return { actorId, x: r.x + r.w / 2, y: r.y + r.h / 2, size: r.w, hover: null };
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
