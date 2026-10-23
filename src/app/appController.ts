// 應用流程：開頁 → 載入資料 → 讀檔／遷移 → 分流（主畫面／未完成對局／待結算）→ 開局交易 → 對局 → 結算交易 → 結果 → 主畫面。
// 畫面只呼叫這裡的方法，不直接改 Profile、World 或存檔。
import { DataError, loadGameData, type GameData } from '../data';
import { createWorld } from '../domain/battle/create';
import { surrender as surrenderWorld } from '../domain/battle/step';
import type { BattleEvent, BattleResult } from '../domain/battle/types';
import { applyDailyReset, registerDayIndex } from '../domain/profile/daily';
import { generateOpponent } from '../domain/profile/opponent';
import { createDefaultProfile, roundOfDay, totalRounds, type Profile } from '../domain/profile/profile';
import { starToRank } from '../domain/profile/rank';
import { applySettlement, selectMapId, type ResultDraft } from '../domain/profile/settlement';
import { recoverStamina, type StaminaRules } from '../domain/profile/stamina';
import { dayKeyOf, type Clock } from '../domain/time/calendar';
import { BattleStore, type BattleRecord, type Receipt } from '../storage/battleStore';
import type { GameDatabase } from '../storage/db';
import { buildSaveExport, type SaveExport } from '../storage/exportSave';
import { ProfileRepository, StorageError } from '../storage/profileRepository';
import { BattleSession, type PauseReason } from './battleSession';
import { AppStateMachine, type AppState } from './stateMachine';

export type RecoveryReason =
  | { kind: 'data'; issues: string[] }
  | { kind: 'storage-unavailable'; message: string }
  | { kind: 'corrupt'; issues: string[] }
  | { kind: 'too-new'; version: number }
  | { kind: 'write-failed'; message: string }
  | { kind: 'settle-failed'; message: string };

export interface AppView {
  state: AppState;
  data: GameData | null;
  profile: Profile | null;
  recovery: RecoveryReason | null;
  /** 最近一次成功提交存檔的時間 */
  lastSavedAt: number | null;
  notice: string | null;
  battle: BattleRecord | null;
  session: BattleSession | null;
  /** 已開始但無法續玩的對局（M6 前只能以放棄結算） */
  interrupted: boolean;
  receipt: Receipt | null;
  busy: boolean;
}

export interface AppDeps {
  clock: Clock;
  openDb: () => Promise<GameDatabase>;
  loadData?: () => GameData;
  random?: () => number;
  /** 是否自動啟動 requestAnimationFrame 迴圈（測試時關閉，改手動推進） */
  autoRun?: boolean;
}

