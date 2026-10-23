import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/app/appController';
import { createDefaultProfile } from '../src/domain/profile/profile';
import { openGameDb, PROFILE_KEY } from '../src/storage/db';
import { buildSaveExport, verifySaveExport } from '../src/storage/exportSave';
import { ProfileRepository, StorageError } from '../src/storage/profileRepository';

let n = 0;
const freshDbName = () => `test-db-${++n}`;
const T0 = Date.UTC(2026, 9, 23, 4, 0, 0); // 台北 10/23 12:00
const DAY = 86_400_000;
const newProfile = () => createDefaultProfile(T0, '2026-10-23', { staminaMax: 30 });

function makeApp(dbName: string, clock: { t: number }) {
  return new AppController({ clock: { now: () => clock.t }, openDb: () => openGameDb(dbName) });
}

describe('ProfileRepository', () => {
  it('沒有存檔時回 missing，建立後可讀回，不可重建', async () => {
    const repo = new ProfileRepository(await openGameDb(freshDbName()));
    expect((await repo.load(T0)).status).toBe('missing');
    const p = newProfile();
    await repo.create(p);
    const r = await repo.load(T0);
    expect(r.status === 'ok' && r.profile).toEqual(p);
    await expect(repo.create(p)).rejects.toBeInstanceOf(StorageError);
  });

  it('update 提高 revision；舊 revision 被拒', async () => {
    const repo = new ProfileRepository(await openGameDb(freshDbName()));
    await repo.create(newProfile());
    const a = await repo.update(0, (p) => ({ ...p, gold: 5 }));
    expect(a.revision).toBe(1);
    await expect(repo.update(0, (p) => ({ ...p, gold: 999 }))).rejects.toMatchObject({ code: 'conflict' });
    const r = await repo.load(T0);
    expect(r.status === 'ok' && r.profile.gold).toBe(5);
  });

  it('mutation 不改資料時不提高 revision', async () => {
    const repo = new ProfileRepository(await openGameDb(freshDbName()));
    await repo.create(newProfile());
    expect((await repo.update(0, (p) => p)).revision).toBe(0);
  });

  it('壞檔回 corrupt 且不被覆寫；較新版本回 too-new', async () => {
    const db = await openGameDb(freshDbName());
    const repo = new ProfileRepository(db);
    await db.put('profile', { schemaVersion: 1, gold: 'abc' }, PROFILE_KEY);
    expect((await repo.load(T0)).status).toBe('corrupt');
    await expect(repo.create(newProfile())).rejects.toMatchObject({ code: 'exists' });
    expect(await db.get('profile', PROFILE_KEY)).toEqual({ schemaVersion: 1, gold: 'abc' });
    await db.put('profile', { schemaVersion: 99 }, PROFILE_KEY);
    expect(await repo.load(T0)).toEqual({ status: 'too-new', version: 99 });
  });
});

describe('匯出 checksum', () => {
  it('內容被改動後驗證失敗', async () => {
    const file = await buildSaveExport({ a: 1 }, T0);
    expect(await verifySaveExport(file)).toBe(true);
    expect(await verifySaveExport({ ...file, profile: { a: 2 } })).toBe(false);
  });
});

describe('AppController 開頁流程', () => {
  it('無存檔 → 建立新檔（30 體力）→ 主畫面；重開保留且不再送', async () => {
    const name = freshDbName();
    const clock = { t: T0 };
    const app = makeApp(name, clock);
    await app.boot();
    expect(app.machine.state).toBe('LOBBY');
    expect(app.view.profile?.stamina.value).toBe(30);
    await app.updateSettings({ showDamageNumbers: false });

    const again = makeApp(name, clock);
    await again.boot();
    expect(again.view.profile?.createdAt).toBe(T0);
    expect(again.view.profile?.settings.showDamageNumbers).toBe(false);
  });

  it('壞檔進 RECOVERY；確認後備份舊檔並建立新檔', async () => {
    const name = freshDbName();
    const db = await openGameDb(name);
    await db.put('profile', { broken: true }, PROFILE_KEY);
    const app = makeApp(name, { t: T0 });
    await app.boot();
    expect(app.machine.state).toBe('RECOVERY');
    expect(app.view.recovery?.kind).toBe('corrupt');
    expect(await db.get('profile', PROFILE_KEY)).toEqual({ broken: true });

    await app.replaceCorruptSave();
    expect(app.machine.state).toBe('LOBBY');
    expect(await db.count('backups')).toBe(1);
    expect((await db.getAll('backups'))[0]?.raw).toEqual({ broken: true });
  });

  it('資料表壞掉進 RECOVERY，不碰存檔', async () => {
    const app = new AppController({
      clock: { now: () => T0 },
      openDb: () => openGameDb(freshDbName()),
      loadData: () => {
        throw new Error('bad data');
      },
    });
    await app.boot();
    expect(app.view.recovery?.kind).toBe('data');
  });

  it('跨日重開：清當日道具並補計體力', async () => {
    const name = freshDbName();
    const db = await openGameDb(name);
    await db.put(
      'profile',
      { ...newProfile(), items: [{ id: 5, level: 1 }], stamina: { value: 10, lastRecoverAt: T0 } },
      PROFILE_KEY,
    );
    const app = makeApp(name, { t: T0 + DAY + 7 * 60_000 });
    await app.boot();
    const v = app.view.profile!;
    expect(v.lastProcessedDay).toBe('2026-10-24');
    expect(v.items).toEqual([]);
    expect(v.stamina.value).toBe(30);
    expect(v.revision).toBe(1);
  });
});
