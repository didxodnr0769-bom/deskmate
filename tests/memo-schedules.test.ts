import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MemoService } from '../src/main/features/memos';
import { nextScheduledReminderAt, normalizeMemoSchedule } from '../src/main/domain/reminders';

const at = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number =>
  new Date(year, month - 1, day, hour, minute, second, ms).getTime();
const october = (day: number, hour = 0, minute = 0, second = 0, ms = 0) => at(2026, 10, day, hour, minute, second, ms);
function fixture(run: (filename: string, setNow: (value: number) => void, open: () => MemoService) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'deskmate-schedules-'));
  const filename = join(directory, 'memos.json');
  let now = october(20, 14);
  try { run(filename, value => { now = value; }, () => new MemoService(filename, () => now)); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
const stored = () => ({ id: randomUUID(), text: '기존', reminderTime: '15:00', completed: false, createdAt: 1, updatedAt: 2 });

test('schedule normalization validates shapes, preserves exact once instant, and canonicalizes weekdays', () => {
  const dueAt = october(20, 14, 30, 45, 678);
  assert.deepEqual(normalizeMemoSchedule({ kind: 'once', dueAt }), { kind: 'once', dueAt });
  assert.deepEqual(normalizeMemoSchedule({ kind: 'weekly', time: '09:00', weekdays: [5, 1, 1, 0] }),
    { kind: 'weekly', time: '09:00', weekdays: [0, 1, 5] });
  for (const invalid of [null, [], {}, { kind: 'monthly', time: '09:00' }, { kind: 'once', dueAt: -1 },
    { kind: 'once', dueAt: 1.5 }, { kind: 'once', dueAt: Infinity }, { kind: 'daily', time: '9:00' },
    { kind: 'daily', time: '24:00' }, { kind: 'weekly', time: '09:00', weekdays: [] },
    { kind: 'weekly', time: '09:00', weekdays: [7] }, { kind: 'weekly', time: '09:00', weekdays: ['1'] },
    { kind: 'weekly', time: '09:00', weekdays: [0.5] }, { kind: 'weekly', time: '09:00', weekdays: Array(2) }]) assert.throws(() => normalizeMemoSchedule(invalid), /알림/);
});

test('daily and selected weekdays schedule by local dates with current-minute delivery and strict advancement', () => {
  const now = october(20, 14, 0, 42, 123); // Tuesday
  assert.equal(nextScheduledReminderAt({ kind: 'daily', time: '14:00' }, now), october(20, 14));
  assert.equal(nextScheduledReminderAt({ kind: 'daily', time: '14:00' }, now, true), october(21, 14));
  assert.equal(nextScheduledReminderAt({ kind: 'daily', time: '13:59' }, now), october(21, 13, 59));
  assert.equal(nextScheduledReminderAt({ kind: 'weekly', time: '14:00', weekdays: [2] }, now), october(20, 14));
  assert.equal(nextScheduledReminderAt({ kind: 'weekly', time: '14:00', weekdays: [2] }, now, true), october(27, 14));
  assert.equal(nextScheduledReminderAt({ kind: 'weekly', time: '09:00', weekdays: [0, 3] }, now), october(21, 9));
  assert.equal(nextScheduledReminderAt({ kind: 'weekly', time: '09:00', weekdays: [0] }, now), october(25, 9));
});

test('daily and weekly recurrence preserve local times across year, leap day and DST changes', () => {
  assert.equal(nextScheduledReminderAt({ kind: 'daily', time: '00:00' }, at(2026, 12, 31, 23, 59)), at(2027, 1, 1));
  assert.equal(nextScheduledReminderAt({ kind: 'daily', time: '00:00' }, at(2024, 2, 28, 23, 59)), at(2024, 2, 29));
  assert.equal(nextScheduledReminderAt({ kind: 'weekly', time: '12:00', weekdays: [0] }, at(2026, 3, 7, 12)), at(2026, 3, 8, 12));
  for (const [now, next] of [[at(2026, 3, 7, 12), at(2026, 3, 8, 12)], [at(2026, 10, 31, 12), at(2026, 11, 1, 12)]]) {
    assert.equal(nextScheduledReminderAt({ kind: 'daily', time: '12:00' }, now, true), next);
  }
  if (process.env.TZ === 'America/New_York') {
    assert.equal(at(2026, 3, 8, 12) - at(2026, 3, 7, 12), 23 * 60 * 60 * 1000);
    assert.equal(at(2026, 11, 1, 12) - at(2026, 10, 31, 12), 25 * 60 * 60 * 1000);
  }
});

test('recurrence follows native normalization for nonexistent DST times and avoids duplicate same-day fold alarms', { skip: process.env.TZ !== 'America/New_York' }, () => {
  assert.equal(nextScheduledReminderAt({ kind: 'daily', time: '02:30' }, at(2026, 3, 8, 3, 15)), at(2026, 3, 8, 3, 30));
  for (const offset of ['-04:00', '-05:00']) {
    const now = Date.parse(`2026-11-01T01:30:42.123${offset}`);
    assert.equal(nextScheduledReminderAt({ kind: 'daily', time: '01:30' }, now), now - 42123);
    assert.equal(nextScheduledReminderAt({ kind: 'daily', time: '01:30' }, now, true), at(2026, 11, 2, 1, 30));
    assert.equal(nextScheduledReminderAt({ kind: 'daily', time: '01:45' }, now), Date.parse(`2026-11-01T01:45:00.000${offset}`));
  }
});

test('invalid reference instants and an unrepresentable future recurrence fail safely', () => {
  for (const now of [-1, 0.5, NaN, Infinity, 8640000000000001]) {
    assert.throws(() => nextScheduledReminderAt({ kind: 'daily', time: '09:00' }, now), /현재/);
  }
  const last = 8640000000000000;
  const date = new Date(last);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  assert.throws(() => nextScheduledReminderAt({ kind: 'daily', time }, last, true), /알림 시각/);
});

test('relative once schedules preserve seconds and milliseconds and overdue reservations survive restart', () => fixture((filename, setNow, open) => {
  const now = october(20, 14, 10, 42, 123);
  const dueAt = now + 30 * 60_000;
  setNow(now);
  const service = open();
  const memo = service.add({ text: '30분 뒤', schedule: { kind: 'once', dueAt } });
  assert.equal(memo.reminderTime, '14:40');
  assert.deepEqual(memo.schedule, { kind: 'once', dueAt });
  setNow(dueAt - 1);
  assert.deepEqual(service.getDueReminders(), []);
  setNow(october(22, 12));
  assert.equal(open().getDueReminders()[0].dueAt, dueAt);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).version, 4);
  const reopened = open();
  reopened.acknowledgeReminder(memo.id, dueAt);
  assert.equal(reopened.list()[0].completed, false);
  assert.deepEqual(open().getDueReminders(), []);
}));

