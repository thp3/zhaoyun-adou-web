// 存檔匯出：附 schemaVersion 與 SHA-256 checksum，用來偵測檔案損壞（不是防竄改）。

export const EXPORT_FORMAT = 'zhaoyun-adou-save';

export interface SaveExport {
  format: typeof EXPORT_FORMAT;
  exportedAt: number;
  profile: unknown;
  checksum: string;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildSaveExport(rawProfile: unknown, now: number): Promise<SaveExport> {
  return {
    format: EXPORT_FORMAT,
    exportedAt: now,
    profile: rawProfile,
    checksum: await sha256Hex(JSON.stringify(rawProfile)),
  };
}

export async function verifySaveExport(file: unknown): Promise<boolean> {
  if (!file || typeof file !== 'object') return false;
  const f = file as Partial<SaveExport>;
  if (f.format !== EXPORT_FORMAT || typeof f.checksum !== 'string') return false;
  return (await sha256Hex(JSON.stringify(f.profile))) === f.checksum;
}
