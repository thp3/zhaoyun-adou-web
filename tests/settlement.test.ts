import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { AppController } from '../src/app/appController';
import { loadGameData } from '../src/data';
import { createDefaultProfile } from '../src/domain/profile/profile';
import { applySettlement, changeRankStar, selectMapId, settlementGold, type ResultDraft } from '../src/domain/profile/settlement';
import { ACTIVE_KEY, BattleStore } from '../src/storage/battleStore';
import { openGameDb, PROFILE_KEY } from '../src/storage/db';

const data = loadGameData();
const ranks = data.ranks.ranks;
const T0 = Date.UTC(2026, 9, 23, 4, 0, 0); // 台北 10/23（週五）12:00
const RULES = { max: 30, recoverIntervalMs: 300_000 };
let n = 0;
const dbName = () => `settle-db-${++n}`;

const draft = (over: Partial<ResultDraft> = {}): ResultDraft => ({
  battleId: 'b1',
  rulesetVersion: 'web-ai-v1',
  outcome: 'win',
  reason: 'waves-cleared',
  wave: 20,
  tick: 1000,
  kills: 50,
  drops: [],
  formed: [],
  ...over,
});

describe('段位升降（原版 Pt.Cu）', () => {
  it('初始 0 星：第一次勝寫 2、第一次敗寫 1', () => {
    expect(changeRankStar(0, 1, ranks)).toBe(2);
    expect(changeRankStar(0, -1, ranks)).toBe(1);
  });
  it('一般段位升級與降級', () => {
    expect(changeRankStar(5, 1, ranks)).toBe(6); // 軍士.一 5 星 → 軍士.二 1 星
    expect(changeRankStar(6, -1, ranks)).toBe(5); // 軍士.二 1 星敗 → 前段滿星
    expect(changeRankStar(1, -1, ranks)).toBe(1); // 最低不再降
  });
  it('進入與跌出皇帝', () => {
    expect(changeRankStar(250, 1, ranks)).toBe(251);
    expect(changeRankStar(251, -1, ranks)).toBe(250);
    expect(changeRankStar(275, 1, ranks)).toBe(276); // 50→51，星數連續
    expect(changeRankStar(276, -1, ranks)).toBe(275);
    expect(changeRankStar(400, 1, ranks)).toBe(401); // 53 不封頂
  });
});

describe('結算金幣政策', () => {
  it('勝 20、敗 5、第 5 波前放棄 0、第 5 波起放棄 5', () => {
    expect(settlementGold(draft(), data)).toBe(20);
    expect(settlementGold(draft({ outcome: 'lose', reason: 'player-dead', wave: 2 }), data)).toBe(5);
    expect(settlementGold(draft({ outcome: 'lose', reason: 'surrender', wave: 4 }), data)).toBe(0);
    expect(settlementGold(draft({ outcome: 'lose', reason: 'surrender', wave: 5 }), data)).toBe(5);
  });
  it('套用勝場：局數、當日、連勝、段位、教學旗標', () => {
    const p = createDefaultProfile(T0, '2026-10-23', { staminaMax: 30 });
    const { profile, delta } = applySettlement(p, draft(), data);
    expect(delta).toEqual({ outcome: 'win', goldDelta: 20, starBefore: 0, starAfter: 2, drops: [] });
    expect(profile.stats).toEqual({ win: 1, lose: 0, winDay: 1, loseDay: 0, winStreak: 1 });
    expect(profile.tutorial.firstBattleDone).toBe(true);
  });
});

describe('選圖', () => {
  it('註冊首日每 7 局輪換；之後依星期', () => {
    const p = createDefaultProfile(T0, '2026-10-23', { staminaMax: 30 });
    expect(selectMapId(p, T0, data)).toBe(0);
    expect(selectMapId({ ...p, stats: { ...p.stats, winDay: 7 } }, T0, data)).toBe(1);
    const old = { ...p, registerDay: '2026-10-01' };
    expect(selectMapId(old, T0, data)).toBe(data.maps.rotation.weekdayMonToSun[4]); // 週五
  });
});

