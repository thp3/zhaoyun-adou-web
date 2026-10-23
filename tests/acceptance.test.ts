// 設計文件第 21 節的驗收案例（本機可自動化的部分）。
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/app/appController';
import { BattleSession } from '../src/app/battleSession';
import { loadGameData } from '../src/data';
import { createWorld } from '../src/domain/battle/create';
import { stepWorld } from '../src/domain/battle/step';
import { createDefaultProfile } from '../src/domain/profile/profile';
import { ACTIVE_KEY } from '../src/storage/battleStore';
import { openGameDb, PROFILE_KEY } from '../src/storage/db';

const data = loadGameData();
const T0 = Date.UTC(2026, 9, 23, 4, 0, 0);
const DAY = 86_400_000;
let n = 0;
const dbName = () => `acc-${++n}`;
const flush = async (done: () => boolean = () => false, max = 60) => {
  for (let i = 0; i < max && !done(); i++) await new Promise((r) => setTimeout(r, 5));
};

function makeApp(name: string, clock: { t: number }, ownerId?: string) {
  return new AppController({ clock: { now: () => clock.t }, openDb: () => openGameDb(name), random: () => 0.42, autoRun: false, heartbeat: false, ownerId });
}

/** 預先放一份「打過幾局」的存檔，避免進入教學局 */
async function seedVeteran(name: string, over: Record<string, unknown> = {}) {
  const db = await openGameDb(name);
  const p = createDefaultProfile(T0, '2026-10-20', { staminaMax: 30 });
  await db.put('profile', { ...p, lastProcessedDay: '2026-10-23', stats: { ...p.stats, win: 3, lose: 3 }, tutorial: { ...p.tutorial, firstBattleDone: true }, ...over }, PROFILE_KEY);
}

describe('驗收：多分頁', () => {
  it('兩分頁同時開：第二個不能寫；接手後第一個停止寫入、不重複扣體力', async () => {
    const name = dbName();
    await seedVeteran(name);
    const clock = { t: T0 };
    const a = makeApp(name, clock, 'tab-a');
    await a.boot();
    expect(a.machine.state).toBe('LOBBY');

    const b = makeApp(name, clock, 'tab-b');
    await b.boot();
    expect(b.machine.state).toBe('RECOVERY');
    expect(b.view.recovery).toEqual({ kind: 'other-tab', lost: false });

    await b.takeOver();
    expect(b.machine.state).toBe('LOBBY');

    // 舊分頁嘗試開局：交易因寫入權被拒，不扣體力
    await a.startBattle();
    // 寫入一被拒絕就立刻切換，不必等心跳
    expect(a.machine.state).toBe('RECOVERY');
    expect(a.view.recovery).toEqual({ kind: 'other-tab', lost: true });
    const db = await openGameDb(name);
    expect(((await db.get('profile', PROFILE_KEY)) as { stamina: { value: number } }).stamina.value).toBe(30);
    expect(await db.get('battles', ACTIVE_KEY)).toBeUndefined();
  });

  it('租約到期（舊分頁沒有正常關閉）後新分頁可直接取得', async () => {
    const name = dbName();
    await seedVeteran(name);
    const clock = { t: T0 };
    await makeApp(name, clock, 'tab-a').boot();
    clock.t += 20_000;
    const b = makeApp(name, clock, 'tab-b');
    await b.boot();
    expect(b.machine.state).toBe('LOBBY');
  });
});

describe('驗收：對局推進', () => {
  it('同一 tick 雙方阿斗同時歸零：只產生玩家敗北這一個結果', () => {
    const w = createWorld({ data, seed: 1, mapId: 0, totalRounds: 9, roundOfDay: 2, addHp: 0, aiEnabled: true });
    w.camps[0].lives = 0;
    w.camps[1].lives = 0;
    const ev = stepWorld(w, [], { data });
    expect(ev.filter((e) => e.type === 'ended')).toHaveLength(1);
    expect(w.result).toMatchObject({ outcome: 'lose', reason: 'player-dead' });
    expect(stepWorld(w, [], { data })).toEqual([]);
  });

  it('60Hz 與 120Hz（及長幀）推進相同時間，模擬 tick 數相同', () => {
    const run = (frameMs: number, totalMs: number) => {
      const w = createWorld({ data, seed: 2, mapId: 0, totalRounds: 9, roundOfDay: 2, addHp: 0, aiEnabled: true });
      const s = new BattleSession(w, { data });
      for (let t = 0; t < totalMs; t += frameMs) s.advance(frameMs);
      return w;
    };
    const a = run(1000 / 60, 6000);
    const b = run(1000 / 120, 6000);
    expect(Math.abs(a.tick - b.tick)).toBeLessThanOrEqual(1);
    expect(a.tick).toBeGreaterThan(295);
    // 單幀超長（卡頓）不暴衝：最多補 10 個 tick
    const c = run(1000, 3000);
    expect(c.tick).toBe(30);
  });
});

