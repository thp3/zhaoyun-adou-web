// Profile 的讀寫。每次寫入都在單一 readwrite 交易內：讀最新 → 驗證 → 檢查 revision → 套用 → 寫回，
// 並等交易 complete 才回報成功。讀到壞檔絕不覆寫。
import type { Profile } from '../domain/profile/profile';
import { PROFILE_KEY, type GameDatabase } from './db';
import { migrateProfile } from './migrations';
import { checkFence, StorageError, type Fence } from './errors';

export type LoadResult =
  | { status: 'missing' }
  | { status: 'ok'; profile: Profile; migrated: boolean }
  | { status: 'corrupt'; issues: string[] }
  | { status: 'too-new'; version: number };

export { StorageError } from './errors';

/** 回傳新 Profile 表示要提交；回傳原物件表示不需改動（不提高 revision）。 */
export type ProfileMutation = (current: Profile) => Profile;

export class ProfileRepository {
  constructor(
    private readonly db: GameDatabase,
    private readonly fence?: Fence,
  ) {}

  async load(now: number): Promise<LoadResult> {
    const tx = this.db.transaction(['profile', 'backups'], 'readwrite');
    const raw = await tx.objectStore('profile').get(PROFILE_KEY);
    if (raw === undefined) {
      await tx.done;
      return { status: 'missing' };
    }
    const result = migrateProfile(raw);
    if (result.kind === 'ok' && result.migrated) {
      // 遷移前先備份原始資料，再寫回新格式；兩者同一交易
      await tx.objectStore('backups').add({ savedAt: now, reason: 'migration', raw });
      await tx.objectStore('profile').put(result.profile, PROFILE_KEY);
    }
    await tx.done;
    if (result.kind === 'ok') return { status: 'ok', profile: result.profile, migrated: result.migrated };
    if (result.kind === 'too-new') return { status: 'too-new', version: result.version };
    return { status: 'corrupt', issues: result.issues };
  }

  /** 只在沒有存檔時建立；已有任何資料（包括壞檔）都拒絕。 */
  async create(profile: Profile): Promise<Profile> {
    const tx = this.db.transaction(['profile', 'meta'], 'readwrite');
    await checkFence(tx, this.fence);
    const existing = await tx.objectStore('profile').get(PROFILE_KEY);
    if (existing !== undefined) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new StorageError('exists', '已有存檔，不可重建');
    }
    await tx.objectStore('profile').put(profile, PROFILE_KEY);
    await tx.done;
    return profile;
  }

  /**
   * @param expectedRevision 呼叫端讀到的 revision；null 表示接受最新版（例如背景補計體力）
   */
  async update(expectedRevision: number | null, mutate: ProfileMutation): Promise<Profile> {
    const tx = this.db.transaction(['profile', 'meta'], 'readwrite');
    await checkFence(tx, this.fence);
    const fail = async (err: StorageError): Promise<never> => {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw err;
    };
    const raw = await tx.objectStore('profile').get(PROFILE_KEY);
    if (raw === undefined) return fail(new StorageError('missing', '找不到存檔'));
    const parsed = migrateProfile(raw);
    if (parsed.kind !== 'ok' || parsed.migrated) return fail(new StorageError('corrupt', '存檔需要重新載入'));
    const current = parsed.profile;
    if (expectedRevision !== null && current.revision !== expectedRevision) {
      return fail(new StorageError('conflict', `存檔已被更新（${expectedRevision} → ${current.revision}）`));
    }
    const next = mutate(current);
    if (next === current) {
      await tx.done;
      return current;
    }
    const committed: Profile = { ...next, revision: current.revision + 1 };
    await tx.objectStore('profile').put(committed, PROFILE_KEY);
    await tx.done;
    return committed;
  }

  /** 讀出原始存檔（壞檔也可），供匯出備份。 */
  async readRaw(): Promise<unknown> {
    return this.db.get('profile', PROFILE_KEY);
  }

  /** 玩家明確確認後：把目前原始存檔移入 backups，再寫入新檔。同一交易。 */
  async backupAndReplace(fresh: Profile, now: number, reason: string): Promise<Profile> {
    const tx = this.db.transaction(['profile', 'backups', 'meta'], 'readwrite');
    await checkFence(tx, this.fence);
    const raw = await tx.objectStore('profile').get(PROFILE_KEY);
    if (raw !== undefined) await tx.objectStore('backups').add({ savedAt: now, reason, raw });
    await tx.objectStore('profile').put(fresh, PROFILE_KEY);
    await tx.done;
    return fresh;
  }

  async countBackups(): Promise<number> {
    return this.db.count('backups');
  }
}
