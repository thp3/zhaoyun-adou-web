// 武器背包（原版 St / kt / jo / Lr）：碎片累計換算完整件；12 個武將槽各裝一件同類型武器；
// 同一件不可同時裝兩位；可回收普通／稀有／卓越的未裝備件。
import type { GameData } from '../../data';
import type { Profile } from './profile';

export interface WeaponStock {
  weaponId: number;
  total: number;
  required: number;
  complete: number;
  leftover: number;
  equipped: number;
  /** 可再裝備的完整件數 */
  available: number;
}

export function weaponStock(p: Profile, weaponId: number, data: GameData): WeaponStock {
  const def = data.weapons.weapons.find((w) => w.id === weaponId)!;
  const total = p.weaponFragments[String(weaponId)] ?? 0;
  const complete = Math.floor(total / def.fragmentsRequired);
  const equipped = p.equip.filter((id) => id === weaponId).length;
  return {
    weaponId,
    total,
    required: def.fragmentsRequired,
    complete,
    leftover: total - complete * def.fragmentsRequired,
    equipped,
    available: Math.max(0, complete - equipped),
  };
}

/** 背包清單：有碎片的武器；完整優先、稀有度高優先、類型、id */
export function backpack(p: Profile, data: GameData): (WeaponStock & { def: GameData['weapons']['weapons'][number] })[] {
  return data.weapons.weapons
    .filter((w) => (p.weaponFragments[String(w.id)] ?? 0) > 0)
    .map((def) => ({ ...weaponStock(p, def.id, data), def }))
    .sort((a, b) => Number(b.complete > 0) - Number(a.complete > 0) || b.def.rarity - a.def.rarity || a.def.type - b.def.type || a.weaponId - b.weaponId);
}

/** 加碎片；每多出一件完整武器記一次新武器提示（同 id 可重複） */
export function addFragments(p: Profile, drops: number[], data: GameData): Profile {
  if (drops.length === 0) return p;
  const frags = { ...p.weaponFragments };
  const newIds = [...p.newWeaponIds];
  for (const id of drops) {
    const def = data.weapons.weapons.find((w) => w.id === id);
    if (!def) continue;
    const before = Math.floor((frags[String(id)] ?? 0) / def.fragmentsRequired);
    frags[String(id)] = (frags[String(id)] ?? 0) + 1;
    const after = Math.floor(frags[String(id)]! / def.fragmentsRequired);
    for (let i = before; i < after; i++) newIds.push(id);
  }
  return { ...p, weaponFragments: frags, newWeaponIds: newIds };
}

export type InvResult = { ok: true; profile: Profile } | { ok: false; reason: string };

/** 裝備：武器類型要與武將相符，且有可用的完整件；原槽舊武器卸下 */
export function equip(p: Profile, slot: number, weaponId: number, data: GameData): InvResult {
  const general = data.generals.generals[slot];
  const def = data.weapons.weapons.find((w) => w.id === weaponId);
  if (!general || !def) return { ok: false, reason: '無效的武將或武器' };
  if (def.type !== general.weaponType) return { ok: false, reason: `${general.name}只能裝${data.weapons.typeNames[general.weaponType]}` };
  if (p.equip[slot] === weaponId) return { ok: true, profile: p };
  const stock = weaponStock(p, weaponId, data);
  if (stock.available <= 0) return { ok: false, reason: stock.complete === 0 ? '碎片不足，還不是完整武器' : '這把武器已經裝在其他武將身上' };
  const equipArr = [...p.equip];
  equipArr[slot] = weaponId;
  return { ok: true, profile: { ...p, equip: equipArr } };
}

export function unequip(p: Profile, slot: number): Profile {
  if (p.equip[slot] === -1) return p;
  const equipArr = [...p.equip];
  equipArr[slot] = -1;
  return { ...p, equip: equipArr };
}

/** 回收試算：勾選的稀有度中，未裝備的完整件與餘片全部換金幣（每片 1／2／3） */
export function recyclePreview(p: Profile, rarities: number[], data: GameData): { gold: number; rows: { weaponId: number; fragments: number }[] } {
  const rec = data.weapons.recycle;
  const rows: { weaponId: number; fragments: number }[] = [];
  let gold = 0;
  for (const def of data.weapons.weapons) {
    if (!rarities.includes(def.rarity) || !rec.allowedRarities.includes(def.rarity)) continue;
    const s = weaponStock(p, def.id, data);
    // 已裝備的件數保留
    const fragments = s.total - s.equipped * s.required;
    if (fragments <= 0) continue;
    rows.push({ weaponId: def.id, fragments });
    gold += fragments * rec.goldPerFragmentByRarity[def.rarity]!;
  }
  return { gold, rows };
}

export function recycle(p: Profile, rarities: number[], data: GameData): InvResult {
  const { gold, rows } = recyclePreview(p, rarities, data);
  if (rows.length === 0 || gold <= 0) return { ok: false, reason: '沒有可回收的武器' };
  const frags = { ...p.weaponFragments };
  for (const r of rows) {
    const left = (frags[String(r.weaponId)] ?? 0) - r.fragments;
    if (left > 0) frags[String(r.weaponId)] = left;
    else delete frags[String(r.weaponId)];
  }
  return { ok: true, profile: { ...p, gold: p.gold + gold, weaponFragments: frags } };
}

/** 武器系統解鎖（註冊第 3 天）：首次各類型發一把普通武器，只發一次 */
export function grantStarterWeapons(p: Profile, registerDay: number, data: GameData): Profile {
  if (p.weaponFree || registerDay < data.weapons.unlockOnRegisterDay) return p;
  const drops: number[] = [];
  for (const type of data.weapons.starterTypeOrder) {
    const def = data.weapons.weapons.find((w) => w.type === type && w.rarity === 0);
    if (def) for (let i = 0; i < def.fragmentsRequired; i++) drops.push(def.id);
  }
  return { ...addFragments(p, drops, data), weaponFree: true };
}
