// 一場對局的執行器：requestAnimationFrame 只負責取時間與觸發畫面，邏輯用 20ms 固定步長推進。
// 暫停以「原因集合」管理，集合清空且玩家明確繼續才恢復。
import { stepWorld } from '../domain/battle/step';
import { TICK_MS, type BattleCommand, type BattleEvent, type BattleResult, type BattleRules, type World } from '../domain/battle/types';

export type PauseReason = 'USER' | 'PAGE_HIDDEN' | 'RESTORE' | 'STORAGE_ERROR';

/** 單一 frame 最多補幾個 tick；超過代表裝置太慢，丟棄而不是暴衝 */
const MAX_STEPS_PER_FRAME = 10;
const MAX_FRAME_MS = 250;

export interface SessionHooks {
  onEvents?: (events: BattleEvent[]) => void;
  onEnded?: (result: BattleResult) => void;
  onFrame?: () => void;
}

export class BattleSession {
  private queue: BattleCommand[] = [];
  private readonly reasons = new Set<PauseReason>();
  private acc = 0;
  private last = 0;
  private rafId = 0;
  private ended = false;
  private alive = false;

  constructor(
    readonly world: World,
    private readonly rules: BattleRules,
    private readonly hooks: SessionHooks = {},
  ) {}

  get paused(): boolean {
    return this.reasons.size > 0;
  }

  get pauseReasons(): ReadonlySet<PauseReason> {
    return this.reasons;
  }

  enqueue(cmd: BattleCommand): void {
    if (!this.ended) this.queue.push(cmd);
  }

  pause(reason: PauseReason): void {
    this.reasons.add(reason);
  }

  /** 移除指定原因；回傳是否已無任何暫停原因 */
  clearPause(...reasons: PauseReason[]): boolean {
    for (const r of reasons) this.reasons.delete(r);
    this.last = performance.now();
    this.acc = 0;
    return this.reasons.size === 0;
  }

  start(): void {
    if (this.alive) return;
    this.alive = true;
    this.last = performance.now();
    const frame = (t: number) => {
      if (!this.alive) return;
      this.advance(Math.min(MAX_FRAME_MS, t - this.last));
      this.last = t;
      this.hooks.onFrame?.();
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    if (!this.alive) return;
    this.alive = false;
    cancelAnimationFrame(this.rafId);
  }

  /** 推進 ms 毫秒的模擬時間（暫停中不推進）；測試可直接呼叫 */
  advance(ms: number): void {
    if (this.paused || this.ended) return;
    this.acc += ms;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < MAX_STEPS_PER_FRAME && !this.ended) {
      const events = stepWorld(this.world, this.queue.splice(0), this.rules);
      this.acc -= TICK_MS;
      steps += 1;
      if (events.length) this.hooks.onEvents?.(events);
      if (this.world.result) {
        this.ended = true;
        this.hooks.onEnded?.(this.world.result);
      }
    }
    if (steps >= MAX_STEPS_PER_FRAME) this.acc = 0;
  }
}
