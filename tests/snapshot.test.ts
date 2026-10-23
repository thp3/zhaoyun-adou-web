import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createWorld } from '../src/domain/battle/create';
import { stepWorld } from '../src/domain/battle/step';
import type { World } from '../src/domain/battle/types';

const data = loadGameData();
const rules = { data };

function busyWorld(seed: number): World {
  const w = createWorld({
    data, seed, mapId: seed % 4, totalRounds: 40, roundOfDay: 5, addHp: 0.1, aiEnabled: true, difficulty: 3,
    weaponUnlocked: true,
    playerItems: [{ id: 12, level: 1 }, { id: 20, level: 1 }, { id: 15, level: 1 }],
    aiItems: [{ id: 14, level: 1 }, { id: 18, level: 1 }, { id: 3, level: 1 }],
    aiEquip: [19, 18, 17, 29, 8, 24, 30, 16, 43, 37, 34, 9],
  });
  w.camps[0].lives = 1e9;
  return w;
}

describe('對局快照', () => {
  it.each([1, 2, 3, 4])('seed %i：JSON 往返後繼續推進，結果與不中斷完全相同', (seed) => {
    const a = busyWorld(seed);
    for (let i = 0; i < 30_000 && !a.result; i++) stepWorld(a, [], rules);
    const snap = JSON.parse(JSON.stringify(a)) as World;
    expect(snap).toEqual(a);
    const b = snap;
    for (let i = 0; i < 20_000; i++) {
      stepWorld(a, [], rules);
      stepWorld(b, [], rules);
    }
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  }, 120_000);

  it('快照中沒有函式、undefined 以外的非資料值', () => {
    const w = busyWorld(5);
    for (let i = 0; i < 20_000; i++) stepWorld(w, [], rules);
    const walk = (v: unknown, path: string): void => {
      if (v === null || ['number', 'string', 'boolean', 'undefined'].includes(typeof v)) {
        if (typeof v === 'number') expect(Number.isFinite(v) || v === Infinity || v === -Infinity, path).toBe(true);
        return;
      }
      expect(typeof v, path).toBe('object');
      const proto = Object.getPrototypeOf(v);
      expect(proto === Object.prototype || proto === Array.prototype, path).toBe(true);
      for (const [k, x] of Object.entries(v as object)) walk(x, `${path}.${k}`);
    };
    walk(w, 'world');
  });
});
