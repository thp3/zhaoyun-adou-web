// 效能基準：後期滿場時，每個 20ms tick 的模擬耗時要遠低於 20ms（目標平均 < 2ms）。
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createWorld } from '../src/domain/battle/create';
import { stepWorld } from '../src/domain/battle/step';

const data = loadGameData();

describe('效能', () => {
  it('第 15 波後滿場：單 tick 平均與最差耗時', () => {
    const w = createWorld({
      data, seed: 11, mapId: 2, totalRounds: 200, roundOfDay: 6, addHp: 0.2, aiEnabled: true, difficulty: 3, weaponUnlocked: true,
      playerItems: [{ id: 14, level: 1 }, { id: 15, level: 1 }, { id: 20, level: 1 }, { id: 12, level: 1 }],
      aiItems: [{ id: 14, level: 1 }, { id: 18, level: 1 }, { id: 12, level: 1 }, { id: 19, level: 1 }],
      aiEquip: [19, 18, 17, 29, 8, 24, 30, 16, 43, 37, 34, 9],
    });
    // 雙方都不會輸：專心量壓力
    w.camps[0].lives = 1e9;
    w.camps[1].lives = 1e9;
    w.camps[1].gold = 1e6;
    while (w.wave.wave < 15) stepWorld(w, [], { data });
    const samples: number[] = [];
    let maxEnemies = 0;
    for (let i = 0; i < 3000; i++) {
      const t = performance.now();
      stepWorld(w, [], { data });
      samples.push(performance.now() - t);
      maxEnemies = Math.max(maxEnemies, Object.keys(w.enemies).length);
    }
    samples.sort((a, b) => a - b);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p99 = samples[Math.floor(samples.length * 0.99)]!;
    // eslint-disable-next-line no-console
    console.log(`敵人最多 ${maxEnemies}、單位 ${Object.keys(w.actors).length}、武將 ${Object.keys(w.generals).length}；平均 ${avg.toFixed(3)}ms、p99 ${p99.toFixed(3)}ms、最差 ${samples[samples.length - 1]!.toFixed(2)}ms`);
    expect(avg).toBeLessThan(2);
    expect(p99).toBeLessThan(10);
  }, 120_000);
});
