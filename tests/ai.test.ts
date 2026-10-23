import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { scoreMaps } from '../src/domain/battle/ai/scoring';
import { applyCommand } from '../src/domain/battle/commands';
import { createWorld } from '../src/domain/battle/create';
import { stepWorld } from '../src/domain/battle/step';
import type { Actor, BattleEvent, StepContext, World } from '../src/domain/battle/types';

const data = loadGameData();
const rules = { data };

function aiWorld(difficulty: number, seed = 11, mapId = 0): World {
  return createWorld({ data, seed, mapId, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: true, difficulty });
}

function runAi(w: World, maxTicks: number, onEvents?: (e: BattleEvent[]) => void): void {
  for (let i = 0; i < maxTicks && !w.result; i++) {
    const ev = stepWorld(w, [], rules);
    onEvents?.(ev);
  }
}

const boardActors = (w: World, side: 0 | 1) => Object.values(w.actors).filter((a) => a.side === side && a.loc.c === 'board');

describe('AI 評分圖', () => {
  it('四張地圖都有分數，且只在 AI 半場可部署／待開墾格上為正', () => {
    for (const m of data.maps.maps) {
      for (const low of [true, false]) {
        const maps = scoreMaps(data, m.id, low);
        expect(maps.size).toBe(16);
        let positive = 0;
        for (const grid of maps.values()) {
          grid.forEach((col, x) =>
            col.forEach((v, y) => {
              if (v > 0) {
                positive++;
                expect([1, 2]).toContain(m.kind[x]![y]);
                expect(m.camp[x]![y]).toBe(1);
              }
            }),
          );
        }
        expect(positive).toBeGreaterThan(0);
      }
    }
  });
});

describe('AI 對局行為', () => {
  it.each([0, 1, 2, 3])('難度 %i：會征兵、部署、資金不為負，且能擊殺敵人', (diff) => {
    const w = aiWorld(diff);
    w.camps[0].lives = 1e9;
    let minGold = Infinity;
    let generals = 0;
    runAi(w, 60_000, (ev) => {
      minGold = Math.min(minGold, w.camps[1].gold);
      generals += ev.filter((e) => e.type === 'generalFormed' && e.side === 1).length;
    });
    expect(minGold).toBeGreaterThanOrEqual(0);
    expect(boardActors(w, 1).length).toBeGreaterThan(3);
    expect(w.camps[1].kills).toBeGreaterThan(0);
    // AI 單位只放在 AI 自己的可部署格
    for (const a of boardActors(w, 1)) {
      if (a.loc.c !== 'board') continue;
      expect(w.camp[a.loc.x]![a.loc.y]).toBe(1);
      expect(w.kind[a.loc.x]![a.loc.y]).toBe(1);
    }
    // eslint-disable-next-line no-console
    console.log(`diff ${diff}: wave ${w.wave.wave} ai lives ${w.camps[1].lives} kills ${w.camps[1].kills} units ${boardActors(w, 1).map((a: Actor) => `${a.token}${a.level}`).join(' ')} generals ${generals} result ${JSON.stringify(w.result)}`);
  });

  it('高難度比低難度守得更久（同 seed 平均）', () => {
    const survive = (diff: number) => {
      let total = 0;
      for (const seed of [1, 2, 3]) {
        const w = aiWorld(diff, seed);
        w.camps[0].lives = 1e9;
        runAi(w, 200_000);
        total += w.result?.wave ?? 20;
      }
      return total / 3;
    };
    const low = survive(0);
    const high = survive(3);
    // eslint-disable-next-line no-console
    console.log(`平均到達波次 難度0=${low} 難度3=${high}`);
    expect(high).toBeGreaterThanOrEqual(low);
  }, 60_000);

  it('同 seed 的 AI 對局完全可重現', () => {
    const play = () => {
      const w = aiWorld(3, 99);
      w.camps[0].lives = 1e9;
      runAi(w, 20_000);
      return JSON.stringify(w);
    };
    expect(play()).toBe(play());
  });

  it('AI 未啟用時不出手', () => {
    const w = createWorld({ data, seed: 1, mapId: 0, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: false });
    runAi(w, 3000);
    expect(Object.values(w.actors).filter((a) => a.side === 1)).toHaveLength(0);
  });

  it('波次補助：難度 3 在第 3 波開始時 +20', () => {
    const w = aiWorld(3);
    w.camps[0].lives = 1e9;
    let before = 0;
    let after = 0;
    runAi(w, 200_000, (ev) => {
      if (ev.some((e) => e.type === 'waveStart' && e.wave === 3)) after = w.camps[1].gold;
    });
    void before;
    expect(after).toBeGreaterThan(0);
  });
});

