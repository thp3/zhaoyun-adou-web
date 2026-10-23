import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/data';
import { createWorld } from '../src/domain/battle/create';
import { ProfileSchema, createDefaultProfile } from '../src/domain/profile/profile';
import { BattleFx, actorKey } from '../src/render/fx';

const data = loadGameData();
const world = () => createWorld({ data, seed: 1, mapId: 0, totalRounds: 30, roundOfDay: 5, addHp: 0, aiEnabled: false });

describe('打擊感特效（純視覺狀態）', () => {
  it('出手衝刺：先衝向目標再收回；減少特效時不動', () => {
    const fx = new BattleFx();
    fx.onEvents([{ type: 'attack', src: { kind: 'actor', id: 7 }, kind: 'melee', x: 0, y: 0, tx: 100, ty: 0 }], world(), 1000);
    expect(fx.offset(actorKey(7), 1070).x).toBeCloseTo(14);
    expect(fx.offset(actorKey(7), 1145).x).toBeCloseTo(7);
    expect(fx.offset(actorKey(7), 1300).x).toBe(0);
    fx.reduced = true;
    expect(fx.offset(actorKey(7), 1070).x).toBe(0);
  });

  it('命中閃白遞減；敵人倒下濺墨點；粒子到期清除', () => {
    const fx = new BattleFx();
    fx.onEvents([{ type: 'damage', enemyId: 3, x: 0, y: 0, amount: 5 }], world(), 0);
    expect(fx.flash(3, 0)).toBe(1);
    expect(fx.flash(3, 70)).toBeCloseTo(0.5);
    fx.onEvents([{ type: 'enemyDied', enemyId: 3, side: 0, x: 0, y: 0, reward: 1 }], world(), 0);
    expect(fx.particles.filter((p) => p.kind === 'dot')).toHaveLength(10);
    fx.tick(1000, 16);
    expect(fx.particles).toHaveLength(0);
  });

  it('只有我方阿斗受傷才震動與泛紅', () => {
    const fx = new BattleFx();
    fx.onEvents([{ type: 'adouHit', side: 1, lives: 2 }], world(), 0);
    expect(fx.shakeOffset(10)).toEqual({ x: 0, y: 0 });
    fx.onEvents([{ type: 'adouHit', side: 0, lives: 2 }], world(), 0);
    expect(fx.hurtAt).toBe(0);
    const s = fx.shakeOffset(10);
    expect(Math.abs(s.x) + Math.abs(s.y)).toBeGreaterThan(0);
  });

  it('舊存檔沒有「減少特效」設定時預設關閉', () => {
    const p = createDefaultProfile(0, '2026-10-23', { staminaMax: 30 });
    const old = { ...p, settings: { showDamageNumbers: false } };
    expect(ProfileSchema.parse(old).settings).toEqual({ showDamageNumbers: false, reduceEffects: false });
  });
});
