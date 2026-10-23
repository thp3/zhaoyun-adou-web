import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { applyCommand, drawToken } from '../src/domain/battle/commands';
import { createWorld } from '../src/domain/battle/create';
import { enemyHp } from '../src/domain/battle/enemies';
import { lanePath } from '../src/domain/battle/path';
import { stepWorld, surrender } from '../src/domain/battle/step';
import { ticks, type Actor, type BattleCommand, type StepContext, type World } from '../src/domain/battle/types';

const data = loadGameData();
const rules = { data };
const ctx = (): StepContext => ({ data, events: [] });

function newWorld(over: Partial<Parameters<typeof createWorld>[0]> = {}): World {
  return createWorld({ data, seed: 42, mapId: 0, totalRounds: 20, roundOfDay: 5, addHp: 0, aiEnabled: false, ...over });
}

function run(w: World, n: number, cmds: BattleCommand[] = []): void {
  for (let i = 0; i < n && !w.result; i++) stepWorld(w, i === 0 ? cmds : [], rules);
}

function place(w: World, token: string, x: number, y: number, level = 1, side: 0 | 1 = 0): Actor {
  const id = w.nextId++;
  const a: Actor = { id, side, token, kind: token === 'shovel' ? 'shovel' : ['blade', 'bow', 'spear', 'cavalry'].includes(token) ? 'soldier' : 'name', level, loc: { c: 'board', x, y }, cooldown: 0, generalId: null, exp: 0 };
  w.actors[id] = a;
  w.board[x]![y] = id;
  return a;
}

function deployCells(w: World, side: 0 | 1): { x: number; y: number }[] {
  const out = [];
  for (let x = 0; x < 8; x++) for (let y = 0; y < 10; y++) if (w.kind[x]![y] === 1 && w.camp[x]![y] === side) out.push({ x, y });
  return out;
}

describe('地圖路徑', () => {
  it('四張地圖雙方都有只走己方道路的路徑', () => {
    for (const m of data.maps.maps) {
      for (const side of [0, 1] as const) {
        const path = lanePath({ ...m }, side);
        expect(path.length).toBeGreaterThan(5);
        for (const c of path) {
          expect(m.kind[c.x]![c.y]).toBe(0);
          expect(m.camp[c.x]![c.y]).toBe(side);
        }
        for (let i = 1; i < path.length; i++) {
          expect(Math.abs(path[i]!.x - path[i - 1]!.x) + Math.abs(path[i]!.y - path[i - 1]!.y)).toBe(1);
        }
      }
    }
  });
});

describe('牌庫與征兵', () => {
  it('兵字不消耗、名字字消耗', () => {
    const w = newWorld();
    const before = w.camps[0].deck.length;
    const c = ctx();
    const drawn = Array.from({ length: 300 }, () => drawToken(w, 0, c));
    const names = drawn.filter((t) => !data.deck.nonConsumable.includes(t)).length;
    expect(w.camps[0].deck.length).toBe(before - names);
    expect(w.camps[1].deck.length).toBe(before);
  });

  it('征兵扣當前價格、下次 +2、1 秒內不可重複；飛行後才落位', () => {
    const w = newWorld();
    run(w, 1, [{ type: 'RECRUIT', side: 0 }]);
    expect(w.camps[0].gold).toBe(10);
    expect(w.camps[0].recruitCost).toBe(12);
    expect(w.camps[0].slots.every((id) => id !== null && w.actors[id]!.loc.c === 'incoming')).toBe(true);
    const c = ctx();
    expect(applyCommand(w, { type: 'RECRUIT', side: 0 }, c)).toEqual({ ok: false, reason: '征兵太頻繁' });
    run(w, ticks(500 + 100 * 4) + 1);
    expect(w.camps[0].slots.every((id) => id !== null && w.actors[id]!.loc.c === 'slot')).toBe(true);
    expect(w.camps[0].refreshed).toBe(true);
  });

  it('資金不足不扣錢', () => {
    const w = newWorld();
    w.camps[0].gold = 5;
    const r = applyCommand(w, { type: 'RECRUIT', side: 0 }, ctx());
    expect(r.ok).toBe(false);
    expect(w.camps[0].gold).toBe(5);
  });

  it('前 3 局雙方牌庫各加 floor(11/5)=2 鏟', () => {
    expect(newWorld({ roundOfDay: 1 }).camps[0].deck.filter((t) => t === 'shovel')).toHaveLength(13);
    expect(newWorld({ roundOfDay: 4 }).camps[1].deck.filter((t) => t === 'shovel')).toHaveLength(11);
  });
});

