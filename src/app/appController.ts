// 應用流程：開頁 → 載入資料 → 讀檔／遷移 → 每日處理與體力補計 → 主畫面。
// 畫面只呼叫這裡的方法，不直接改 Profile 或存檔。
import { DataError, loadGameData, type GameData } from '../data';
import { applyDailyReset } from '../domain/profile/daily';
import { createDefaultProfile, type Profile } from '../domain/profile/profile';
import { recoverStamina, type StaminaRules } from '../domain/profile/stamina';
import { dayKeyOf, type Clock } from '../domain/time/calendar';
import type { GameDatabase } from '../storage/db';
import { buildSaveExport, type SaveExport } from '../storage/exportSave';
import { ProfileRepository, StorageError } from '../storage/profileRepository';
import { AppStateMachine, type AppState } from './stateMachine';

export type RecoveryReason =
  | { kind: 'data'; issues: string[] }
  | { kind: 'storage-unavailable'; message: string }
  | { kind: 'corrupt'; issues: string[] }
  | { kind: 'too-new'; version: number }
  | { kind: 'write-failed'; message: string };

export interface AppView {
  state: AppState;
  data: GameData | null;
  profile: Profile | null;
  recovery: RecoveryReason | null;
  /** 最近一次成功提交存檔的時間 */
  lastSavedAt: number | null;
  notice: string | null;
}

export interface AppDeps {
  clock: Clock;
  openDb: () => Promise<GameDatabase>;
  loadData?: () => GameData;
}

export class AppController {
  readonly machine = new AppStateMachine();
  private data: GameData | null = null;
  private repo: ProfileRepository | null = null;
  private profile: Profile | null = null;
  private recovery: RecoveryReason | null = null;
  private lastSavedAt: number | null = null;
  private notice: string | null = null;
  private readonly listeners = new Set<(v: AppView) => void>();
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
    };
  }

  subscribe(fn: (v: AppView) => void): () => void {
    this.listeners.add(fn);
    fn(this.view);
    return () => this.listeners.delete(fn);
  }

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
    try {
      this.repo = new ProfileRepository(await this.deps.openDb());
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
    } catch (e) {
      return this.fail({ kind: 'write-failed', message: errorText(e) });
    }
    this.machine.go('PROFILE_READY');
    // M2 起：這裡先檢查 activeBattle / 待結算，分流到恢復路徑
    await this.refreshDaily();
    this.machine.go('LOBBY');
  }

  /** 開頁、回到前景、回主畫面時呼叫：向前跨日處理與體力補計。 */
  async refreshDaily(): Promise<void> {
    if (!this.repo || !this.profile || !this.data) return;
    const rules = this.staminaRules();
    const zone = this.data.economy.calendarZone;
    await this.commit((p) => {
      const now = this.deps.clock.now();
      let next = p;
      const daily = applyDailyReset(next, dayKeyOf(now, zone), false);
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

  /** 以目前 revision 提交；交易完成才更新畫面上的 Profile。 */
  private commit(mutate: (p: Profile) => Profile): Promise<void> {
    const run = async () => {
      const repo = this.repo;
      const before = this.profile;
      if (!repo || !before) return;
      try {
        const after = await repo.update(before.revision, mutate);
        if (after !== before && after.revision !== before.revision) this.lastSavedAt = this.deps.clock.now();
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
    };
    const p = this.writeQueue.then(run, run);
    this.writeQueue = p;
    return p;
  }

  private fail(reason: RecoveryReason): void {
    this.recovery = reason;
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
