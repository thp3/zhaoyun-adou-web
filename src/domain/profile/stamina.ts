// 體力規則（原版 Bt/zn）：上限 30、每 5 分鐘 +1、整段補計並保留餘數。
// 只用現實時間；裝置時間倒退時不產生負恢復，也不把倒退量算成獎勵。

export interface StaminaState {
  value: number;
  /** 下一點恢復的計時起點；0 表示尚未設定 */
  lastRecoverAt: number;
}

export interface StaminaRules {
  max: number;
  recoverIntervalMs: number;
}

export function recoverStamina(s: StaminaState, now: number, rules: StaminaRules): StaminaState {
  if (s.value >= rules.max) return s;
  if (s.lastRecoverAt <= 0 || now < s.lastRecoverAt) return { value: s.value, lastRecoverAt: now };
  const n = Math.floor((now - s.lastRecoverAt) / rules.recoverIntervalMs);
  if (n <= 0) return s;
  const value = Math.min(rules.max, s.value + n);
  return { value, lastRecoverAt: s.lastRecoverAt + n * rules.recoverIntervalMs };
}

/** 回傳先補計再扣除的結果；不足時回傳 null，不改狀態。 */
export function spendStamina(
  s: StaminaState,
  cost: number,
  now: number,
  rules: StaminaRules,
): StaminaState | null {
  const cur = recoverStamina(s, now, rules);
  if (cur.value < cost) return null;
  // 由滿額開始消耗時，恢復起點重設為現在
  const lastRecoverAt = cur.value >= rules.max ? now : cur.lastRecoverAt;
  return { value: cur.value - cost, lastRecoverAt };
}

export function addStamina(s: StaminaState, amount: number, now: number, rules: StaminaRules): StaminaState {
  const cur = recoverStamina(s, now, rules);
  return { value: Math.min(rules.max, cur.value + amount), lastRecoverAt: cur.lastRecoverAt };
}

/** 距離下一點恢復的毫秒數；已滿回傳 null。 */
export function msUntilNextStamina(s: StaminaState, now: number, rules: StaminaRules): number | null {
  const cur = recoverStamina(s, now, rules);
  if (cur.value >= rules.max) return null;
  return Math.max(0, cur.lastRecoverAt + rules.recoverIntervalMs - now);
}