describe('驗收：跨日與重複進出', () => {
  it('對局進行中跨日：不清當日道具；結算回主畫面後才套用新的一天', async () => {
    const name = dbName();
    await seedVeteran(name, { items: [{ id: 17, level: 1 }] });
    const clock = { t: T0 };
    const app = makeApp(name, clock);
    await app.boot();
    await app.startBattle();
    await app.beginBattle();
    clock.t += DAY;
    await app.refreshDaily();
    expect(app.view.profile!.items).toEqual([{ id: 17, level: 1 }]);
    app.pause('USER');
    app.surrender();
    await flush(() => app.machine.state === 'RESULT');
    await app.backToLobby();
    expect(app.view.profile!.items).toEqual([]);
    expect(app.view.profile!.lastProcessedDay).toBe('2026-10-24');
  });

  it('重複進出對局十次：每局一個執行器，舊執行器的事件不影響新局，只扣該扣的體力', async () => {
    const name = dbName();
    await seedVeteran(name, { stamina: { value: 30, lastRecoverAt: T0 } });
    const clock = { t: T0 };
    const app = makeApp(name, clock);
    await app.boot();
    const sessions: BattleSession[] = [];
    for (let i = 0; i < 10; i++) {
      // 每局間隔 30 分鐘，體力回補 6 點，足夠下一局
      clock.t += 30 * 60_000;
      await app.startBattle();
      await app.beginBattle();
      const s = app.view.session!;
      sessions.push(s);
      s.advance(200);
      app.pause('USER');
      app.surrender();
      await flush(() => app.machine.state === 'RESULT');
      await app.backToLobby();
      expect(app.view.session).toBeNull();
    }
    expect(new Set(sessions).size).toBe(10);
    expect(app.view.profile!.stats.lose).toBe(3 + 10);
    // 舊執行器即使再被推進也不會改到目前狀態
    const before = JSON.stringify(app.view.profile);
    for (const s of sessions) s.advance(1000);
    expect(JSON.stringify(app.view.profile)).toBe(before);
  });
});

describe('驗收：恢復', () => {
  it('教學局重新整理：回到同一步，已用掉的教學注入不會再給', async () => {
    const name = dbName();
    const clock = { t: T0 };
    const a = makeApp(name, clock);
    await a.boot();
    await a.startBattle();
    await a.beginBattle();
    const s = a.view.session!;
    s.enqueue({ type: 'RECRUIT', side: 0 });
    for (let i = 0; i < 20; i++) s.advance(100);
    const step = s.world.tutorial!.step;
    const recruits = s.world.tutorial!.recruits;
    a.pause('USER');
    await flush();
    await a.releaseLease();

    const b = makeApp(name, clock);
    await b.boot();
    expect(b.machine.state).toBe('BATTLE_PAUSED');
    expect(b.view.session!.world.tutorial).toMatchObject({ step, recruits });
    expect(recruits).toBe(1);
  });

  it('規則版本已更新的舊快照：不硬讀，改以放棄結算並說明原因', async () => {
    const name = dbName();
    await seedVeteran(name);
    const clock = { t: T0 };
    const a = makeApp(name, clock);
    await a.boot();
    await a.startBattle();
    await a.beginBattle();
    await flush();
    const db = await openGameDb(name);
    const rec = (await db.get('battles', ACTIVE_KEY)) as Record<string, unknown>;
    await db.put('battles', { ...rec, rulesetVersion: 'web-ai-v0' }, ACTIVE_KEY);
    await a.releaseLease();

    const b = makeApp(name, clock);
    await b.boot();
    expect(b.machine.state).toBe('PROFILE_READY');
    expect(b.view.interrupted).toBe(true);
    expect(b.view.snapshotIssue).toContain('規則版本');
  });
});
