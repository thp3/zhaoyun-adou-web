// 開局、取消、結算交易。每個交易同時涵蓋 profile / battles / receipts，等 complete 才回報成功；
// 以 battleId 為唯一鍵去重：重試只會回傳同一結果，不會扣兩次或發兩次獎勵。
import { z } from 'zod';
import type { Profile } from '../domain/profile/profile';
import type { ResultDraft, SettlementDelta } from '../domain/profile/settlement';
import { addStamina, spendStamina, type StaminaRules } from '../domain/profile/stamina';
import { PROFILE_KEY, type GameDatabase } from './db';
import { migrateProfile } from './migrations';
import { StorageError } from './profileRepository';

export const ACTIVE_KEY = 'active';

const DraftSchema = z.object({
  battleId: z.string(),
  rulesetVersion: z.string(),
  outcome: z.enum(['win', 'lose']),
  reason: z.enum(['player-dead', 'ai-dead', 'waves-cleared', 'surrender']),
  wave: z.number().int().nonnegative(),
  tick: z.number().int().nonnegative(),
  kills: z.number().int().nonnegative(),
});

export const BattleRecordSchema = z.object({
  battleId: z.string(),
  phase: z.enum(['PREPARED', 'STARTED', 'SETTLEMENT_PENDING']),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  rulesetVersion: z.string(),
  staminaCost: z.number().int().nonnegative(),
  setup: z.object({
    seed: z.number().int(),
    mapId: z.number().int().min(0).max(3),
    totalRounds: z.number().int().nonnegative(),
    roundOfDay: z.number().int().positive(),
    addHp: z.number().nonnegative(),
    aiEnabled: z.boolean(),
    // M2 的紀錄沒有以下欄位：缺省為難度 0、對手 0 星
    difficulty: z.number().int().min(0).max(3).default(0),
    aiStar: z.number().int().nonnegative().default(0),
  }),
  progress: z.object({ wave: z.number().int().nonnegative(), tick: z.number().int().nonnegative(), kills: z.number().int().nonnegative() }),
  resultDraft: DraftSchema.nullable(),
});
export type BattleRecord = z.output<typeof BattleRecordSchema>;
export type BattleSetup = BattleRecord['setup'];

export interface Receipt {
  battleId: string;
  kind: 'settled' | 'cancelled';
  createdAt: number;
  delta: SettlementDelta | null;
  staminaRefund: number;
  draft: ResultDraft | null;
}

type Tx = ReturnType<GameDatabase['transaction']>;

function parseProfile(raw: unknown): Profile {
  const r = migrateProfile(raw);
  if (r.kind !== 'ok' || r.migrated) throw new StorageError('corrupt', '存檔需要重新載入');
  return r.profile;
}

function parseRecord(raw: unknown): BattleRecord | null {
  if (raw === undefined) return null;
  const r = BattleRecordSchema.safeParse(raw);
  if (!r.success) throw new StorageError('corrupt', '對局紀錄損壞');
  return r.data;
}

async function abort<T>(tx: Tx, err: Error): Promise<T> {
  tx.abort();
  await tx.done.catch(() => undefined);
  throw err;
}

export type StartOutcome =
  | { kind: 'created'; record: BattleRecord; profile: Profile }
  | { kind: 'existing'; record: BattleRecord }
  | { kind: 'no-stamina'; profile: Profile };

export class BattleStore {
  constructor(private readonly db: GameDatabase) {}

  async getActive(): Promise<BattleRecord | null> {
    return parseRecord(await this.db.get('battles', ACTIVE_KEY));
  }

  async getReceipt(battleId: string): Promise<Receipt | null> {
    return ((await this.db.get('receipts', battleId)) as Receipt | undefined) ?? null;
  }

  /** 同一交易：查未完成對局 → 補計並扣體力 → 建立 PREPARED 紀錄 */
  async start(args: {
    now: number;
    battleId: string;
    rulesetVersion: string;
    cost: number;
    stamina: StaminaRules;
    makeSetup: (p: Profile) => BattleSetup;
  }): Promise<StartOutcome> {
    const tx = this.db.transaction(['profile', 'battles'], 'readwrite');
    const existing = parseRecord(await tx.objectStore('battles').get(ACTIVE_KEY));
    if (existing) {
      await tx.done;
      return { kind: 'existing', record: existing };
    }
    const raw = await tx.objectStore('profile').get(PROFILE_KEY);
    if (raw === undefined) return abort(tx, new StorageError('missing', '找不到存檔'));
    const profile = parseProfile(raw);
    const stamina = spendStamina(profile.stamina, args.cost, args.now, args.stamina);
    if (!stamina) {
      await tx.done;
      return { kind: 'no-stamina', profile };
    }
    const next: Profile = { ...profile, stamina, revision: profile.revision + 1 };
    const record: BattleRecord = {
      battleId: args.battleId,
      phase: 'PREPARED',
      createdAt: args.now,
      startedAt: null,
      rulesetVersion: args.rulesetVersion,
      staminaCost: args.cost,
      setup: args.makeSetup(profile),
      progress: { wave: 0, tick: 0, kills: 0 },
      resultDraft: null,
    };
    await tx.objectStore('profile').put(next, PROFILE_KEY);
    await tx.objectStore('battles').put(record, ACTIVE_KEY);
    await tx.done;
    return { kind: 'created', record, profile: next };
  }

