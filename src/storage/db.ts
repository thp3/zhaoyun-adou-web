// IndexedDB 結構。所有 store 在 v1 就先建立，之後里程碑只加資料不必升版。
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const DB_NAME = 'zhaoyun-adou';
export const DB_VERSION = 1;
export const PROFILE_KEY = 'main';

export interface GameDB extends DBSchema {
  /** 永久進度；只有一筆 key='main'，值未經驗證前一律視為 unknown */
  profile: { key: string; value: unknown };
  /** 遷移或重建前保存的原始存檔，不自動刪除 */
  backups: { key: number; value: { savedAt: number; reason: string; raw: unknown } };
  /** 未完成對局快照（M2 起使用） */
  battles: { key: string; value: unknown };
  /** 結算收據，去重用（M2 起使用） */
  receipts: { key: string; value: unknown };
  /** 商店／輪盤操作（M5 起使用） */
  shopOps: { key: string; value: unknown };
  /** 寫入權租約等雜項（M6 起使用） */
  meta: { key: string; value: unknown };
}

export type GameDatabase = IDBPDatabase<GameDB>;

export function openGameDb(name = DB_NAME): Promise<GameDatabase> {
  return openDB<GameDB>(name, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('profile');
        db.createObjectStore('backups', { autoIncrement: true });
        db.createObjectStore('battles');
        db.createObjectStore('receipts');
        db.createObjectStore('shopOps');
        db.createObjectStore('meta');
      }
    },
  });
}
