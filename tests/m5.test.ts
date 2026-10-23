import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { applyCommand } from '../src/domain/battle/commands';
import { createWorld, type CreateWorldParams } from '../src/domain/battle/create';
import { damageEnemy, spawnEnemy } from '../src/domain/battle/enemies';
import { stepWorld } from '../src/domain/battle/step';
import { ticks, type StepContext, type World } from '../src/domain/battle/types';
import { addFragments, backpack, equip, grantStarterWeapons, recycle, recyclePreview, weaponStock } from '../src/domain/profile/inventory';
import { createDefaultProfile, type Profile } from '../src/domain/profile/profile';
import { starToRank } from '../src/domain/profile/rank';
import { applySettlement } from '../src/domain/profile/settlement';
import { claimLottery, claimRankReward, createShopSession, drawLottery, purchase, resolveReplacement, shopCandidates } from '../src/domain/profile/shop';
import { openGameDb, PROFILE_KEY } from '../src/storage/db';
import { MetaStore } from '../src/storage/metaStore';

const data = loadGameData();
const rules = { data };
const ctx = (): StepContext => ({ data, events: [] });
const STAMINA = { max: 30, recoverIntervalMs: 300_000 };
const T0 = Date.UTC(2026, 9, 23, 4, 0, 0);
const profile = (over: Partial<Profile> = {}): Profile => ({ ...createDefaultProfile(T0, '2026-10-23', { staminaMax: 30 }), ...over });
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function world(over: Partial<CreateWorldParams> = {}): World {
  return createWorld({ data, seed: 3, mapId: 0, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: false, weaponUnlocked: true, ...over });
}

describe('碎片掉落', () => {
  it('玩家防區帶碎片的敵人被擊殺才掉；稀有度不會是普通', () => {
    const w = world();
    for (let i = 0; i < 30; i++) damageEnemy(w, spawnEnemy(w, 0, ctx(), { carries: true, hp: 1 }), 5, null, ctx());
    damageEnemy(w, spawnEnemy(w, 1, ctx(), { carries: true, hp: 1 }), 5, null, ctx());
    expect(w.drops).toHaveLength(30);
    for (const id of w.drops) expect(data.weapons.weapons.find((x) => x.id === id)!.rarity).toBeGreaterThan(0);
  });

  it('武器未解鎖不掉；走到阿斗也不掉', () => {
    const w = world({ weaponUnlocked: false });
    damageEnemy(w, spawnEnemy(w, 0, ctx(), { carries: true, hp: 1 }), 5, null, ctx());
    expect(w.drops).toHaveLength(0);
  });

  it('每波約 6.5% 指定一隻帶碎片的敵人', () => {
    let marked = 0;
    let waves = 0;
    for (let k = 1; k <= 30; k++) {
      const w = world();
      w.rng.combat = k * 7919;
      w.camps[0].lives = 1e9;
      for (let i = 0; i < 400_000 && !w.result; i++) {
        for (const e of stepWorld(w, [], rules)) {
          if (e.type !== 'waveStart') continue;
          waves++;
          if (w.fragmentIndex[0] >= 0) marked++;
        }
      }
    }
    expect(waves).toBe(600);
    expect(marked / waves).toBeGreaterThan(0.03);
    expect(marked / waves).toBeLessThan(0.11);
  }, 120_000);
});

describe('首局教程', () => {
  it('第一次征兵避開黃忠；第二次固定刀弓黃忠鏟；部署指引結束前不出兵；無盡不出 Boss', () => {
    const w = world({ tutorial: true });
    expect(w.difficulty).toBe(0);
    expect(w.aiDamageMultiplier).toBe(0.7);
    applyCommand(w, { type: 'RECRUIT', side: 0 }, ctx());
    const first = w.camps[0].slots.map((id) => w.actors[id!]!.token);
    expect(first.some((t) => t === 'huang' || t === 'zhong')).toBe(false);
    for (let i = 0; i < ticks(3000); i++) stepWorld(w, [], rules);
    expect(w.wave.phase).toBe('ready');
    for (let i = 0; i < ticks(3000); i++) stepWorld(w, [], rules);
    expect(w.wave.phase).not.toBe('ready');
    w.camps[0].gold = 100;
    applyCommand(w, { type: 'RECRUIT', side: 0 }, ctx());
    expect(w.camps[0].slots.map((id) => w.actors[id!]!.token)).toEqual(['blade', 'bow', 'huang', 'zhong', 'shovel']);
    expect(w.endless).toBe(true);
  });
});

