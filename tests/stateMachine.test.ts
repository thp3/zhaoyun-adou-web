import { describe, expect, it } from 'vitest';
import { AppStateMachine, canTransition, IllegalTransitionError } from '../src/app/stateMachine';

describe('應用狀態機', () => {
  it('正常開頁路徑', () => {
    const m = new AppStateMachine();
    for (const s of ['LOADING', 'PROFILE_READY', 'LOBBY'] as const) m.go(s);
    expect(m.state).toBe('LOBBY');
  });
  it('禁止戰鬥中直接回主畫面', () => {
    expect(canTransition('BATTLE_RUNNING', 'LOBBY')).toBe(false);
  });
  it('禁止結算中開新局或回主畫面', () => {
    expect(canTransition('SETTLING', 'PREPARING')).toBe(false);
    expect(canTransition('SETTLING', 'LOBBY')).toBe(false);
  });
  it('非法轉移丟錯且狀態不變', () => {
    const m = new AppStateMachine();
    expect(() => m.go('LOBBY')).toThrow(IllegalTransitionError);
    expect(m.state).toBe('BOOT');
  });
});
