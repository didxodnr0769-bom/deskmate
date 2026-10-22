
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoService } from '../src/main/features/memos';
import { isMemoDate, localMemoDate, shiftMemoDate } from '../src/shared/memo-date';

const at = (day: number, hour = 0, minute = 0, second = 0) => new Date(2026, 9, day, hour, minute, second).getTime();
function fixture(run: (filename: string, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'deskmate-daily-memos-'));
  try { run(join(directory, 'memos.json'), directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('memo dates reject malformed or normalized-overflow dates and honor Gregorian leap years', () => {
  for (const date of ['0001-01-01', '0099-12-31', '2000-02-29', '2024-02-29', '2026-10-22', '9999-12-31']) {
    assert.equal(isMemoDate(date), true, date);
  }
  for (const date of [null, undefined, 20261022, '', '0000-01-01', '10000-01-01', '2026-2-01',
    '2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-13-01',
    '2026-01-00', '2026-01-32', '2026-10-22\n', '2026-10-22T00:00:00Z']) {
    assert.equal(isMemoDate(date), false, String(date));
  }
});

test('local memo dates change at local midnight and calendar navigation handles leap, year and DST boundaries', () => {
  assert.equal(localMemoDate(at(21, 23, 59, 59)), '2026-10-21');
  assert.equal(localMemoDate(at(22)), '2026-10-22');
  if (process.env.TZ === 'Asia/Seoul') assert.equal(localMemoDate(Date.UTC(2026, 9, 21, 15)), '2026-10-22');
  if (process.env.TZ === 'America/New_York') assert.equal(localMemoDate(Date.UTC(2026, 9, 22, 3)), '2026-10-21');
  assert.equal(shiftMemoDate('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftMemoDate('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftMemoDate('2026-03-08', -1), '2026-03-07');
  assert.equal(shiftMemoDate('2026-11-01', 1), '2026-11-02');
  assert.equal(shiftMemoDate('0099-12-31', 1), '0100-01-01');
  assert.throws(() => shiftMemoDate('0001-01-01', -1), /날짜/);
  assert.throws(() => shiftMemoDate('9999-12-31', 1), /날짜/);
  assert.throws(() => shiftMemoDate('2026-10-22', 0.5), /날짜/);
  assert.throws(() => localMemoDate(NaN), /날짜/);
  assert.throws(() => localMemoDate(Infinity), /날짜/);
});

test('midnight starts an empty today view while old completed and unfinished tasks stay archived across restart', () => fixture(filename => {
  let now = at(21, 23, 59);
  const service = new MemoService(filename, () => now);
  const unfinished = service.add({ text: '어제 미완료', reminderTime: null });
  const completed = service.add({ text: '어제 완료', reminderTime: null });
  service.setCompleted(completed.id, true);
  assert.equal(unfinished.date, '2026-10-21');
  now = at(22);
  assert.deepEqual(service.list().filter(memo => memo.date === localMemoDate(now)), []);
  const today = service.add({ text: '오늘 할 일', reminderTime: null });
  assert.equal(today.date, '2026-10-22');
  service.update(unfinished.id, { text: '보관한 어제 메모 수정', reminderTime: null });
  const reopened = new MemoService(filename, () => now);
  assert.deepEqual(reopened.list().filter(memo => memo.date === localMemoDate(now)), [today]);
  assert.deepEqual(reopened.list().filter(memo => memo.date === '2026-10-21').map(memo => [memo.text, memo.completed]), [
    ['보관한 어제 메모 수정', false], ['어제 완료', true],
  ]);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).version, 5);
}));

test('explicit task dates round-trip and invalid add or edit dates cannot change memory or disk', () => fixture(filename => {
  const service = new MemoService(filename, () => at(22, 9));
  const memo = service.add({ text: '내일 할 일', reminderTime: null, date: '2026-10-23' });
  assert.equal(memo.date, '2026-10-23');
  service.update(memo.id, { text: '다음주 할 일', reminderTime: null, date: '2026-10-29' });
  assert.equal(new MemoService(filename).list()[0].date, '2026-10-29');
  const baseline = service.list(), source = readFileSync(filename, 'utf8');
  for (const date of [null, 1, '', '2026-02-30', '2026-10-22\n', '2026-10-22T00:00:00Z']) {
    assert.throws(() => service.add({ text: '실패', reminderTime: null, date }), /날짜/);
    assert.throws(() => service.update(memo.id, { text: '실패', reminderTime: null, date }), /날짜/);
  }
  assert.deepEqual(service.list(), baseline);
  assert.equal(readFileSync(filename, 'utf8'), source);
}));

test('v4 migration derives local creation dates and preserves schedules, acknowledgements and original bytes', () => fixture((filename, directory) => {
  const legacy = [
    { id: randomUUID(), text: '매일', reminderTime: '15:00', completed: false, createdAt: at(20, 23, 59), updatedAt: at(21, 14),
      schedule: { kind: 'daily', time: '15:00' }, reminder: { dueAt: at(22, 15), acknowledged: false } },
    { id: randomUUID(), text: '확인함', reminderTime: '16:00', completed: false, createdAt: at(21, 0, 1), updatedAt: at(21, 17),
      schedule: { kind: 'once', dueAt: at(21, 16) }, reminder: { dueAt: at(21, 16), acknowledged: true } },
    { id: randomUUID(), text: '완료', reminderTime: null, completed: true, createdAt: at(21, 1), updatedAt: at(21, 18), reminder: null },
  ];
  const source = JSON.stringify({ version: 4, memos: legacy }, null, 2) + '\n';
  writeFileSync(filename, source);
  const service = new MemoService(filename, () => at(22, 9));
  assert.equal(readFileSync(filename, 'utf8'), source);
  assert.deepEqual(service.list().map(memo => memo.date), ['2026-10-20', '2026-10-21', '2026-10-21']);
  assert.deepEqual(service.getDueReminders(), []);
  assert.equal(readFileSync(join(directory, 'memos.v4.backup.json'), 'utf8'), source);
  const saved = JSON.parse(readFileSync(filename, 'utf8'));
  assert.equal(saved.version, 5);
  assert.deepEqual(saved.memos, legacy.map(memo => ({ ...memo, date: localMemoDate(memo.createdAt) })));
  assert.deepEqual(new MemoService(filename).list(), service.list());
}));

test('v4 backup failure blocks migration and delivery while preserving date attribution and retry', () => fixture((filename, directory) => {
  const legacy = { id: randomUUID(), text: '누락 알림', reminderTime: '15:00', completed: false, createdAt: at(20, 13),
    updatedAt: at(20, 14), reminder: { dueAt: at(20, 15), acknowledged: false } };
  const source = JSON.stringify({ version: 4, memos: [legacy] });
  writeFileSync(filename, source);
  const service = new MemoService(filename, () => at(22, 9)), baseline = service.list();
  const backup = join(directory, 'memos.v4.backup.json');
  mkdirSync(backup);
  assert.throws(() => service.getDueReminders(), /저장/);
  assert.throws(() => service.update(legacy.id, { text: '실패', reminderTime: '15:00', date: '2026-10-22' }), /저장/);
  assert.deepEqual(service.list(), baseline);
  assert.equal(readFileSync(filename, 'utf8'), source);
  assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  rmSync(backup, { recursive: true });
  assert.equal(service.getDueReminders()[0].dueAt, legacy.reminder.dueAt);
  assert.equal(readFileSync(backup, 'utf8'), source);
  assert.equal(new MemoService(filename).list()[0].date, '2026-10-20');
}));

test('the daily task limit does not consume another day and moving a task cannot overflow the destination date', () => fixture(filename => {
  const now = at(22, 9);
  const memos = Array.from({ length: 500 }, (_, index) => ({
    id: randomUUID(), text: '오늘 ' + index, date: '2026-10-22', reminderTime: null, completed: index % 2 === 0,
    createdAt: now, updatedAt: now, reminder: null,
  }));
  writeFileSync(filename, JSON.stringify({ version: 5, memos }));
  const service = new MemoService(filename, () => now);
  assert.throws(() => service.add({ text: '오늘 초과', reminderTime: null }), /500/);
  const tomorrow = service.add({ text: '내일', date: '2026-10-23', reminderTime: null });
  assert.equal(new MemoService(filename).list().length, 501);
  const source = readFileSync(filename, 'utf8');
  assert.throws(() => service.update(tomorrow.id, { text: '날짜 이동', date: '2026-10-22', reminderTime: null }), /500/);
  assert.equal(readFileSync(filename, 'utf8'), source);
  service.update(memos[0].id, { text: '가득 찬 날의 본문 수정', reminderTime: null });
  assert.equal(service.list()[0].date, '2026-10-22');
  service.delete(memos[1].id);
  service.update(tomorrow.id, { text: '빈 자리에 이동', date: '2026-10-22', reminderTime: null });
  assert.equal(service.list().filter(memo => memo.date === '2026-10-22').length, 500);
  assert.equal(new MemoService(filename).list().find(memo => memo.id === tomorrow.id)?.date, '2026-10-22');
}));

test('v5 files require an explicit valid date rather than silently reclassifying corrupt tasks', () => fixture((filename, directory) => {
  const memo = { id: randomUUID(), text: '검증', reminderTime: null, completed: false, createdAt: at(21), updatedAt: at(21), reminder: null };
  for (const extra of [{}, { date: null }, { date: '2026-02-30' }]) {
    const source = JSON.stringify({ version: 5, memos: [{ ...memo, ...extra }] });
    writeFileSync(filename, source);
    assert.throws(() => new MemoService(filename), /저장된 메모/);
    assert.equal(readFileSync(filename, 'utf8'), source);
  }
  assert.deepEqual(readdirSync(directory), ['memos.json']);
}));
