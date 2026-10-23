// 存檔層共用錯誤與寫入權核對（fencing token）。
import type { IDBPTransaction, StoreNames } from 'idb';
import type { GameDB } from './db';

export class StorageError extends Error {
  constructor(
    readonly code: 'exists' | 'missing' | 'corrupt' | 'conflict' | 'ownership',
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** 本分頁持有的寫入權編號；null 表示不檢查（測試或單一環境） */
export interface Fence {
  token: number | null;
}

export const LEASE_KEY = 'lease';

export interface LeaseRecord {
  ownerId: string;
  token: number;
  expiresAt: number;
}

type AnyTx = IDBPTransaction<GameDB, StoreNames<GameDB>[], 'readwrite'>;

/**
 * 在寫入交易內核對租約：編號不符代表另一分頁已接手，整筆交易放棄。
 * 呼叫端的交易必須包含 meta store。
 */
export async function checkFence(tx: AnyTx, fence: Fence | undefined): Promise<void> {
  if (!fence || fence.token === null) return;
  const lease = (await tx.objectStore('meta').get(LEASE_KEY)) as LeaseRecord | undefined;
  if (!lease || lease.token !== fence.token) {
    tx.abort();
    await tx.done.catch(() => undefined);
    throw new StorageError('ownership', '遊戲已在其他分頁開啟');
  }
}