test('daily acknowledgement schedules one future occurrence and leaves the memo incomplete', () => fixture((_filename, setNow, open) => {
  const service = open();
  const memo = service.add({ text: '매일', schedule: { kind: 'daily', time: '15:00' } });
  setNow(october(20, 15, 0, 30));
  const [due] = service.getDueReminders();
  service.acknowledgeReminder(memo.id, due.dueAt);
  assert.equal(service.list()[0].completed, false);
  assert.deepEqual(service.getDueReminders(), []);
  assert.equal(service.getPendingReminder(memo.id, due.dueAt), null);
  assert.throws(() => service.acknowledgeReminder(memo.id, due.dueAt), /변경/);
  setNow(october(21, 15));
  assert.equal(open().getDueReminders()[0].dueAt, october(21, 15));
}));

test('missed repeat occurrences restore only one alarm and acknowledgement skips the backlog', () => fixture((_filename, setNow, open) => {
  const service = open();
  const memo = service.add({ text: '누락된 매일 알림', schedule: { kind: 'daily', time: '15:00' } });
  setNow(october(25, 16));
  const reopened = open();
  assert.equal(reopened.getDueReminders().length, 1);
  assert.equal(reopened.getDueReminders()[0].dueAt, october(20, 15));
  reopened.acknowledgeReminder(memo.id, october(20, 15));
  assert.deepEqual(open().getDueReminders(), []);
  setNow(october(26, 15));
  assert.equal(open().getDueReminders()[0].dueAt, october(26, 15));
}));