describe('移動、合成、開墾', () => {
  it('同字同級合成升 1 級；不同級拒絕；5 級不再合', () => {
    const w = newWorld();
    const [c1, c2, c3] = deployCells(w, 0);
    const a = place(w, 'blade', c1!.x, c1!.y);
    const b = place(w, 'blade', c2!.x, c2!.y);
    expect(applyCommand(w, { type: 'MOVE', side: 0, actorId: a.id, to: { c: 'board', ...c2! } }, ctx()).ok).toBe(true);
    expect(w.actors[a.id]).toBeUndefined();
    expect(w.actors[b.id]!.level).toBe(2);
    expect(w.board[c1!.x]![c1!.y]).toBeNull();
    const d = place(w, 'blade', c3!.x, c3!.y);
    expect(applyCommand(w, { type: 'MOVE', side: 0, actorId: d.id, to: { c: 'board', ...c2! } }, ctx()).ok).toBe(false);
    w.actors[b.id]!.level = 5;
    d.level = 5;
    expect(applyCommand(w, { type: 'MOVE', side: 0, actorId: d.id, to: { c: 'board', ...c2! } }, ctx())).toEqual({ ok: false, reason: '已達最高等級' });
  });

  it('不同字交換位置；不能放到道路、對方陣地、待開墾地', () => {
    const w = newWorld();
    const [c1, c2] = deployCells(w, 0);
    const a = place(w, 'blade', c1!.x, c1!.y);
    const b = place(w, 'bow', c2!.x, c2!.y);
    expect(applyCommand(w, { type: 'MOVE', side: 0, actorId: a.id, to: { c: 'board', ...c2! } }, ctx()).ok).toBe(true);
    expect(w.board[c2!.x]![c2!.y]).toBe(a.id);
    expect(w.board[c1!.x]![c1!.y]).toBe(b.id);
    const road = w.paths[0][3]!;
    expect(applyCommand(w, { type: 'MOVE', side: 0, actorId: a.id, to: { c: 'board', x: Math.floor(road.x / 80), y: Math.floor(road.y / 80) } }, ctx()).ok).toBe(false);
    const enemyCell = deployCells(w, 1)[0]!;
    expect(applyCommand(w, { type: 'MOVE', side: 0, actorId: a.id, to: { c: 'board', ...enemyCell } }, ctx()).ok).toBe(false);
  });

  it('鏟子把己方待開墾地變成可部署並消耗', () => {
    const w = newWorld();
    let target: { x: number; y: number } | null = null;
    for (let x = 0; x < 8 && !target; x++) for (let y = 0; y < 10; y++) if (w.kind[x]![y] === 2 && w.camp[x]![y] === 0) { target = { x, y }; break; }
    const s = place(w, 'shovel', 0, 0);
    // 鏟子先放回刷新欄再拖
    w.board[0]![0] = null;
    s.loc = { c: 'slot', i: 0 };
    w.camps[0].slots[0] = s.id;
    expect(applyCommand(w, { type: 'MOVE', side: 0, actorId: s.id, to: { c: 'board', ...target! } }, ctx()).ok).toBe(true);
    expect(w.kind[target!.x]![target!.y]).toBe(1);
    expect(w.actors[s.id]).toBeUndefined();
    expect(w.camps[0].slots[0]).toBeNull();
  });
});

describe('波次與勝敗', () => {
  it('敵人血量：新手係數依累計局數、第 10 波後套 addHp', () => {
    const w = newWorld({ totalRounds: 0, addHp: 0.2 });
    w.hpStrategy = 0;
    const c = ctx();
    expect(enemyHp(w, 1, c)).toBeCloseTo(10 * 0.6);
    expect(enemyHp(w, 11, c)).toBeCloseTo(611 * 1.2);
    w.totalRounds = 20;
    expect(enemyHp(w, 1, c)).toBe(10);
  });

  it('沒有防守：前幾隻敵人走到終點，阿斗 3 命被打光而敗北', () => {
    const w = newWorld();
    run(w, 200_000);
    expect(w.result).toMatchObject({ outcome: 'lose', reason: 'player-dead' });
    expect(w.result!.wave).toBeLessThanOrEqual(2);
    expect(w.camps[1].lives).toBe(3); // AI 未啟用不扣命
  });

  it('20 波出滿後 5 秒勝利，不需清場；時間點固定', () => {
    const w = newWorld();
    w.camps[0].lives = 1_000_000;
    run(w, 2_000_000);
    expect(w.result).toMatchObject({ outcome: 'win', reason: 'waves-cleared', wave: 20 });
    const totalSpawn = data.waves.spawnCountByWave.reduce((a, b) => a + b, 0);
    const expected = ticks(10_000) + totalSpawn * ticks(1500) + 20 * ticks(5000);
    expect(w.result!.tick).toBe(expected);
  });

  it('同 seed 同輸入結果完全相同', () => {
    const play = () => {
      const w = newWorld({ seed: 7 });
      const cells = deployCells(w, 0);
      for (const [i, c] of cells.slice(0, 6).entries()) place(w, ['blade', 'bow', 'spear', 'cavalry'][i % 4]!, c.x, c.y, 3);
      w.camps[0].lives = 1_000_000;
      run(w, 20_000, [{ type: 'RECRUIT', side: 0 }]);
      return JSON.stringify(w);
    };
    expect(play()).toBe(play());
  });

  it('有防守時能擊殺敵人並取得戰鬥資金', () => {
    const w = newWorld();
    const pathCells = new Set(w.paths[0].map((p) => `${Math.floor(p.x / 80)},${Math.floor(p.y / 80)}`));
    const near = deployCells(w, 0).filter((c) =>
      [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => pathCells.has(`${c.x + dx!},${c.y + dy!}`)),
    );
    near.forEach((c, i) => place(w, ['blade', 'bow', 'spear', 'cavalry'][i % 4]!, c.x, c.y, 5));
    run(w, ticks(10_000) + 12 * ticks(1500) + ticks(5000));
    expect(w.camps[0].kills).toBeGreaterThan(0);
    expect(w.camps[0].gold).toBe(20 + w.camps[0].kills);
    expect(w.camps[0].lives).toBe(3);
  });

  it('放棄只產生一次結果', () => {
    const w = newWorld();
    run(w, 10);
    expect(surrender(w)).toMatchObject({ outcome: 'lose', reason: 'surrender' });
    expect(surrender(w)).toBeNull();
    const t = w.tick;
    run(w, 100);
    expect(w.tick).toBe(t);
  });
});
