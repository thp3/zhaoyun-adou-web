// 商店活動的保存與購買交易：Profile 與商店活動在同一個交易內更新，重新整理不會重抽商品，也不會買兩次。
import type { Profile } from '../domain/profile/profile';
import type { ShopSession } from '../domain/profile/shop';
import { PROFILE_KEY, type GameDatabase } from './db';
import { migrateProfile } from './migrations';
import { checkFence, StorageError, type Fence } from './errors';

const SHOP_KEY = 'shop';

function parseProfile(raw: unknown): Profile {
  const r = migrateProfile(raw);
  if (r.kind !== 'ok' || r.migrated) throw new StorageError('corrupt', '存檔需要重新載入');
  return r.profile;
}

export class MetaStore {
  constructor(
    private readonly db: GameDatabase,
    private readonly fence?: Fence,
  ) {}

  /** 打開商店：沿用尚未售罄的活動；已售罄或沒有才依目前存檔建立新活動 */
  async openShop(make: (p: Profile) => ShopSession): Promise<ShopSession> {
    const tx = this.db.transaction(['profile', 'shopOps', 'meta'], 'readwrite');
    await checkFence(tx, this.fence);
    const current = (await tx.objectStore('shopOps').get(SHOP_KEY)) as ShopSession | undefined;
    if (current && !current.soldOut) {
      await tx.done;
      return current;
    }
    const session = make(parseProfile(await tx.objectStore('profile').get(PROFILE_KEY)));
    await tx.objectStore('shopOps').put(session, SHOP_KEY);
    await tx.done;
    return session;
  }

  /** 購買：同一交易核對活動、扣金幣、給道具並標記售罄 */
  async buy(
    sessionId: string,
    apply: (p: Profile, s: ShopSession) => { ok: true; profile: Profile; session: ShopSession } | { ok: false; reason: string },
  ): Promise<{ ok: true; profile: Profile; session: ShopSession } | { ok: false; reason: string }> {
    const tx = this.db.transaction(['profile', 'shopOps', 'meta'], 'readwrite');
    await checkFence(tx, this.fence);
    const session = (await tx.objectStore('shopOps').get(SHOP_KEY)) as ShopSession | undefined;
    const profile = parseProfile(await tx.objectStore('profile').get(PROFILE_KEY));
    if (!session || session.sessionId !== sessionId) {
      await tx.done;
      return { ok: false, reason: '商品已更新，請重新打開商店' };
    }
    const r = apply(profile, session);
    if (!r.ok) {
      await tx.done;
      return r;
    }
    const next: Profile = { ...r.profile, revision: profile.revision + 1 };
    await tx.objectStore('profile').put(next, PROFILE_KEY);
    await tx.objectStore('shopOps').put(r.session, SHOP_KEY);
    await tx.done;
    return { ok: true, profile: next, session: r.session };
  }
}
