import type { WorkSchedule, WorkProgress } from '../../shared/contracts';
export type { WorkSchedule, WorkProgress } from '../../shared/contracts';

const MINUTE_MS = 60_000;
const pad = (value: number): string => String(value).padStart(2, '0');

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.length !== 5) return null;
  const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function parseDate(value: unknown): { year: number; month: number; day: number } | null {
  if (typeof value !== 'string' || value.length !== 10) return null;
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1] ? { year, month, day } : null;
}

/** Use the local date, rather than the UTC date from toISOString(). */
export function localDateKey(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return '';
  const year = now.getFullYear();
  if (year < 1 || year > 9999) return '';
  return `${String(year).padStart(4, '0')}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Add nine clock hours; the schedule's date anchors an overnight shift separately. */
export function defaultEndTime(startTime: string): string | null {
  const start = parseTime(startTime);
  if (start === null) return null;
  const end = (start + 9 * 60) % (24 * 60);
  return `${pad(Math.floor(end / 60))}:${pad(end % 60)}`;
}

export function validateWorkSchedule(value: unknown): value is WorkSchedule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<WorkSchedule>;
  const start = parseTime(candidate.startTime);
  const end = parseTime(candidate.endTime);
  return parseDate(candidate.date) !== null && start !== null && end !== null && start !== end;
}

function localTimestamp(date: { year: number; month: number; day: number }, minutes: number, nextDay: boolean): number {
  // setFullYear avoids the Date constructor's special handling of years 0–99.
  const moment = new Date(0);
  moment.setFullYear(date.year, date.month - 1, date.day + Number(nextDay));
  moment.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return moment.getTime();
}

/** Advance only completed past shifts; an active overnight shift and future dates stay anchored. */
export function advanceWorkSchedule(schedule: WorkSchedule | null, now: Date): WorkSchedule | null {
  const today = localDateKey(now);
  if (!today || !validateWorkSchedule(schedule) || schedule.date >= today
      || getWorkProgress(schedule, now).phase !== 'finished') return schedule;
  return { ...schedule, date: today };
}

/** Calculate one anchored shift. Date advancement is a separate, persisted operation. */
export function getWorkProgress(schedule: WorkSchedule | null, now: Date): WorkProgress {
  const unset: WorkProgress = { hp: 0, remainingMinutes: null, phase: 'unset', isOvernight: false };
  if (!validateWorkSchedule(schedule) || !(now instanceof Date) || !Number.isFinite(now.getTime())) return unset;
  const date = parseDate(schedule.date)!;
  const startMinutes = parseTime(schedule.startTime)!;
  const endMinutes = parseTime(schedule.endTime)!;
  const isOvernight = endMinutes < startMinutes;
  const start = localTimestamp(date, startMinutes, false);
  const end = localTimestamp(date, endMinutes, isOvernight);
  const duration = end - start;
  if (!Number.isFinite(duration) || duration <= 0) return unset;
  const current = now.getTime();
  if (current >= end) return { hp: 100, remainingMinutes: 0, phase: 'finished', isOvernight };
  const remainingMinutes = Math.ceil((end - current) / MINUTE_MS);
  if (current < start) return { hp: 0, remainingMinutes, phase: 'before', isOvernight };
  // Keep the display below 100 until the exact end, including its final millisecond.
  const hp = Math.max(0, Math.min(99, Math.floor((current - start) / duration * 100)));
  return { hp, remainingMinutes, phase: 'working', isOvernight };
}
