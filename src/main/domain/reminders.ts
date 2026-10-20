import type { MemoSchedule } from '../../shared/contracts';

/** 시간 입력을 한 번의 예약 시각으로 정합니다. 반복 예약은 생성하지 않습니다. */
export function nextReminderAt(time: string, now: number): number {
  if (typeof time !== 'string' || time.length !== 5 || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
    throw new Error('알림 시간은 HH:mm 형식으로 입력해 주세요.');
  }
  if (!Number.isInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) {
    throw new Error('현재 시각이 올바르지 않습니다.');
  }

  const current = new Date(now);
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3));
  const selectedMinute = hour * 60 + minute;
  const currentMinute = current.getHours() * 60 + current.getMinutes();
  if (selectedMinute === currentMinute) {
    // DST 종료로 같은 분이 두 번 와도 현재 분의 UTC 오프셋을 유지합니다.
    return now - current.getSeconds() * 1000 - current.getMilliseconds();
  }

  const scheduled = new Date(0);
  scheduled.setHours(0, 0, 0, 0);
  // setFullYear는 Date 생성자의 0~99년 특수 처리와 24시간 고정 가산을 피합니다.
  scheduled.setFullYear(current.getFullYear(), current.getMonth(), current.getDate() + Number(selectedMinute < currentMinute));
  scheduled.setHours(hour, minute, 0, 0);
  let result = scheduled.getTime();
  if (result < now && selectedMinute > currentMinute) {
    // 반복되는 시간대의 두 번째 구간에서는 아직 오지 않은 분을 과거로 잡지 않습니다.
    const repeated = new Date(result + (current.getTimezoneOffset() - scheduled.getTimezoneOffset()) * 60_000);
    if (repeated.getFullYear() === current.getFullYear() && repeated.getMonth() === current.getMonth()
      && repeated.getDate() === current.getDate() && repeated.getHours() === hour && repeated.getMinutes() === minute) {
      result = repeated.getTime();
    }
  }
  if (!Number.isFinite(result) || result < 0 || (selectedMinute > currentMinute && result < now)) {
    throw new Error('알림 시각을 계산할 수 없습니다.');
  }
  return result;
}

const CLOCK_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
function validInstant(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    && Number.isFinite(new Date(value).getTime());
}
/** Validate a schedule and return a detached, canonical representation. */
export function normalizeMemoSchedule(value: unknown): MemoSchedule {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('알림 일정을 확인해 주세요.');
  const schedule = value as Record<string, unknown>;
  if (schedule.kind === 'once' && validInstant(schedule.dueAt)) return { kind: 'once', dueAt: schedule.dueAt };
  if ((schedule.kind === 'daily' || schedule.kind === 'weekly')
    && typeof schedule.time === 'string' && schedule.time.length === 5 && CLOCK_TIME.test(schedule.time)) {
    if (schedule.kind === 'daily') return { kind: 'daily', time: schedule.time };
    if (Array.isArray(schedule.weekdays) && schedule.weekdays.length > 0 && schedule.weekdays.length <= 7
      && Array.from(schedule.weekdays).every(day => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6)) {
      return { kind: 'weekly', time: schedule.time, weekdays: [...new Set(schedule.weekdays as number[])].sort((a, b) => a - b) };
    }
  }
  throw new Error('알림 일정을 확인해 주세요.');
}

export function reminderScheduleTime(schedule: MemoSchedule): string {
  if (schedule.kind !== 'once') return schedule.time;
  const instant = new Date(schedule.dueAt);
  return `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`;
}

/** Repeating reminders advance by local calendar dates, never fixed 24-hour intervals. */
export function nextScheduledReminderAt(value: MemoSchedule, now: number, strictlyAfter = false): number {
  const schedule = normalizeMemoSchedule(value);
  if (!validInstant(now)) throw new Error('현재 시각이 올바르지 않습니다.');
  if (schedule.kind === 'once') return schedule.dueAt;
  const current = new Date(now);
  const hour = Number(schedule.time.slice(0, 2));
  const minute = Number(schedule.time.slice(3));
  for (let day = 0; day <= 7; day++) {
    const candidate = new Date(0);
    candidate.setHours(0, 0, 0, 0);
    candidate.setFullYear(current.getFullYear(), current.getMonth(), current.getDate() + day);
    candidate.setHours(hour, minute, 0, 0);
    if (!validInstant(candidate.getTime())) continue;
    if (schedule.kind === 'weekly' && !schedule.weekdays.includes(candidate.getDay())) continue;
    if (day === 0 && hour === current.getHours() && minute === current.getMinutes()) {
      if (strictlyAfter) continue;
      // Keep the current occurrence in the repeated DST hour.
      return now - current.getSeconds() * 1000 - current.getMilliseconds();
    }
    let dueAt = candidate.getTime();
    if (day === 0 && dueAt < now && hour * 60 + minute > current.getHours() * 60 + current.getMinutes()) {
      const repeated = new Date(dueAt + (current.getTimezoneOffset() - candidate.getTimezoneOffset()) * 60_000);
      if (repeated.getFullYear() === current.getFullYear() && repeated.getMonth() === current.getMonth()
        && repeated.getDate() === current.getDate() && repeated.getHours() === hour && repeated.getMinutes() === minute) dueAt = repeated.getTime();
    }
    if (strictlyAfter ? dueAt > now : dueAt >= now) return dueAt;
  }
  throw new Error('알림 시각을 계산할 수 없습니다.');
}
