import test from 'node:test';
import assert from 'node:assert/strict';
import { nextReminderAt } from '../src/main/domain/reminders';

const at = (year: number, month: number, day: number, hour: number, minute = 0, second = 0, millisecond = 0): number =>
  new Date(year, month - 1, day, hour, minute, second, millisecond).getTime();

test('a reminder in the current minute is due immediately at that minute start', () => {
  const minuteStart = at(2026, 10, 20, 15, 30);
  for (const elapsed of [0, 1, 30_123, 59_999]) {
    assert.equal(nextReminderAt('15:30', minuteStart + elapsed), minuteStart);
  }
});

test('a later clock minute is scheduled today and a passed clock minute tomorrow', () => {
  const now = at(2026, 10, 20, 15, 30, 20, 123);
  assert.equal(nextReminderAt('15:31', now), at(2026, 10, 20, 15, 31));
  assert.equal(nextReminderAt('23:59', now), at(2026, 10, 20, 23, 59));
  assert.equal(nextReminderAt('15:29', now), at(2026, 10, 21, 15, 29));
  assert.equal(nextReminderAt('00:00', now), at(2026, 10, 21, 0));
});

test('midnight, month ends, leap days, and year ends use the next local calendar date', () => {
  for (const [now, expected] of [
    [at(2026, 10, 20, 23, 59, 59, 999), at(2026, 10, 21, 0)],
    [at(2026, 4, 30, 23, 59), at(2026, 5, 1, 0)],
    [at(2024, 2, 28, 23, 59), at(2024, 2, 29, 0)],
    [at(2024, 2, 29, 23, 59), at(2024, 3, 1, 0)],
    [at(2026, 12, 31, 23, 59), at(2027, 1, 1, 0)],
  ]) assert.equal(nextReminderAt('00:00', now), expected);
  assert.equal(nextReminderAt('00:00', at(2026, 10, 21, 0, 0, 59, 999)), at(2026, 10, 21, 0));
});

test('DST changes preserve the requested local clock time instead of adding twenty-four hours', () => {
  const springNow = at(2026, 3, 7, 13);
  const autumnNow = at(2026, 10, 31, 13);
  assert.equal(nextReminderAt('12:00', springNow), at(2026, 3, 8, 12));
  assert.equal(nextReminderAt('12:00', autumnNow), at(2026, 11, 1, 12));
  if (process.env.TZ === 'America/New_York') {
    assert.equal(nextReminderAt('12:00', springNow) - springNow, 22 * 60 * 60 * 1000);
    assert.equal(nextReminderAt('12:00', autumnNow) - autumnNow, 24 * 60 * 60 * 1000);
  }
});

test('nonexistent DST clock minutes follow native local calendar normalization', () => {
  assert.equal(nextReminderAt('02:30', at(2026, 3, 8, 1)), at(2026, 3, 8, 2, 30));
  assert.equal(nextReminderAt('02:30', at(2026, 3, 7, 3)), at(2026, 3, 8, 2, 30));
});

test('the repeated DST clock minute retains the current occurrence when already due', { skip: process.env.TZ !== 'America/New_York' }, () => {
  const first = Date.parse('2026-11-01T01:30:42.123-04:00');
  const second = Date.parse('2026-11-01T01:30:42.123-05:00');
  assert.equal(nextReminderAt('01:30', first), first - 42_123);
  assert.equal(nextReminderAt('01:30', second), second - 42_123);
});

test('a later minute in the repeated DST hour is scheduled in the current occurrence', { skip: process.env.TZ !== 'America/New_York' }, () => {
  for (const offset of ['-04:00', '-05:00']) {
    assert.equal(nextReminderAt('01:30', Date.parse(`2026-11-01T01:15:42.123${offset}`)),
      Date.parse(`2026-11-01T01:30:00.000${offset}`));
  }
});

test('clock times require exactly HH:mm and invalid inputs produce Korean errors', () => {
  for (const time of ['', '9:00', '09:0', '24:00', '12:60', '09:00:00', '09:00\n', ' 09:00',
    '09:00 ', '2026-10-20T09:00', null, undefined, 900]) {
    assert.throws(() => nextReminderAt(time as string, at(2026, 10, 20, 9)), /알림 시간/);
  }
});

test('now requires a nonnegative integer timestamp within the native Date range', () => {
  for (const now of [-1, 0.5, NaN, Infinity, -Infinity, 8_640_000_000_000_001,
    Number.MAX_SAFE_INTEGER, null, undefined, '2026-10-20', new Date()]) {
    assert.throws(() => nextReminderAt('09:00', now as number), /현재 시각/);
  }
  const epoch = new Date(0);
  const time = `${String(epoch.getHours()).padStart(2, '0')}:${String(epoch.getMinutes()).padStart(2, '0')}`;
  assert.equal(nextReminderAt(time, 0), 0);
});

test('unrepresentable future reminders fail instead of returning an invalid timestamp', () => {
  const last = new Date(8_640_000_000_000_000);
  const currentMinute = last.getHours() * 60 + last.getMinutes();
  const nextMinute = (currentMinute + 1) % (24 * 60);
  const time = `${String(Math.floor(nextMinute / 60)).padStart(2, '0')}:${String(nextMinute % 60).padStart(2, '0')}`;
  assert.throws(() => nextReminderAt(time, last.getTime()), /알림 시각/);
});