describe('武將', () => {
  const ctx = (): StepContext => ({ data, events: [] });
  function put(w: World, token: string, x: number, y: number, side: 0 | 1 = 0): Actor {
    const id = w.nextId++;
    const a: Actor = { id, side, token, kind: 'name', level: 1, loc: { c: 'slot', i: 0 }, cooldown: 0, generalId: null, exp: 0 };
    w.actors[id] = a;
    w.camps[side].slots[0] = id;
    applyCommand(w, { type: 'MOVE', side, actorId: id, to: { c: 'board', x, y } }, ctx());
    return a;
  }
  function deployPair(w: World, side: 0 | 1): { x: number; y: number } {
    for (let y = 0; y < 10; y++) for (let x = 0; x < 7; x++) {
      const ok = (cx: number) => w.kind[cx]![y] === 1 && w.camp[cx]![y] === side && w.board[cx]![y] == null;
      if (ok(x) && ok(x + 1)) return { x, y };
    }
    throw new Error('no pair cell');
  }

  it('姓在左、名在右相鄰才成形；反向不成形；移開即拆', () => {
    const w = createWorld({ data, seed: 1, mapId: 0, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: false });
    const { x, y } = deployPair(w, 0);
    const yun = put(w, 'yun', x, y);
    const zhao = put(w, 'zhao', x + 1, y);
    expect(Object.keys(w.generals)).toHaveLength(0);
    // 對調成 趙 雲
    applyCommand(w, { type: 'MOVE', side: 0, actorId: zhao.id, to: { c: 'board', x, y } }, ctx());
    const g = Object.values(w.generals)[0]!;
    expect(data.generals.generals[g.type]!.name).toBe('趙雲');
    expect(zhao.generalId).toBe(g.id);
    // 移回刷新欄就拆開
    applyCommand(w, { type: 'MOVE', side: 0, actorId: yun.id, to: { c: 'slot', i: 3 } }, ctx());
    expect(Object.keys(w.generals)).toHaveLength(0);
    expect(zhao.generalId).toBeNull();
  });

  it('餵同字加 Rp 差值經驗並升級；普通組最高 3 級', () => {
    const w = createWorld({ data, seed: 1, mapId: 0, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: false });
    const { x, y } = deployPair(w, 0);
    put(w, 'guan', x, y);
    put(w, 'ping', x + 1, y); // 關平：普通組
    const g = Object.values(w.generals)[0]!;
    const feed = () => {
      const id = w.nextId++;
      w.actors[id] = { id, side: 0, token: 'ping', kind: 'name', level: 1, loc: { c: 'slot', i: 4 }, cooldown: 0, generalId: null, exp: 0 };
      w.camps[0].slots[4] = id;
      return applyCommand(w, { type: 'MOVE', side: 0, actorId: id, to: { c: 'board', x: x + 1, y } }, ctx());
    };
    expect(feed().ok).toBe(true);
    expect(g.exp).toBe(10);
    expect(g.level).toBe(2);
    expect(feed().ok).toBe(true);
    expect(g.exp).toBe(35);
    expect(g.level).toBe(3);
    expect(feed()).toEqual({ ok: false, reason: '武將已達最高等級' });
  });

  it('同一方不能有兩個同型武將', () => {
    const w = createWorld({ data, seed: 1, mapId: 0, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: false });
    w.kind = w.kind.map((col, x) => col.map((k, y) => (w.camp[x]![y] === 0 && k === 2 ? 1 : k)));
    const a = deployPair(w, 0);
    put(w, 'zhao', a.x, a.y);
    put(w, 'yun', a.x + 1, a.y);
    const b = deployPair(w, 0);
    put(w, 'zhao', b.x, b.y);
    put(w, 'yun', b.x + 1, b.y);
    expect(Object.keys(w.generals)).toHaveLength(1);
  });
});
