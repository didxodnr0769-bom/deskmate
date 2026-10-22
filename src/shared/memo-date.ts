/** Calendar dates are validated without the Date constructor's overflow normalization. */
export function isMemoDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 10) return false;
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

/** The machine's local calendar day; never use the UTC date from toISOString(). */
export function localMemoDate(now: number = Date.now()): string {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('메모 날짜를 확인해 주세요.');
  const key = `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (!isMemoDate(key)) throw new Error('메모 날짜를 확인해 주세요.');
  return key;
}

/** Move a calendar day without assuming every local day has 24 hours. */
export function shiftMemoDate(date: string, days: number): string {
  if (!isMemoDate(date) || !Number.isSafeInteger(days)) throw new Error('메모 날짜를 확인해 주세요.');
  const [year, month, day] = date.split('-').map(Number);
  // UTC is used only for calendar arithmetic, not for classifying an instant.
  const next = new Date(0);
  next.setUTCFullYear(year, month - 1, day + days);
  const key = `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  if (!isMemoDate(key)) throw new Error('메모 날짜를 확인해 주세요.');
  return key;
}
