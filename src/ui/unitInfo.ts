// 對局中點選單位的資訊：純函式，不碰 DOM。攻擊、攻速、射程與實際出手共用同一套計算（含 buff 與壓制）。
import type { GameData } from '../data';
import { generalNumbers, soldierNumbers, type AttackNumbers } from '../domain/battle/combat';
import { unitDisabled } from '../domain/battle/buffs';
import { weaponDef } from '../domain/battle/weapons';
import { CELL, TICK_MS, type Actor, type General, type World } from '../domain/battle/types';

export interface UnitInfo {
  side: 0 | 1;
  title: string;
  rows: [label: string, value: string][];
  notes: string[];
  /** 畫射程圈用：中心與半徑（世界座標）；不在陣地上為 null */
  range: { x: number; y: number; r: number } | null;
  /** 要加框的格子（武將為整排組成字） */
  cells: { x: number; y: number; w: number }[];
}

const SOLDIER_NAME: Record<string, string> = { blade: '刀兵', bow: '弓兵', spear: '槍兵', cavalry: '騎兵' };
const TARGET_RULE: Record<string, string> = { nearest: '最近的敵人', closest_end: '最接近終點的敵人' };
const STATUS_NAME: Record<number, string> = {
  8: '暈眩',
  9: '摔倒',
  11: '電擊',
  13: '混亂',
  14: '灼燒',
  15: '受困',
  16: '鎖鏈',
  17: '擊倒',
  18: '壓制',
  19: '魅惑',
};

/** 去掉多餘的小數：3 → "3"、4.5 → "4.5"、3.4125 → "3.41" */
function num(n: number, digits = 2): string {
  return String(Number(n.toFixed(digits)));
}

/** 沒有 buff 時的數值，用來標出加成 */
function withoutBuffs<T>(w: World, id: number, f: (w: World) => T): T {
  return f({ ...w, buffs: { ...w.buffs, [id]: [] } });
}

function attackRows(cur: AttackNumbers, base: AttackNumbers): [string, string][] {
  const secs = (cur.intervalTicks * TICK_MS) / 1000;
  const baseSecs = (base.intervalTicks * TICK_MS) / 1000;
  const diff = (a: number, b: number, unit = '') => (Math.abs(a - b) < 1e-6 ? '' : `（原 ${num(b)}${unit}）`);
  return [
    ['攻擊', `${num(cur.damage, 1)}${diff(Number(cur.damage.toFixed(1)), Number(base.damage.toFixed(1)))}`],
    ['攻速', `每 ${num(secs)} 秒一擊 · ${num(1 / secs)} 次/秒${diff(secs, baseSecs, ' 秒')}`],
    ['射程', `${num(cur.range / CELL, 1)} 格${diff(cur.range / CELL, base.range / CELL, ' 格')}`],
    ['目標', TARGET_RULE[cur.targetRule] ?? cur.targetRule],
  ];
}

function statusNotes(w: World, id: number): string[] {
  const names = [...new Set((w.buffs[id] ?? []).map((b) => STATUS_NAME[b.type]).filter((x): x is string => !!x))];
  return names.length ? [`狀態：${names.join('、')}`] : [];
}

function cellOf(a: Actor): { x: number; y: number; w: number }[] {
  return a.loc.c === 'board' ? [{ x: a.loc.x, y: a.loc.y, w: 1 }] : [];
}

function rangeAround(cells: { x: number; y: number; w: number }[], r: number): UnitInfo['range'] {
  const c = cells[0];
  return c ? { x: c.x * CELL + (c.w * CELL) / 2, y: c.y * CELL + CELL / 2, r } : null;
}

function soldierInfo(w: World, a: Actor, data: GameData): UnitInfo {
  const cur = soldierNumbers(w, a, data);
  const base = withoutBuffs(w, a.id, (ww) => soldierNumbers(ww, a, data));
  const cells = cellOf(a);
  const notes = statusNotes(w, a.id);
  if (unitDisabled(w, a.id)) notes.unshift('目前無法攻擊');
  if (a.side === 0 && a.level < data.units.soldierMaxLevel) notes.push('同字同級疊上去可以合成升級');
  return {
    side: a.side,
    title: SOLDIER_NAME[a.token] ?? a.token,
    rows: [['等級', `${a.level} / ${data.units.soldierMaxLevel}`], ...attackRows(cur, base)],
    notes,
    range: rangeAround(cells, cur.range),
    cells,
  };
}