export class AppController {
  readonly machine = new AppStateMachine();
  private data: GameData | null = null;
  private repo: ProfileRepository | null = null;
  private store: BattleStore | null = null;
  private profile: Profile | null = null;
  private recovery: RecoveryReason | null = null;
  private lastSavedAt: number | null = null;
  private notice: string | null = null;
  private battle: BattleRecord | null = null;
  private session: BattleSession | null = null;
  private interrupted = false;
  private receipt: Receipt | null = null;
  private busy = false;
  private readonly listeners = new Set<(v: AppView) => void>();
  private readonly battleListeners = new Set<(events: BattleEvent[]) => void>();
  /** 序列化所有存檔寫入，避免同一分頁內兩個交易互相覆蓋 */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AppDeps) {
    this.machine.onChange(() => this.emit());
  }

  get view(): AppView {
    return {
      state: this.machine.state,
      data: this.data,
      profile: this.profile,
      recovery: this.recovery,
      lastSavedAt: this.lastSavedAt,
      notice: this.notice,
      battle: this.battle,
      session: this.session,
      interrupted: this.interrupted,
      receipt: this.receipt,
      busy: this.busy,
    };
  }

  subscribe(fn: (v: AppView) => void): () => void {
    this.listeners.add(fn);
    fn(this.view);
    return () => this.listeners.delete(fn);
  }

  onBattleEvents(fn: (events: BattleEvent[]) => void): () => void {
    this.battleListeners.add(fn);
    return () => this.battleListeners.delete(fn);
  }

  // ---------------- 開頁 ----------------

  async boot(): Promise<void> {
    this.machine.go('LOADING');
    await this.loadAll();
  }

  /** RECOVERY 畫面的「重試」 */
  async retry(): Promise<void> {
    this.recovery = null;
    this.machine.go('LOADING');
    await this.loadAll();
  }

  private async loadAll(): Promise<void> {
    try {
      this.data = (this.deps.loadData ?? loadGameData)();
    } catch (e) {
      return this.fail({ kind: 'data', issues: e instanceof DataError ? e.issues : [String(e)] });
    }
    let db: GameDatabase;
    try {
      db = await this.deps.openDb();
      this.repo = new ProfileRepository(db);
      this.store = new BattleStore(db);
    } catch (e) {
      return this.fail({ kind: 'storage-unavailable', message: errorText(e) });
    }
    const now = this.deps.clock.now();
    let result;
    try {
      result = await this.repo.load(now);
    } catch (e) {
      return this.fail({ kind: 'storage-unavailable', message: errorText(e) });
    }
    if (result.status === 'corrupt') return this.fail({ kind: 'corrupt', issues: result.issues });
    if (result.status === 'too-new') return this.fail({ kind: 'too-new', version: result.version });
    try {
      this.profile =
        result.status === 'ok' ? result.profile : await this.repo.create(this.freshProfile(now));
      if (result.status === 'missing') this.lastSavedAt = now;
      this.battle = await this.store.getActive();
    } catch (e) {
      return this.fail({ kind: 'write-failed', message: errorText(e) });
    }
    this.machine.go('PROFILE_READY');
    await this.routeAfterProfile();
  }

  /** 依未完成對局分流；不重新扣費、不重抽對手、不重算掉落 */
  private async routeAfterProfile(): Promise<void> {
    const b = this.battle;
    if (!b) {
      await this.refreshDaily();
      this.machine.go('LOBBY');
      return;
    }
    if (b.phase === 'PREPARED') {
      this.machine.go('OPPONENT_PRESENTATION');
      return;
    }
    if (b.phase === 'SETTLEMENT_PENDING') {
      this.machine.go('SETTLING');
      await this.settleActive();
      return;
    }
    // STARTED：M6 前沒有完整快照，停在 PROFILE_READY 讓玩家確認以放棄結算
    this.interrupted = true;
    this.emit();
  }

  /** 開頁、回到前景、回主畫面時呼叫：向前跨日處理與體力補計。 */
  async refreshDaily(): Promise<void> {
    if (!this.repo || !this.profile || !this.data) return;
    const rules = this.staminaRules();
    const zone = this.data.economy.calendarZone;
    const hasActive = this.battle !== null;
    await this.commit((p) => {
      const now = this.deps.clock.now();
      let next = p;
      const daily = applyDailyReset(next, dayKeyOf(now, zone), hasActive);
      if (daily.kind === 'reset') next = daily.profile;
      const stamina = recoverStamina(next.stamina, now, rules);
      if (stamina !== next.stamina) next = { ...next, stamina };
      return next;
    });
  }

  async updateSettings(patch: Partial<Profile['settings']>): Promise<void> {
    await this.commit((p) => ({ ...p, settings: { ...p.settings, ...patch } }));
  }

  async exportSave(): Promise<SaveExport | null> {
    if (!this.repo) return null;
    return buildSaveExport(await this.repo.readRaw(), this.deps.clock.now());
  }

  /** 壞檔時，玩家明確確認後才呼叫：舊檔移入備份區，再建立新檔。 */
  async replaceCorruptSave(): Promise<void> {
    if (!this.repo || !this.data || this.recovery?.kind !== 'corrupt') return;
    const now = this.deps.clock.now();
    try {
      this.profile = await this.repo.backupAndReplace(this.freshProfile(now), now, 'user-reset-corrupt');
    } catch (e) {
      this.recovery = { kind: 'write-failed', message: errorText(e) };
      this.emit();
      return;
    }
    this.recovery = null;
    this.lastSavedAt = now;
    this.notice = '已建立新存檔，舊存檔保留在備份區。';
    this.machine.go('PROFILE_READY');
    this.machine.go('LOBBY');
  }

  dismissNotice(): void {
    this.notice = null;
    this.emit();
  }

  // ---------------- 開局 ----------------

  async startBattle(): Promise<void> {
    if (this.machine.state !== 'LOBBY' || this.busy || !this.store || !this.data) return;
    const data = this.data;
    this.setBusy(true);
    this.machine.go('PREPARING');
    const now = this.deps.clock.now();
    const rand = this.deps.random ?? Math.random;
    const battleId = `b${now.toString(36)}-${Math.floor(rand() * 2 ** 32).toString(36)}`;
    const seed = Math.floor(rand() * 2 ** 31);
    try {
      const out = await this.serial(() =>
        this.store!.start({
          now,
          battleId,
          rulesetVersion: data.manifest.rulesetVersion,
          cost: data.economy.stamina.battleCost,
          stamina: this.staminaRules(),
          makeSetup: (p) => ({
            seed,
            mapId: selectMapId(p, now, data),
            totalRounds: totalRounds(p),
            roundOfDay: roundOfDay(p),
            addHp: data.ranks.ranks[starToRank(p.rank.curStar).rankId]!.addHp,
            aiEnabled: true,
            playerEquip: [...p.equip],
            playerItems: p.items.map((i) => ({ ...i })),
            ...generateOpponent(data, seed, p.rank.curStar, registerDayIndex(p, dayKeyOf(now, data.economy.calendarZone)), roundOfDay(p)),
          }),
        }),
      );
      if (out.kind === 'no-stamina') {
        this.profile = out.profile;
        this.notice = `體力不足（需要 ${data.economy.stamina.battleCost}）`;
        this.machine.go('LOBBY');
      } else if (out.kind === 'existing' && out.record.phase !== 'PREPARED') {
        this.battle = out.record;
        this.notice = '有未完成的對局，請重新整理頁面處理。';
        this.machine.go('LOBBY');
      } else {
        this.battle = out.record;
        if (out.kind === 'created') {
          this.profile = out.profile;
          this.lastSavedAt = now;
        }
        this.machine.go('OPPONENT_PRESENTATION');
      }
    } catch (e) {
      // 交易沒有完成：未扣體力
      this.notice = `無法開局：${errorText(e)}`;
      this.machine.go('LOBBY');
    } finally {
      this.setBusy(false);
    }
  }

  /** 尚未開始時取消：唯一退款 */
  async cancelPrepared(): Promise<void> {
    const b = this.battle;
    if (this.machine.state !== 'OPPONENT_PRESENTATION' || this.busy || !b || !this.store) return;
    this.setBusy(true);
    try {
      this.profile = await this.serial(() => this.store!.cancelPrepared(b.battleId, this.deps.clock.now(), this.staminaRules()));
      this.battle = null;
      this.notice = `已取消，退還 ${b.staminaCost} 體力。`;
      this.lastSavedAt = this.deps.clock.now();
      this.machine.go('LOBBY');
    } catch (e) {
      this.notice = `取消失敗：${errorText(e)}`;
      this.emit();
    } finally {
      this.setBusy(false);
    }
  }

  async beginBattle(): Promise<void> {
    const b = this.battle;
    if (this.machine.state !== 'OPPONENT_PRESENTATION' || this.busy || !b || !this.store || !this.data) return;
    this.setBusy(true);
    try {
      const started = await this.serial(() => this.store!.markStarted(b.battleId, this.deps.clock.now()));
      if (!started) throw new Error('對局紀錄已不存在');
      this.battle = started;
    } catch (e) {
      this.notice = `無法開始：${errorText(e)}`;
      this.setBusy(false);
      return;
    }
    const world = createWorld({ data: this.data, ...b.setup });
    this.session = new BattleSession(world, { data: this.data }, {
      onEvents: (events) => this.handleBattleEvents(events),
      onEnded: (result) => void this.finishBattle(result),
    });
    this.machine.go('BATTLE_READY');
    this.machine.go('BATTLE_RUNNING');
    if (this.deps.autoRun !== false) this.session.start();
    this.setBusy(false);
  }

  // ---------------- 對局中 ----------------

  pause(reason: PauseReason = 'USER'): void {
    const s = this.session;
    if (!s) return;
    s.pause(reason);
    if (this.machine.state === 'BATTLE_RUNNING') this.machine.go('BATTLE_PAUSED');
    else this.emit();
  }

  /** 玩家按「繼續」：清除使用者與切頁原因；仍有其他原因時保持暫停 */
  resume(): void {
    const s = this.session;
    if (!s || this.machine.state !== 'BATTLE_PAUSED') return;
    if (s.clearPause('USER', 'PAGE_HIDDEN', 'RESTORE')) this.machine.go('BATTLE_RUNNING');
    else this.emit();
  }

  surrender(): void {
    const s = this.session;
    if (!s || this.machine.state !== 'BATTLE_PAUSED') return;
    const result = surrenderWorld(s.world);
    if (result) void this.finishBattle(result);
  }

  private handleBattleEvents(events: BattleEvent[]): void {
    for (const fn of this.battleListeners) fn(events);
    const b = this.battle;
    const s = this.session;
    if (!b || !s || !this.store) return;
    if (events.some((e) => e.type === 'waveStart')) {
      const progress = { wave: s.world.wave.wave, tick: s.world.tick, kills: s.world.camps[0].kills };
      void this.serial(() => this.store!.saveProgress(b.battleId, progress)).catch(() => {
        this.notice = '進度保存失敗，將於下一波重試。';
        this.emit();
      });
    }
  }

  // ---------------- 結算 ----------------

  private async finishBattle(result: BattleResult): Promise<void> {
    const b = this.battle;
    const s = this.session;
    if (!b || !s || !this.data) return;
    if (this.machine.state === 'SETTLING' || this.machine.state === 'RESULT') return;
    s.stop();
    const draft: ResultDraft = {
      battleId: b.battleId,
      rulesetVersion: b.rulesetVersion,
      outcome: result.outcome,
      reason: result.reason,
      wave: result.wave,
      tick: result.tick,
      kills: s.world.camps[0].kills,
    };
    this.machine.go('SETTLING');
    await this.saveDraftAndSettle(draft);
  }

  /** 中斷的對局：以最後保存的波次放棄結算 */
  async settleInterrupted(): Promise<void> {
    const b = this.battle;
    if (!this.interrupted || !b || this.machine.state !== 'PROFILE_READY') return;
    this.interrupted = false;
    this.machine.go('SETTLING');
    await this.saveDraftAndSettle({
      battleId: b.battleId,
      rulesetVersion: b.rulesetVersion,
      outcome: 'lose',
      reason: 'surrender',
      wave: b.progress.wave,
      tick: b.progress.tick,
      kills: b.progress.kills,
    });
  }

  private async saveDraftAndSettle(draft: ResultDraft): Promise<void> {
    try {
      const rec = await this.serial(() => this.store!.markSettlementPending(draft));
      if (rec) this.battle = rec;
    } catch (e) {
      return this.fail({ kind: 'settle-failed', message: errorText(e) });
    }
    await this.settleActive();
  }

  private async settleActive(): Promise<void> {
    const b = this.battle;
    const data = this.data;
    if (!b || !data || !this.store) return;
    try {
      const out = await this.serial(() =>
        this.store!.settle(b.battleId, this.deps.clock.now(), (p, d) => applySettlement(p, d, data)),
      );
      this.profile = out.profile;
      this.receipt = out.receipt;
      this.lastSavedAt = this.deps.clock.now();
    } catch (e) {
      return this.fail({ kind: 'settle-failed', message: errorText(e) });
    }
    this.battle = null;
    this.session = null;
    this.machine.go('RESULT');
  }

  async backToLobby(): Promise<void> {
    if (this.machine.state !== 'RESULT') return;
    this.receipt = null;
    this.machine.go('LOBBY');
    await this.refreshDaily();
  }

  // ---------------- 內部 ----------------

  private freshProfile(now: number): Profile {
    const data = this.data!;
    return createDefaultProfile(now, dayKeyOf(now, data.economy.calendarZone), {
      staminaMax: data.economy.stamina.max,
    });
  }

  private staminaRules(): StaminaRules {
    const s = this.data!.economy.stamina;
    return { max: s.max, recoverIntervalMs: s.recoverIntervalMs };
  }

  private setBusy(v: boolean): void {
    this.busy = v;
    this.emit();
  }

  /** 把存檔操作排進同一條佇列，依序執行 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.writeQueue.then(fn, fn);
    this.writeQueue = p.catch(() => undefined);
    return p;
  }

  /** 以目前 revision 提交；交易完成才更新畫面上的 Profile。 */
  private commit(mutate: (p: Profile) => Profile): Promise<void> {
    return this.serial(async () => {
      const repo = this.repo;
      const before = this.profile;
      if (!repo || !before) return;
      try {
        const after = await repo.update(before.revision, mutate);
        if (after.revision !== before.revision) this.lastSavedAt = this.deps.clock.now();
        this.profile = after;
        this.emit();
      } catch (e) {
        if (e instanceof StorageError && e.code === 'conflict') {
          // 另一處已更新：重新讀檔，不用舊資料覆蓋
          const reloaded = await repo.load(this.deps.clock.now());
          if (reloaded.status === 'ok') this.profile = reloaded.profile;
          this.notice = '存檔已在其他地方更新，已重新讀取。';
          this.emit();
          return;
        }
        this.notice = `存檔失敗：${errorText(e)}`;
        this.emit();
      }
    });
  }

  private fail(reason: RecoveryReason): void {
    this.recovery = reason;
    this.session?.stop();
    this.machine.go('RECOVERY');
  }

  private emit(): void {
    const v = this.view;
    for (const fn of this.listeners) fn(v);
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
