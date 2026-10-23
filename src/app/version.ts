// 版本資訊與新版檢查。四種版本分開：程式版本、資料規則版本、存檔格式版本、資料庫結構版本。
import { PROFILE_SCHEMA_VERSION } from '../domain/profile/profile';
import { DB_VERSION } from '../storage/db';

declare const __BUILD__: { appVersion: string; commit: string; rulesetVersion: string; builtAt: string } | undefined;

export interface BuildInfo {
  appVersion: string;
  commit: string;
  rulesetVersion: string;
  builtAt: string;
}

/** 建置時注入；測試環境沒有注入時給開發值 */
export const BUILD: BuildInfo =
  typeof __BUILD__ !== 'undefined' ? __BUILD__ : { appVersion: '0.0.0', commit: 'dev', rulesetVersion: 'dev', builtAt: '' };

export const VERSIONS = {
  app: BUILD.appVersion,
  commit: BUILD.commit,
  ruleset: BUILD.rulesetVersion,
  saveSchema: PROFILE_SCHEMA_VERSION,
  db: DB_VERSION,
};

/** 讀取伺服器上的 version.json；與目前執行的提交不同代表有新版（開發模式不檢查） */
export async function checkForUpdate(fetchImpl: typeof fetch = fetch): Promise<BuildInfo | null> {
  if (BUILD.commit === 'dev') return null;
  try {
    const res = await fetchImpl(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const remote = (await res.json()) as BuildInfo;
    return remote.commit && remote.commit !== BUILD.commit ? remote : null;
  } catch {
    // 離線或暫時失敗：不打擾玩家
    return null;
  }
}