  /** 尚未開始的對局取消：唯一一次退還體力（封頂），不計勝敗 */
  async cancelPrepared(battleId: string, now: number, stamina: StaminaRules): Promise<Profile> {
    const tx = this.db.transaction(['profile', 'battles', 'receipts'], 'readwrite');
    const raw = await tx.objectStore('profile').get(PROFILE_KEY);
    const profile = parseProfile(raw);
    if (await tx.objectStore('receipts').get(battleId)) {
      await tx.done;
      return profile;
    }
    const record = parseRecord(await tx.objectStore('battles').get(ACTIVE_KEY));
    if (!record || record.battleId !== battleId) return abort(tx, new StorageError('missing', '找不到這場對局'));
    if (record.phase !== 'PREPARED') return abort(tx, new StorageError('conflict', '對局已開始，不能退款'));
    const next: Profile = {
      ...profile,
      stamina: addStamina(profile.stamina, record.staminaCost, now, stamina),
      revision: profile.revision + 1,
    };
    const receipt: Receipt = { battleId, kind: 'cancelled', createdAt: now, delta: null, staminaRefund: record.staminaCost, draft: null };
    await tx.objectStore('profile').put(next, PROFILE_KEY);
    await tx.objectStore('receipts').put(receipt, battleId);
    await tx.objectStore('battles').delete(ACTIVE_KEY);
    await tx.done;
    return next;
  }

  private async patchActive(battleId: string, patch: (r: BattleRecord) => BattleRecord | null): Promise<BattleRecord | null> {
    const tx = this.db.transaction('battles', 'readwrite');
    const record = parseRecord(await tx.store.get(ACTIVE_KEY));
    if (!record || record.battleId !== battleId) {
      await tx.done;
      return null;
    }
    const next = patch(record);
    if (next) await tx.store.put(next, ACTIVE_KEY);
    await tx.done;
    return next ?? record;
  }

  markStarted(battleId: string, now: number): Promise<BattleRecord | null> {
    return this.patchActive(battleId, (r) => (r.phase === 'PREPARED' ? { ...r, phase: 'STARTED', startedAt: now } : null));
  }

  saveProgress(battleId: string, progress: BattleRecord['progress']): Promise<BattleRecord | null> {
    return this.patchActive(battleId, (r) => (r.phase === 'STARTED' ? { ...r, progress } : null));
  }

  /** 先凍結 ResultDraft；已有草稿時保留第一份，不覆寫 */
  markSettlementPending(draft: ResultDraft): Promise<BattleRecord | null> {
    return this.patchActive(draft.battleId, (r) =>
      r.resultDraft ? null : { ...r, phase: 'SETTLEMENT_PENDING', resultDraft: draft },
    );
  }

  /** 結算交易：已有收據直接回傳；否則套用 delta、寫收據、清除 activeBattle */
  async settle(
    battleId: string,
    now: number,
    apply: (p: Profile, draft: ResultDraft) => { profile: Profile; delta: SettlementDelta },
  ): Promise<{ receipt: Receipt; profile: Profile }> {
    const tx = this.db.transaction(['profile', 'battles', 'receipts'], 'readwrite');
    const profile = parseProfile(await tx.objectStore('profile').get(PROFILE_KEY));
    const done = (await tx.objectStore('receipts').get(battleId)) as Receipt | undefined;
    if (done) {
      await tx.done;
      return { receipt: done, profile };
    }
    const record = parseRecord(await tx.objectStore('battles').get(ACTIVE_KEY));
    if (!record || record.battleId !== battleId || !record.resultDraft) {
      return abort(tx, new StorageError('missing', '找不到待結算的對局'));
    }
    const { profile: applied, delta } = apply(profile, record.resultDraft);
    const next: Profile = { ...applied, revision: profile.revision + 1 };
    const receipt: Receipt = { battleId, kind: 'settled', createdAt: now, delta, staminaRefund: 0, draft: record.resultDraft };
    await tx.objectStore('profile').put(next, PROFILE_KEY);
    await tx.objectStore('receipts').put(receipt, battleId);
    await tx.objectStore('battles').delete(ACTIVE_KEY);
    await tx.done;
    return { receipt, profile: next };
  }
}