test('clock rollback acknowledges beyond the active due instant instead of rearming the same occurrence', () => fixture((_filename, setNow, open) => {
  const service = open();
  const memo = service.add({ text: '주간', schedule: { kind: 'weekly', time: '15:00', weekdays: [2] } });
  setNow(october(20, 15));
  const [due] = service.getDueReminders();
  setNow(october(19, 12));
  service.acknowledgeReminder(memo.id, due.dueAt);
  setNow(october(26, 16));
  assert.deepEqual(service.getDueReminders(), []);
  setNow(october(27, 15));
  assert.equal(service.getDueReminders()[0].dueAt, october(27, 15));
}));

test('body-only edits preserve repeat due time and canonical schedule; changing the schedule rearms', () => fixture((filename, setNow, open) => {
  const service = open();
  const memo = service.add({ text: '원본', schedule: { kind: 'weekly', time: '15:00', weekdays: [4, 2] } });
  setNow(october(20, 16));
  service.update(memo.id, { text: '본문만', schedule: { kind: 'weekly', time: '15:00', weekdays: [2, 4] } });
  assert.equal(service.getDueReminders()[0].dueAt, october(20, 15));
  service.update(memo.id, { text: '정규화 동등', schedule: { kind: 'weekly', time: '15:00', weekdays: [4, 2, 2] } });
  assert.equal(service.getDueReminders()[0].dueAt, october(20, 15));
  service.acknowledgeReminder(memo.id, october(20, 15));
  const reservation = JSON.parse(readFileSync(filename, 'utf8')).memos[0].reminder;
  service.update(memo.id, { text: '확인 후 본문', schedule: { kind: 'weekly', time: '15:00', weekdays: [2, 4] } });
  assert.deepEqual(JSON.parse(readFileSync(filename, 'utf8')).memos[0].reminder, reservation);
  service.update(memo.id, { text: '새 시간', schedule: { kind: 'daily', time: '16:00' } });
  assert.equal(service.getDueReminders()[0].dueAt, october(20, 16));
  service.update(memo.id, { text: '해제', schedule: null });
  assert.deepEqual(open().getDueReminders(), []);
  assert.equal('schedule' in service.list()[0], false);
}));

test('completion cancels recurrence and undo completion rearms from the current local date', () => fixture((_filename, setNow, open) => {
  const service = open();
  const memo = service.add({ text: '반복', schedule: { kind: 'daily', time: '15:00' } });
  service.setCompleted(memo.id, true);
  setNow(october(25, 16));
  assert.deepEqual(open().getDueReminders(), []);
  service.setCompleted(memo.id, false);
  assert.deepEqual(service.getDueReminders(), []);
  service.setCompleted(memo.id, false);
  setNow(october(26, 15));
  assert.equal(service.getDueReminders()[0].dueAt, october(26, 15));
}));

test('returned schedules and weekday arrays are detached from service memory', () => fixture((_filename, _setNow, open) => {
  const service = open();
  const added = service.add({ text: '주간', schedule: { kind: 'weekly', time: '15:00', weekdays: [2, 4] } });
  if (added.schedule?.kind === 'weekly') added.schedule.weekdays.push(0);
  const listed = service.list()[0];
  if (listed.schedule?.kind === 'weekly') { listed.schedule.weekdays.length = 0; listed.schedule.time = '00:00'; }
  assert.deepEqual(service.list()[0].schedule, { kind: 'weekly', time: '15:00', weekdays: [2, 4] });
  assert.deepEqual(open().list()[0].schedule, service.list()[0].schedule);
  const legacy = service.add({ text: '기존 형식', reminderTime: null });
  assert.equal('schedule' in legacy, false);
}));

test('v3 migration preserves overdue and acknowledged alarms with an exact private backup before initialization', () => fixture((filename, setNow, open) => {
  const first = { ...stored(), reminder: { dueAt: october(19, 15, 0, 31, 123), acknowledged: false } };
  const second = { ...stored(), reminder: { dueAt: october(18, 15), acknowledged: true } };
  const source = JSON.stringify({ version: 3, memos: [first, second] }, null, 2) + '\n';
  writeFileSync(filename, source);
  const service = open();
  assert.equal(readFileSync(filename, 'utf8'), source);
  assert.equal('schedule' in service.list()[0], false);
  setNow(october(25, 16));
  assert.equal(service.getDueReminders().length, 1);
  assert.equal(service.getDueReminders()[0].dueAt, first.reminder.dueAt);
  const backup = join(dirname(filename), 'memos.v3.backup.json');
  assert.equal(readFileSync(backup, 'utf8'), source);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).version, 4);
  assert.equal(open().getDueReminders().length, 1);
}));

