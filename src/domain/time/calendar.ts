// 日曆服務：把現實時間轉成「指定時區的日期鍵」。戰鬥不得使用這裡的時間。

export type DayKey = string; // 'YYYY-MM-DD'

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

export function dayKeyOf(nowMs: number, zone: string): DayKey {
  const parts = formatterFor(zone).formatToParts(new Date(nowMs));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 日期鍵 → 自 1970-01-01 起的日序；兩個日期相減即為相差天數。 */
export function dayNumber(key: DayKey): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`無效日期鍵 ${key}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000;
}

/** 0=週一 … 6=週日，與原版選圖表 weekdayMonToSun 對齊。 */
export function weekdayMonFirst(key: DayKey): number {
  const sundayFirst = new Date(dayNumber(key) * 86_400_000).getUTCDay();
  return (sundayFirst + 6) % 7;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