describe('武器背包', () => {
  it('碎片換算完整件；同一件不可裝兩位；類型要相符', () => {
    let p = addFragments(profile(), [10, 10], data); // 長槍需 2 片
    expect(weaponStock(p, 10, data)).toMatchObject({ complete: 2 });
    p = addFragments(profile(), [11, 11], data);
    expect(p.newWeaponIds).toEqual([11]);
    const zhaoyun = data.generals.generals.find((g) => g.key === 'zhaoyun')!;
    const zhangfei = data.generals.generals.find((g) => g.key === 'zhangfei')!;
    const r1 = equip(p, zhaoyun.id, 11, data);
    expect(r1.ok).toBe(true);
    const r2 = equip((r1 as { profile: Profile }).profile, zhangfei.id, 11, data);
    expect(r2).toEqual({ ok: false, reason: '這把武器已經裝在其他武將身上' });
    const huangzhong = data.generals.generals.find((g) => g.key === 'huangzhong')!;
    expect(equip(p, huangzhong.id, 11, data).ok).toBe(false);
  });

  it('回收：已裝備的保留；依稀有度單價換金幣', () => {
    let p = addFragments(profile(), [0, 0, 1, 1, 1], data); // 短弓 2 件、長弓 1 件＋1 片
    p = (equip(p, data.generals.generals.find((g) => g.key === 'huangzhong')!.id, 0, data) as { profile: Profile }).profile;
    const pre = recyclePreview(p, [0, 1], data);
    expect(pre.gold).toBe(1 * 1 + 3 * 2);
    const r = recycle(p, [0, 1], data);
    expect(r.ok && r.profile.weaponFragments).toEqual({ '0': 1 });
    expect(r.ok && r.profile.gold).toBe(7);
  });

  it('註冊第 3 天發四把普通武器，只發一次', () => {
    const p = grantStarterWeapons(profile(), 3, data);
    expect(p.weaponFree).toBe(true);
    expect(backpack(p, data).filter((s) => s.complete > 0)).toHaveLength(4);
    expect(grantStarterWeapons(p, 4, data)).toBe(p);
    expect(grantStarterWeapons(profile(), 2, data).weaponFree).toBe(false);
  });

  it('結算入帳碎片並解鎖圖鑑', () => {
    const { profile: p } = applySettlement(profile(), { battleId: 'b', rulesetVersion: 'v', outcome: 'lose', reason: 'player-dead', wave: 3, tick: 1, kills: 1, drops: [5, 5], formed: ['zhaoyun'] }, data);
    expect(p.weaponFragments).toEqual({ '5': 2 });
    expect(p.mergedGenerals).toEqual(['zhaoyun']);
  });
});

describe('商店與輪盤', () => {
  it('候選排除鏟子、推土車與已持有的一般道具；升級道具給下一級', () => {
    const p = profile({ items: [{ id: 2, level: 1 }, { id: 22, level: 1 }] });
    const c = shopCandidates(p, data);
    expect(c.map((o) => o.itemId)).not.toContain(0);
    expect(c.map((o) => o.itemId)).not.toContain(1);
    expect(c.map((o) => o.itemId)).not.toContain(2);
    expect(c.find((o) => o.itemId === 22)).toMatchObject({ level: 2 });
  });

  it('買一件整組售罄；容量滿拒絕；行軍丹補體力不佔格', () => {
    const p = profile({ gold: 1000, stamina: { value: 10, lastRecoverAt: T0 } });
    const s = { sessionId: 's', createdAt: T0, soldOut: false, offers: [{ itemId: 23, level: 1, price: 40 }, { itemId: 2, level: 1, price: 50 }] };
    const r = purchase(p, s, 0, data, T0, STAMINA);
    expect(r.ok && r.profile.stamina.value).toBe(20);
    expect(r.ok && r.profile.items).toEqual([]);
    expect(r.ok && r.session.soldOut).toBe(true);
    expect(purchase(p, (r as { session: typeof s }).session, 1, data, T0, STAMINA)).toEqual({ ok: false, reason: '本次商品已售罄' });
    const full = profile({ gold: 1000, items: [{ id: 3, level: 1 }, { id: 4, level: 1 }] });
    expect(purchase(full, s, 1, data, T0, STAMINA)).toEqual({ ok: false, reason: '主動道具最多 2 個' });
  });

  it('輪盤：8 格不重複、先定獎項；槽滿需選替換，替換與放棄都降權', () => {
    const p = profile();
    const d = drawLottery(p, data, rand)!;
    expect(d.slots).toHaveLength(8);
    expect(new Set(d.slots.map((s) => s.itemId)).size).toBe(8);
    expect(d.winner).toBeGreaterThanOrEqual(0);
    const full = profile({ items: [{ id: 3, level: 1 }, { id: 4, level: 1 }] });
    const offer = { itemId: 5, level: 1, price: 0 };
    expect(claimLottery(full, offer, data, T0, STAMINA).kind).toBe('needsReplacement');
    const replaced = resolveReplacement(full, offer, 3, data, T0, STAMINA);
    expect(replaced.items.map((i) => i.id).sort()).toEqual([4, 5]);
    expect(replaced.lowPriorityItems.sort()).toEqual([3, 5]);
    const gaveUp = resolveReplacement(full, offer, null, data, T0, STAMINA);
    expect(gaveUp.items).toEqual(full.items);
    expect(gaveUp.lowPriorityItems).toEqual([5]);
  });

  it('段位每日獎勵：依 lastStar 段位，一天一次', () => {
    const p = profile({ rank: { curStar: 30, lastStar: 12, rewardClaimedDay: null } });
    const r = claimRankReward(p, '2026-10-23', data, (s) => starToRank(s).rankId)!;
    expect(r.gold).toBe(data.ranks.ranks[2]!.reward);
    expect(claimRankReward(r.profile, '2026-10-23', data, (s) => starToRank(s).rankId)).toBeNull();
  });

  it('商店活動保存：重開沿用同一批；買完再開換新的；同一活動不能買兩次', async () => {
    const db = await openGameDb('m5-shop');
    await db.put('profile', profile({ gold: 1000 }), PROFILE_KEY);
    const store = new MetaStore(db);
    let n = 0;
    const make = (p: Profile) => createShopSession(p, data, rand, T0, `s${++n}`);
    const a = await store.openShop(make);
    const b = await store.openShop(make);
    expect(b.sessionId).toBe(a.sessionId);
    const buy = (id: string) => store.buy(id, (p, s) => purchase(p, s, 0, data, T0, STAMINA));
    expect((await buy(a.sessionId)).ok).toBe(true);
    expect(await buy(a.sessionId)).toEqual({ ok: false, reason: '本次商品已售罄' });
    const c = await store.openShop(make);
    expect(c.sessionId).not.toBe(a.sessionId);
  });
});
