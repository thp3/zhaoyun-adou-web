// 應用狀態機：唯一可以切換主流程的地方。對話框疊在主狀態之上，不另開狀態。

export type AppState =
  | 'BOOT'
  | 'LOADING'
  | 'PROFILE_READY'
  | 'LOBBY'
  | 'PREPARING'
  | 'OPPONENT_PRESENTATION'
  | 'BATTLE_READY'
  | 'BATTLE_RUNNING'
  | 'BATTLE_PAUSED'
  | 'SETTLING'
  | 'RESULT'
  | 'RECOVERY';

const TRANSITIONS: Record<AppState, readonly AppState[]> = {
  BOOT: ['LOADING', 'RECOVERY'],
  LOADING: ['PROFILE_READY', 'RECOVERY'],
  // 讀檔後依存檔分流：一般進主畫面；未完成對局／待結算走恢復路徑
  PROFILE_READY: ['LOBBY', 'OPPONENT_PRESENTATION', 'BATTLE_PAUSED', 'SETTLING', 'RECOVERY'],
  LOBBY: ['PREPARING', 'RECOVERY'],
  // 開局交易前失敗可回主畫面（未扣體力）
  PREPARING: ['OPPONENT_PRESENTATION', 'LOBBY', 'RECOVERY'],
  // 尚未開始時可取消（唯一退款）回主畫面
  OPPONENT_PRESENTATION: ['BATTLE_READY', 'LOBBY', 'RECOVERY'],
  BATTLE_READY: ['BATTLE_RUNNING', 'BATTLE_PAUSED', 'RECOVERY'],
  // 不允許直接回 LOBBY：必須暫停確認放棄，或結算
  BATTLE_RUNNING: ['BATTLE_PAUSED', 'SETTLING', 'RECOVERY'],
  BATTLE_PAUSED: ['BATTLE_RUNNING', 'SETTLING', 'RECOVERY'],
  SETTLING: ['RESULT', 'RECOVERY'],
  RESULT: ['LOBBY'],
  RECOVERY: ['LOADING', 'PROFILE_READY'],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: AppState,
    readonly to: AppState,
  ) {
    super(`不允許的狀態轉移 ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function canTransition(from: AppState, to: AppState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class AppStateMachine {
  private current: AppState = 'BOOT';
  private readonly listeners = new Set<(to: AppState, from: AppState) => void>();

  get state(): AppState {
    return this.current;
  }

  go(to: AppState): void {
    const from = this.current;
    if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
    this.current = to;
    for (const fn of this.listeners) fn(to, from);
  }

  onChange(fn: (to: AppState, from: AppState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
