// 對局快照：World 本身就是純資料，直接深拷貝保存；載入時先檢查格式與延遲事件白名單，
// 遇到不認得的資料寧可拒絕恢復（改以放棄結算），也不硬讀後繼續發獎。
import type { ScheduledAction, World } from './types';

const KNOWN_ACTIONS = new Set<ScheduledAction['kind']>([
  'enterSlot',
  'meleeHit',
  'fireArrow',
  'spearThrust',
  'cavalrySweep',
  'jumpSlash',
  'warCry',
  'rocket',
  'arrowRain',
  'reviveZombie',
  'puppet',
  'demolish',
  'weaponFx',
  'itemFx',
]);

export function takeSnapshot(w: World): World {
  return structuredClone(w);
}

export type SnapshotCheck = { ok: true; world: World } | { ok: false; reason: string };

export function restoreSnapshot(raw: unknown): SnapshotCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '沒有快照' };
  const w = raw as Partial<World>;
  if (w.schema !== 1) return { ok: false, reason: `不支援的快照版本 ${String(w.schema)}` };
  if (!Number.isInteger(w.tick) || !w.camps || !w.actors || !w.enemies || !w.wave || !w.rng || !Array.isArray(w.scheduled)) {
    return { ok: false, reason: '快照欄位不完整' };
  }
  if (w.result) return { ok: false, reason: '快照已是終局狀態' };
  const unknown = w.scheduled.find((s) => !KNOWN_ACTIONS.has(s.action?.kind));
  if (unknown) return { ok: false, reason: `快照含有未知的延遲事件 ${String(unknown.action?.kind)}` };
  return { ok: true, world: structuredClone(raw as World) };
}
