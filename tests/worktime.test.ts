import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceWorkSchedule, defaultEndTime, getWorkProgress, localDateKey, validateWorkSchedule } from '../src/main/domain/worktime';
import type { WorkSchedule } from '../src/main/domain/worktime';

const dayShift: WorkSchedule = { date: '2026-10-19', startTime: '09:00', endTime: '18:00' };
const at = (hour: number, minute = 0, second = 0, millisecond = 0): Date => new Date(2026, 9, 19, hour, minute, second, millisecond);

test('local date keys use calendar components and reject invalid dates', () => {
  assert.equal(localDateKey(at(0, 5)), '2026-10-19');
  assert.equal(localDateKey(new Date(2026, 0, 2, 23, 59)), '2026-01-02');
  assert.equal(localDateKey(new Date(NaN)), '');
});

test('the default end time adds nine hours and wraps at midnight', () => {
  assert.equal(defaultEndTime('09:00'), '18:00');
  assert.equal(defaultEndTime('00:00'), '09:00');
  assert.equal(defaultEndTime('15:00'), '00:00');
  assert.equal(defaultEndTime('22:30'), '07:30');
  assert.equal(defaultEndTime('23:59'), '08:59');
  for (const invalid of ['', '9:00', '09:0', '24:00', '12:60', '09:00:00', '09:00\n', ' 09:00']) {
    assert.equal(defaultEndTime(invalid), null, invalid);
  }
});

test('schedule validation accepts actual calendar dates and strict HH:mm times', () => {
  assert.equal(validateWorkSchedule(dayShift), true);
  assert.equal(validateWorkSchedule({ date: '2024-02-29', startTime: '22:00', endTime: '07:00' }), true);
  assert.equal(validateWorkSchedule({ date: '2000-02-29', startTime: '00:00', endTime: '23:59' }), true);
  assert.equal(validateWorkSchedule({ date: '0099-01-01', startTime: '09:00', endTime: '18:00' }), true);
});

test('schedule validation rejects invalid or normalized dates instead of silently rolling them forward', () => {
  for (const date of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '0000-01-01', '2026-1-01', '2026-10-19\n', '2026-10-19T00:00:00']) {
    assert.equal(validateWorkSchedule({ ...dayShift, date }), false, date);
  }
});

test('schedule validation rejects equal, missing and malformed times', () => {
  assert.equal(validateWorkSchedule({ ...dayShift, endTime: '09:00' }), false);
  for (const time of ['9:00', '24:00', '10:60', '09:00\n', '', '09:00:00']) {
    assert.equal(validateWorkSchedule({ ...dayShift, startTime: time }), false, time);
    assert.equal(validateWorkSchedule({ ...dayShift, endTime: time }), false, time);
  }
  for (const value of [null, undefined, [], {}, '2026-10-19', { date: dayShift.date, startTime: 900, endTime: '18:00' }]) {
    assert.equal(validateWorkSchedule(value), false);
  }
});

test('an unset or corrupt saved schedule yields a safe empty progress result', () => {
  const empty = { hp: 0, remainingMinutes: null, phase: 'unset', isOvernight: false };
  assert.deepEqual(getWorkProgress(null, at(12)), empty);
  assert.deepEqual(getWorkProgress({ ...dayShift, date: '2026-02-31' }, at(12)), empty);
  assert.deepEqual(getWorkProgress({ ...dayShift, endTime: '09:00' }, at(12)), empty);
  assert.deepEqual(getWorkProgress(dayShift, new Date(NaN)), empty);
});

test('before the shift HP stays at zero while remaining time still counts down to the end', () => {
  assert.deepEqual(getWorkProgress(dayShift, at(8)), {
    hp: 0, remainingMinutes: 600, phase: 'before', isOvernight: false,
  });
});

test('the shift starts at exactly zero and reaches fifty percent halfway through', () => {
  assert.deepEqual(getWorkProgress(dayShift, at(9)), {
    hp: 0, remainingMinutes: 540, phase: 'working', isOvernight: false,
  });
  assert.deepEqual(getWorkProgress(dayShift, at(13, 30)), {
    hp: 50, remainingMinutes: 270, phase: 'working', isOvernight: false,
  });
});

test('displayed HP floors progress and never reaches one hundred before the end', () => {
  assert.equal(getWorkProgress(dayShift, at(13, 29, 59)).hp, 49);
  assert.deepEqual(getWorkProgress(dayShift, at(17, 59, 59, 999)), {
    hp: 99, remainingMinutes: 1, phase: 'working', isOvernight: false,
  });
});

