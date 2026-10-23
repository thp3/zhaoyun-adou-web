import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { BUFF, applyBuff } from '../src/domain/battle/buffs';
import { attackerFor } from '../src/domain/battle/combat';
import { createWorld } from '../src/domain/battle/create';
import { tryFormGeneral } from '../src/domain/battle/generals';
import { CELL, TICK_MS, type Actor, type General, type StepContext, type World } from '../src/domain/battle/types';
import { describeActor } from '../src/ui/unitInfo';

const data = loadGameData();
const ctx = (): StepContext => ({ data, events: [] });

function world(): World {
  return createWorld({ data, seed: 3, mapId: 0, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: false });
}

function put(w: World, token: string, kind: Actor['kind'], x: number, y: number, level = 1): Actor {
  w.kind[x]![y] = 1;
  const id = w.nextId++;
  const a: Actor = { id, side: 0, token, kind, level, loc: { c: 'board', x, y }, cooldown: 0, generalId: null, exp: 0 };
  w.actors[id] = a;
  w.board[x]![y] = id;
  return a;
}

/** 玩家方同一列相鄰兩格空位 */
function pair(w: World): { x: number; y: number } {
  for (let y = 9; y >= 0; y--) for (let x = 0; x < 7; x++) {
    const ok = (cx: number) => w.camp[cx]![y] === 0 && w.board[cx]![y] == null;
    if (ok(x) && ok(x + 1)) return { x, y };
  }
  throw new Error('no pair');
}

function general(w: World, key: string): General {
  const def = data.generals.generals.find((g) => g.key === key)!;
  const { x, y } = pair(w);
  let last: Actor | null = null;
  def.chars.forEach((tok, k) => (last = put(w, tok, 'name', x + k, y)));
  return tryFormGeneral(w, last!, ctx())!;
}

const row = (info: { rows: [string, string][] }, label: string) => info.rows.find(([k]) => k === label)?.[1];

describe('對局中點選單位的資訊', () => {
  it('普通兵：等級、攻擊、攻速、射程與實際出手一致', () => {
    const w = world();
    const { x, y } = pair(w);
    const a = put(w, 'bow', 'soldier', x, y, 3);
    const info = describeActor(w, a.id, data)!;
    const atk = attackerFor(w, { kind: 'actor', id: a.id }, ctx())!;
    const secs = (atk.intervalTicks * TICK_MS) / 1000;
    expect(info.title).toBe('弓兵');
    expect(row(info, '等級')).toBe('3 / 5');
    expect(row(info, '攻擊')).toBe(String(Number(atk.damage.toFixed(1))));
    expect(row(info, '攻速')).toContain(`每 ${Number(secs.toFixed(2))} 秒一擊`);
    expect(row(info, '射程')).toBe(`${atk.range / CELL} 格`);
    expect(info.range).toEqual({ x: x * CELL + CELL / 2, y: y * CELL + CELL / 2, r: atk.range });
  });

  it('有加成時標出原值', () => {
    const w = world();
    const { x, y } = pair(w);
    const a = put(w, 'blade', 'soldier', x, y);
    applyBuff(w, a.id, BUFF.attPower, 1, { percent: true, timeMs: -1 }, ctx());
    applyBuff(w, a.id, BUFF.attSpeed, 1, { percent: true, timeMs: -1 }, ctx());
    const info = describeActor(w, a.id, data)!;
    expect(row(info, '攻擊')).toBe('6（原 3）');
    expect(row(info, '攻速')).toContain('（原 0.8 秒）');
  });

  it('武將：點任一組成字都顯示武將等級、經驗、武器與技能', () => {
    const w = world();
    const g = general(w, 'zhaoyun');
    const info = describeActor(w, g.partIds[1]!, data)!;
    const atk = attackerFor(w, { kind: 'general', id: g.id }, ctx())!;
    expect(info.title).toBe('趙雲');
    expect(row(info, '等級')).toBe('1 / 5');
    expect(row(info, '經驗')).toBe('0 / 10');
    expect(row(info, '攻擊')).toBe(String(Number(atk.damage.toFixed(1))));
    expect(row(info, '武器')).toBe('預設槍');
    expect(row(info, '技能')).toBe('七進七出（0 / 30 次攻擊）');
    expect(info.cells).toEqual([{ ...info.cells[0]!, w: 2 }]);
  });

  it('未成形的名字字、征兵欄與農民', () => {
    const w = world();
    const { x, y } = pair(w);
    const n = put(w, 'zhao', 'name', x, y);
    const ni = describeActor(w, n.id, data)!;
    expect(ni.notes.join()).toContain('不會攻擊');
    expect(ni.range).toBeNull();

    const f = put(w, 'farmer', 'farmer', x + 1, y, 2);
    f.farm = { timer: 0, crazy: 0 };
    expect(row(describeActor(w, f.id, data)!, '產金')).toBe('每 10 秒 +1 金');

    w.board[x]![y] = null;
    n.loc = { c: 'slot', i: 0 };
    w.camps[0].slots[0] = n.id;
    expect(describeActor(w, n.id, data)!.notes[0]).toContain('征兵欄');
    n.loc = { c: 'incoming', i: 0 };
    expect(describeActor(w, n.id, data)).toBeNull();
  });
});