describe('開局與結算交易', () => {
  async function seeded(stamina = 30) {
    const db = await openGameDb(dbName());
    const p = createDefaultProfile(T0, '2026-10-23', { staminaMax: 30 });
    await db.put('profile', { ...p, stamina: { value: stamina, lastRecoverAt: T0 } }, PROFILE_KEY);
    return { db, store: new BattleStore(db) };
  }
  const startArgs = (id: string) => ({
    now: T0,
    battleId: id,
    rulesetVersion: 'web-ai-v1',
    cost: 5,
    stamina: RULES,
    makeSetup: () => ({ seed: 1, mapId: 0, totalRounds: 0, roundOfDay: 1, addHp: 0, aiEnabled: false, difficulty: 0, aiStar: 0, playerEquip: new Array(12).fill(-1), aiEquip: new Array(12).fill(-1), playerItems: [], aiItems: [], weaponUnlocked: false, tutorial: false }),
  });

  it('連點開始：只建立一場、只扣一次 5 體力', async () => {
    const { db, store } = await seeded();
    const [a, b] = await Promise.all([store.start(startArgs('x1')), store.start(startArgs('x2'))]);
    expect([a.kind, b.kind].sort()).toEqual(['created', 'existing']);
    const p = (await db.get('profile', PROFILE_KEY)) as { stamina: { value: number } };
    expect(p.stamina.value).toBe(25);
  });

  it('體力不足不建立對局', async () => {
    const { db, store } = await seeded(4);
    expect((await store.start(startArgs('x'))).kind).toBe('no-stamina');
    expect(await db.get('battles', ACTIVE_KEY)).toBeUndefined();
  });

  it('PREPARED 取消只退款一次；已開始不可退款', async () => {
    const { store } = await seeded();
    await store.start(startArgs('c1'));
    const p1 = await store.cancelPrepared('c1', T0, RULES);
    expect(p1.stamina.value).toBe(30);
    const p2 = await store.cancelPrepared('c1', T0, RULES);
    expect(p2.stamina.value).toBe(30);
    await store.start(startArgs('c2'));
    await store.markStarted('c2', T0);
    await expect(store.cancelPrepared('c2', T0, RULES)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('結算重試只入帳一次', async () => {
    const { store } = await seeded();
    await store.start(startArgs('s1'));
    await store.markStarted('s1', T0);
    await store.markSettlementPending(draft({ battleId: 's1' }));
    // 第二份草稿不覆蓋第一份
    await store.markSettlementPending(draft({ battleId: 's1', outcome: 'lose', reason: 'player-dead' }));
    const apply = (p: Parameters<typeof applySettlement>[0], d: ResultDraft) => applySettlement(p, d, data);
    const first = await store.settle('s1', T0, apply);
    const second = await store.settle('s1', T0, apply);
    expect(first.profile.gold).toBe(20);
    expect(second.profile.gold).toBe(20);
    expect(second.receipt).toEqual(first.receipt);
    expect(await store.getActive()).toBeNull();
  });
});

describe('AppController 完整一局', () => {
  it('開局扣體力 → 開戰 → 放棄 → 結算 → 回主畫面', async () => {
    const name = dbName();
    const app = new AppController({ clock: { now: () => T0 }, openDb: () => openGameDb(name), random: () => 0.5, autoRun: false });
    await app.boot();
    await app.startBattle();
    expect(app.machine.state).toBe('OPPONENT_PRESENTATION');
    expect(app.view.profile!.stamina.value).toBe(25);
    await app.beginBattle();
    expect(app.machine.state).toBe('BATTLE_RUNNING');
    app.view.session!.advance(1000);
    expect(app.view.session!.world.tick).toBe(10); // 單 frame 最多 10 tick
    app.pause('USER');
    expect(app.machine.state).toBe('BATTLE_PAUSED');
    app.surrender();
    await vitestFlush(() => app.machine.state === 'RESULT');
    expect(app.view.receipt!.delta).toMatchObject({ outcome: 'lose', goldDelta: 0 });
    expect(app.view.profile!.stats.lose).toBe(1);
    await app.backToLobby();
    expect(app.machine.state).toBe('LOBBY');
  });

  it('切頁暫停後，只關掉暫停選單不會自己跑；玩家按繼續才恢復', async () => {
    const name = dbName();
    const app = new AppController({ clock: { now: () => T0 }, openDb: () => openGameDb(name), random: () => 0.3, autoRun: false });
    await app.boot();
    await app.startBattle();
    await app.beginBattle();
    app.pause('PAGE_HIDDEN');
    const t = app.view.session!.world.tick;
    app.view.session!.advance(500);
    expect(app.view.session!.world.tick).toBe(t);
    app.resume();
    expect(app.machine.state).toBe('BATTLE_RUNNING');
  });

  it('重新整理遇到已開始的對局：以最後保存波次放棄結算，只一次', async () => {
    const name = dbName();
    const mk = () => new AppController({ clock: { now: () => T0 }, openDb: () => openGameDb(name), random: () => 0.7, autoRun: false });
    const a = mk();
    await a.boot();
    await a.startBattle();
    await a.beginBattle();
    const store = new BattleStore(await openGameDb(name));
    await store.saveProgress(a.view.battle!.battleId, { wave: 6, tick: 9000, kills: 12 });

    const b = mk();
    await b.boot();
    expect(b.machine.state).toBe('PROFILE_READY');
    expect(b.view.interrupted).toBe(true);
    await b.settleInterrupted();
    expect(b.machine.state).toBe('RESULT');
    expect(b.view.receipt!.delta).toMatchObject({ outcome: 'lose', goldDelta: 5 });

    const c = mk();
    await c.boot();
    expect(c.machine.state).toBe('LOBBY');
    expect(c.view.profile!.gold).toBe(5);
    expect(c.view.profile!.stats.lose).toBe(1);
  });
});

async function vitestFlush(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
}