test('exactly at the end and afterwards HP stays at one hundred with no remaining minutes', () => {
  const finished = { hp: 100, remainingMinutes: 0, phase: 'finished', isOvernight: false };
  assert.deepEqual(getWorkProgress(dayShift, at(18)), finished);
  assert.deepEqual(getWorkProgress(dayShift, at(23, 59)), finished);
  assert.deepEqual(getWorkProgress(dayShift, new Date(2026, 9, 22, 9)), finished);
});

test('remaining minutes round upward without ending the shift early', () => {
  assert.equal(getWorkProgress(dayShift, at(17, 58, 1)).remainingMinutes, 2);
  assert.equal(getWorkProgress(dayShift, at(17, 59)).remainingMinutes, 1);
  assert.equal(getWorkProgress(dayShift, at(18)).remainingMinutes, 0);
});

test('an overnight shift retains its original start date through midnight and a year boundary', () => {
  const overnight: WorkSchedule = { date: '2026-12-31', startTime: '22:00', endTime: '07:00' };
  assert.deepEqual(getWorkProgress(overnight, new Date(2027, 0, 1, 0)), {
    hp: 22, remainingMinutes: 420, phase: 'working', isOvernight: true,
  });
  assert.deepEqual(getWorkProgress(overnight, new Date(2027, 0, 1, 2, 30)), {
    hp: 50, remainingMinutes: 270, phase: 'working', isOvernight: true,
  });
  assert.deepEqual(getWorkProgress(overnight, new Date(2027, 0, 1, 7)), {
    hp: 100, remainingMinutes: 0, phase: 'finished', isOvernight: true,
  });
});

test('a shift ending at midnight finishes on the following local calendar day', () => {
  const midnight: WorkSchedule = { date: '2026-10-19', startTime: '15:00', endTime: '00:00' };
  assert.deepEqual(getWorkProgress(midnight, new Date(2026, 9, 20, 0)), {
    hp: 100, remainingMinutes: 0, phase: 'finished', isOvernight: true,
  });
  assert.equal(getWorkProgress(midnight, at(23, 59, 59, 999)).hp, 99);
});

test('completed work dates advance at local midnight, across weekends, months and years without changing times', () => {
  for (const [date, now] of [
    ['2026-10-19', new Date(2026, 9, 20, 0)],
    ['2026-10-23', new Date(2026, 9, 26, 8)],
    ['2026-12-31', new Date(2027, 0, 1, 0)],
    ['2028-02-28', new Date(2028, 1, 29, 0)],
  ] as const) {
    const schedule = { ...dayShift, date };
    const result = advanceWorkSchedule(schedule, now)!;
    assert.deepEqual(result, { ...schedule, date: localDateKey(now) });
    assert.equal(schedule.date, date, 'the saved input is never mutated');
  }
});

test('future work dates and active overnight shifts stay anchored until the exact end', () => {
  const night = { date: '2026-12-31', startTime: '22:00', endTime: '07:00' };
  assert.equal(advanceWorkSchedule(night, new Date(2027, 0, 1, 0)), night);
  assert.equal(advanceWorkSchedule(night, new Date(2027, 0, 1, 6, 59, 59, 999)), night);
  assert.deepEqual(advanceWorkSchedule(night, new Date(2027, 0, 1, 7)), { ...night, date: '2027-01-01' });
  assert.equal(advanceWorkSchedule(night, new Date(2026, 11, 1)), night);
  assert.equal(advanceWorkSchedule(dayShift, at(23, 59)), dayShift);
  assert.equal(advanceWorkSchedule(null, at(0)), null);
  assert.equal(advanceWorkSchedule(dayShift, new Date(NaN)), dayShift);
});

test('date advancement uses local boundaries through DST transitions', { skip: process.env.TZ !== 'America/New_York' }, () => {
  for (const now of [new Date(2026, 2, 8, 0), new Date(2026, 10, 1, 0)]) {
    const previous = new Date(now); previous.setDate(previous.getDate() - 1);
    const shift = { ...dayShift, date: localDateKey(previous) };
    assert.equal(advanceWorkSchedule(shift, new Date(now.getTime() - 1)), shift);
    assert.equal(advanceWorkSchedule(shift, now)?.date, localDateKey(now));
  }
  const night = { date: '2026-10-31', startTime: '22:00', endTime: '07:00' };
  assert.equal(advanceWorkSchedule(night, new Date('2026-11-01T01:30:00-05:00')), night);
});