function generalInfo(w: World, g: General, data: GameData): UnitInfo {
  const def = data.generals.generals[g.type]!;
  const cur = generalNumbers(w, g, data);
  const base = withoutBuffs(w, g.id, (ww) => generalNumbers(ww, g, data));
  const table = def.highTier ? data.generals.expHighTier : data.generals.expNormalTier;
  const next = table[g.level];
  const weapon = weaponDef(g.weaponId, data);
  const rows: [string, string][] = [
    ['等級', `${g.level} / ${def.maxLevel}`],
    ['經驗', next === undefined || g.level >= def.maxLevel ? `${g.exp}（已滿級）` : `${g.exp} / ${next}`],
    ...attackRows(cur, base),
    ['武器', weapon ? `${weapon.name}（攻擊 +${weapon.addAttPower}）` : `預設${data.weapons.typeNames[def.weaponType]}`],
  ];
  const notes = statusNotes(w, g.id);
  const sk = def.skill ? data.generals.skills.find((s) => s.id === def.skill!.skill) : undefined;
  if (sk && def.skill) {
    const t = def.skill.triggerAttacks;
    rows.push(['技能', t > 0 ? `${sk.name}（${Math.min(g.skillCount, t)} / ${t} 次攻擊）` : `${sk.name}（被動）`]);
    notes.push(sk.description);
  }
  if (weapon) notes.push(weapon.summary);
  const first = w.actors[g.partIds[0]!];
  const cells = first?.loc.c === 'board' ? [{ x: first.loc.x, y: first.loc.y, w: g.partIds.length }] : [];
  return { side: g.side, title: def.name, rows, notes, range: rangeAround(cells, cur.range), cells };
}

function nameInfo(w: World, a: Actor, data: GameData): UnitInfo {
  const tok = data.tokens.tokens.find((t) => t.id === a.token);
  const options = data.generals.generals.filter((g) => g.chars.includes(a.token));
  const notes = options.length
    ? [`同一列由左到右排出 ${options.map((g) => `「${g.name}」`).join('或')} 就會合成武將。`]
    : [];
  return {
    side: a.side,
    title: `${tok?.display ?? a.token}（名字字）`,
    rows: a.exp > 0 ? [['保留經驗', String(a.exp)]] : [],
    notes: ['尚未成為武將，不會攻擊。', ...notes],
    range: null,
    cells: cellOf(a),
  };
}

function farmerInfo(w: World, a: Actor, data: GameData): UnitInfo {
  const f = data.units.farmer;
  const crazy = (a.farm?.crazy ?? 0) > 0;
  const period = crazy ? f.crazy.intervalMs : (f.periodMsByLevel[a.level - 1] ?? f.periodMsByLevel[0]!);
  const rows: [string, string][] = [
    ['等級', `${a.level} / ${f.maxLevel}`],
    ['產金', `每 ${num(period / 1000)} 秒 +${f.goldPerHarvest} 金`],
  ];
  if (crazy) rows.push(['狂熱', `剩 ${Math.ceil((a.farm!.crazy * TICK_MS) / 1000)} 秒`]);
  return { side: a.side, title: '農民', rows, notes: ['不會攻擊；同級疊上去可以升級。'], range: null, cells: cellOf(a) };
}

/** 點選的單位資訊；單位不存在或還在征兵途中回傳 null */
export function describeActor(w: World, id: number, data: GameData): UnitInfo | null {
  const a = w.actors[id];
  if (!a || a.loc.c === 'incoming') return null;
  let info: UnitInfo;
  if (a.kind === 'soldier') info = soldierInfo(w, a, data);
  else if (a.kind === 'farmer') info = farmerInfo(w, a, data);
  else if (a.kind === 'shovel')
    info = { side: a.side, title: '鏟子', rows: [], notes: ['拖到「荒」地可以開墾成可部署的格子。'], range: null, cells: cellOf(a) };
  else {
    const g = a.generalId !== null ? w.generals[a.generalId] : undefined;
    info = g ? generalInfo(w, g, data) : nameInfo(w, a, data);
  }
  if (a.loc.c === 'slot') info.notes.unshift('在征兵欄；部署到陣地後才會行動。');
  if (a.side === 1) info.title = `對方 ${info.title}`;
  return info;
}