test('failed v3 backup prevents delivery and mutation while preserving original bytes and memory for retry', () => fixture((filename, _setNow, open) => {
  const memo = { ...stored(), reminder: { dueAt: october(19, 15), acknowledged: false } };
  const source = JSON.stringify({ version: 3, memos: [memo] });
  writeFileSync(filename, source);
  const service = open();
  const baseline = service.list();
  const backup = join(dirname(filename), 'memos.v3.backup.json');
  mkdirSync(backup);
  assert.throws(() => service.getDueReminders(), /저장/);
  assert.throws(() => service.update(memo.id, { text: '실패', reminderTime: '15:00' }), /저장/);
  assert.equal(readFileSync(filename, 'utf8'), source);
  assert.deepEqual(service.list(), baseline);
  assert.equal(readdirSync(dirname(filename)).some(name => name.endsWith('.tmp')), false);
  rmSync(backup, { recursive: true });
  assert.equal(service.getDueReminders()[0].dueAt, memo.reminder.dueAt);
  assert.equal(readFileSync(backup, 'utf8'), source);
}));

test('failed recurring acknowledgement preserves current alarm and on-disk schedule until retry succeeds', () => fixture((filename, setNow, open) => {
  const service = open();
  const memo = service.add({ text: '반복', schedule: { kind: 'daily', time: '15:00' } });
  setNow(october(20, 15));
  const [due] = service.getDueReminders();
  const source = readFileSync(filename, 'utf8');
  renameSync(filename, filename + '.saved');
  mkdirSync(filename);
  assert.throws(() => service.acknowledgeReminder(memo.id, due.dueAt), /저장/);
  assert.deepEqual(service.getDueReminders(), [due]);
  assert.equal(readFileSync(filename + '.saved', 'utf8'), source);
  rmSync(filename, { recursive: true });
  renameSync(filename + '.saved', filename);
  service.acknowledgeReminder(memo.id, due.dueAt);
  setNow(october(21, 15));
  assert.equal(open().getDueReminders()[0].dueAt, october(21, 15));
}));

test('malformed v4 schedules and contradictory alarm state are rejected without altering source files', () => fixture((filename, _setNow, open) => {
  const memo = { ...stored(), schedule: { kind: 'daily', time: '15:00' }, reminder: { dueAt: october(20, 15), acknowledged: false } };
  const invalid = [
    { ...memo, schedule: { kind: 'daily', time: '25:00' } },
    { ...memo, schedule: { kind: 'weekly', time: '15:00', weekdays: [] } },
    { ...memo, schedule: { kind: 'once', dueAt: october(20, 15) + 1 } },
    { ...memo, schedule: { kind: 'once', dueAt: 'tomorrow' } },
    { ...memo, reminder: { ...memo.reminder, acknowledged: true } },
    { ...memo, reminder: null },
    { ...memo, completed: true },
  ];
  for (const item of invalid) {
    const source = JSON.stringify({ version: 4, memos: [item] });
    writeFileSync(filename, source);
    assert.throws(open, /저장된 메모/);
    assert.equal(readFileSync(filename, 'utf8'), source);
  }
  assert.deepEqual(readdirSync(dirname(filename)), ['memos.json']);
}));

test('omitted or undefined schedule explicitly switches recurrence to a one-shot legacy clock at the same time', () => fixture((filename, setNow, open) => {
  for (const legacy of [{ text: '한 번', reminderTime: '15:00' }, { text: '한 번', reminderTime: '15:00', schedule: undefined }]) {
    setNow(october(20, 14));
    const service = open();
    const memo = service.add({ text: '매일', schedule: { kind: 'daily', time: '15:00' } });
    service.update(memo.id, legacy);
    assert.equal('schedule' in service.list().find(item => item.id === memo.id)!, false);
    setNow(october(20, 15));
    service.acknowledgeReminder(memo.id, october(20, 15));
    setNow(october(21, 16));
    assert.equal(service.getDueReminders().some(item => item.memoId === memo.id), false);
    assert.equal(JSON.parse(readFileSync(filename, 'utf8')).memos.find((item: { id: string }) => item.id === memo.id).reminder.acknowledged, true);
  }
}));
