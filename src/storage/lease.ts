// 多分頁寫入權（owner lease ＋ fencing token）。同一份進度只允許一個分頁寫入：
// 取得時編號 +1；之後每個寫入交易都核對編號，舊分頁的寫入會被整筆拒絕。
// 租約有到期時間，持有分頁定期續約；關掉的分頁不續約，到期後其他分頁可直接接手。
import type { GameDatabase } from './db';
import { LEASE_KEY, type Fence, type LeaseRecord } from './errors';

export const LEASE_TTL_MS = 15_000;
export const HEARTBEAT_MS = 5_000;

export type AcquireResult = { kind: 'owner'; token: number } | { kind: 'busy'; expiresAt: number };

export class Lease {
  /** 供 repository 核對；未取得前為 null（不檢查） */
  readonly fence: Fence = { token: null };

  constructor(
    private readonly db: GameDatabase,
    readonly ownerId: string,
  ) {}

  /** 取得寫入權；force=true 時即使另一分頁仍有效也接手 */
  async acquire(now: number, force = false): Promise<AcquireResult> {
    const tx = this.db.transaction('meta', 'readwrite');
    const cur = (await tx.store.get(LEASE_KEY)) as LeaseRecord | undefined;
    if (cur && cur.ownerId !== this.ownerId && cur.expiresAt > now && !force) {
      await tx.done;
      return { kind: 'busy', expiresAt: cur.expiresAt };
    }
    const token = (cur?.token ?? 0) + 1;
    await tx.store.put({ ownerId: this.ownerId, token, expiresAt: now + LEASE_TTL_MS } satisfies LeaseRecord, LEASE_KEY);
    await tx.done;
    this.fence.token = token;
    return { kind: 'owner', token };
  }

  /** 續約；編號已被接手時回傳 false（本分頁失去寫入權） */
  async heartbeat(now: number): Promise<boolean> {
    if (this.fence.token === null) return false;
    const tx = this.db.transaction('meta', 'readwrite');
    const cur = (await tx.store.get(LEASE_KEY)) as LeaseRecord | undefined;
    if (!cur || cur.token !== this.fence.token) {
      await tx.done;
      return false;
    }
    await tx.store.put({ ...cur, expiresAt: now + LEASE_TTL_MS }, LEASE_KEY);
    await tx.done;
    return true;
  }

  /** 正常關閉分頁時讓出，其他分頁不必等到期 */
  async release(): Promise<void> {
    if (this.fence.token === null) return;
    const tx = this.db.transaction('meta', 'readwrite');
    const cur = (await tx.store.get(LEASE_KEY)) as LeaseRecord | undefined;
    if (cur && cur.token === this.fence.token) await tx.store.put({ ...cur, expiresAt: 0 }, LEASE_KEY);
    await tx.done;
  }
}
