// 存檔格式遷移。每一版一個函式，只往前遷；比目前程式新的存檔一律不碰。
import { PROFILE_SCHEMA_VERSION, ProfileSchema, type Profile } from '../domain/profile/profile';

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>;

/** key = 來源版本；回傳下一版的資料 */
const MIGRATIONS: Record<number, Migration> = {};

export type MigrationResult =
  | { kind: 'ok'; profile: Profile; migrated: boolean }
  | { kind: 'too-new'; version: number }
  | { kind: 'corrupt'; issues: string[] };

export function migrateProfile(raw: unknown): MigrationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'corrupt', issues: ['存檔不是物件'] };
  }
  let data = raw as Record<string, unknown>;
  let version = data.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { kind: 'corrupt', issues: ['缺少有效的 schemaVersion'] };
  }
  if (version > PROFILE_SCHEMA_VERSION) return { kind: 'too-new', version };

  const migrated = version < PROFILE_SCHEMA_VERSION;
  while (version < PROFILE_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) return { kind: 'corrupt', issues: [`沒有 v${version} 的遷移`] };
    data = step(data);
    version += 1;
  }
  const parsed = ProfileSchema.safeParse(data);
  if (!parsed.success) {
    return {
      kind: 'corrupt',
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`),
    };
  }
  return { kind: 'ok', profile: parsed.data, migrated };
}
