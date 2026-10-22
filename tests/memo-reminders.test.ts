import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, renameSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoService } from '../src/main/features/memos';
import { localMemoDate } from '../src/shared/memo-date';

const at = (day: number, hour: number, minute = 0, second = 0) => new Date(2026, 9, day, hour, minute, second).getTime();
function fixture(run: (filename: string, setNow: (value: number) => void, open: () => MemoService) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-reminders-'));
  const filename = join(directory, 'memos.json');
  let now = at(20, 14);
  try { run(filename, value => { now = value; }, () => new MemoService(filename, () => now)); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('one-shot reminders persist their due instant, survive missed time, and stay acknowledged after restart', () => fixture((filename, setNow, open) => {
  const service = open();
  service.add({ text: '회의', reminderTime: '15:00' });
  assert.deepEqual(service.getDueReminders(), []);
  setNow(at(21, 9));
  const reopened = open();
  const [due] = reopened.getDueReminders();
  assert.equal(due.dueAt, at(20, 15));
  assert.equal(due.text, '회의');
  assert.deepEqual(open().getDueReminders(), [due]);
  reopened.acknowledgeReminder(due.memoId, due.dueAt);
  assert.deepEqual(open().getDueReminders(), []);
  setNow(at(22, 15));
  assert.deepEqual(open().getDueReminders(), []);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).memos[0].reminder.acknowledged, true);
}));

test('current-minute delivery is immediate; passed clock times arm only the next local day', () => fixture((_filename, setNow, open) => {
  setNow(at(20, 15, 0, 42));
  const service = open();
  service.add({ text: '지금', reminderTime: '15:00' });
  service.add({ text: '내일', reminderTime: '14:59' });
  assert.deepEqual(service.getDueReminders().map(item => item.text), ['지금']);
  setNow(at(21, 14, 58));
  assert.deepEqual(service.getDueReminders().map(item => item.text), ['지금']);
  setNow(at(21, 14, 59));
  assert.deepEqual(service.getDueReminders().map(item => item.text), ['지금', '내일']);
}));

test('body edits preserve due time and acknowledgement; a clock change creates a new reservation', () => fixture((_filename, setNow, open) => {
  const service = open();
  service.add({ text: '원본', reminderTime: '15:00' });
  const id = service.list()[0].id;
  setNow(at(20, 16));
  service.update(id, { text: '수정', reminderTime: '15:00' });
  const [due] = service.getDueReminders();
  assert.equal(due.dueAt, at(20, 15));
  assert.equal(due.text, '수정');
  service.acknowledgeReminder(id, due.dueAt);
  service.update(id, { text: '본문만 다시 수정', reminderTime: '15:00' });
  assert.deepEqual(service.getDueReminders(), []);
  service.update(id, { text: '새 예약', reminderTime: '16:00' });
  assert.equal(service.getDueReminders()[0].dueAt, at(20, 16));
  assert.throws(() => service.acknowledgeReminder(id, due.dueAt), /변경/);
}));

test('completion cancels, undo completion rearms once, and repeated completion values cannot rearm', () => fixture((_filename, setNow, open) => {
  const service = open();
  service.add({ text: '메모', reminderTime: '15:00' });
  const id = service.list()[0].id;
  service.setCompleted(id, true);
  setNow(at(20, 16));
  assert.deepEqual(service.getDueReminders(), []);
  service.update(id, { text: '완료 메모', reminderTime: '16:00' });
  assert.deepEqual(service.getDueReminders(), []);
  service.setCompleted(id, false);
  const [due] = service.getDueReminders();
  assert.equal(due.dueAt, at(20, 16));
  service.acknowledgeReminder(id, due.dueAt);
  service.setCompleted(id, false);
  assert.deepEqual(open().getDueReminders(), []);
  assert.equal(service.list()[0].completed, false);
}));

test('removing a clock time and deleting a memo remove both active and future reservations', () => fixture((_filename, setNow, open) => {
  const service = open();
  service.add({ text: '메모', reminderTime: '15:00' });
  const id = service.list()[0].id;
  setNow(at(20, 15));
  const [due] = service.getDueReminders();
  service.update(id, { text: '메모', reminderTime: null });
  assert.deepEqual(service.getDueReminders(), []);
  assert.equal(service.getPendingReminder(id, due.dueAt), null);
  service.update(id, { text: '메모', reminderTime: '15:00' });
  assert.equal(service.getDueReminders().length, 1);
  service.delete(id);
  assert.deepEqual(open().getDueReminders(), []);
}));

test('simultaneous reminders sort deterministically, snapshots are detached, and active alarms survive clock rollback', () => fixture((_filename, setNow, open) => {
  const service = open();
  service.add({ text: '나중', reminderTime: '16:00' });
  service.add({ text: '동시 A', reminderTime: '15:00' });
  service.add({ text: '동시 B', reminderTime: '15:00' });
  setNow(at(20, 17));
  const due = service.getDueReminders();
  assert.equal(due[2].text, '나중');
  assert.ok(due[0].memoId.localeCompare(due[1].memoId) < 0);
  const active = { ...due[0] };
  due[0].text = '외부 변경';
  assert.notEqual(service.getDueReminders()[0].text, '외부 변경');
  setNow(at(20, 13));
  assert.deepEqual(service.getDueReminders(), []);
  assert.deepEqual(service.getPendingReminder(active.memoId, active.dueAt), active);
}));

test('failed acknowledgement preserves live alarm, original file and retry; duplicate acknowledgement is idempotent', () => fixture((filename, setNow, open) => {
  const service = open();
  service.add({ text: '메모', reminderTime: '15:00' });
  setNow(at(20, 15));
  const [due] = service.getDueReminders();
  const original = readFileSync(filename, 'utf8');
  renameSync(filename, `${filename}.saved`);
  mkdirSync(filename);
  assert.throws(() => service.acknowledgeReminder(due.memoId, due.dueAt), /저장/);
  assert.deepEqual(service.getDueReminders(), [due]);
  assert.equal(readFileSync(`${filename}.saved`, 'utf8'), original);
  assert.equal(readdirSync(join(filename, '..')).some(name => name.endsWith('.tmp')), false);
  rmSync(filename, { recursive: true });
  renameSync(`${filename}.saved`, filename);
  service.acknowledgeReminder(due.memoId, due.dueAt);
  const committed = readFileSync(filename, 'utf8');
  service.acknowledgeReminder(due.memoId, due.dueAt);
  assert.equal(readFileSync(filename, 'utf8'), committed);
  assert.deepEqual(open().getDueReminders(), []);
}));

test('v2 upgrade is read-only until alarm initialization, backs up exact bytes, and persists upcoming reservations', () => fixture((filename, setNow, open) => {
  const memo = { id: randomUUID(), text: '기존 메모', reminderTime: '13:00', completed: false, createdAt: 1, updatedAt: 2 };
  const source = `${JSON.stringify({ version: 2, memos: [memo, { ...memo, id: randomUUID(), completed: true }] }, null, 2)}\n`;
  writeFileSync(filename, source);
  const service = open();
  assert.equal(readFileSync(filename, 'utf8'), source);
  assert.equal(service.list()[0].updatedAt, 2);
  assert.deepEqual(service.getDueReminders(), []);
  assert.equal(readFileSync(join(filename, '..', 'memos.v2.backup.json'), 'utf8'), source);
  assert.equal(statSync(join(filename, '..', 'memos.v2.backup.json')).mode & 0o777, 0o600);
  setNow(at(21, 14));
  const due = open().getDueReminders();
  assert.equal(due.length, 1);
  assert.equal(due[0].dueAt, at(21, 13));
  assert.equal(open().list()[0].updatedAt, 2);
}));

test('failed v2 backup blocks delivery and preserves bytes and reservations until a successful retry', () => fixture((filename, setNow, open) => {
  const memo = { id: randomUUID(), text: '원본', reminderTime: '14:00', completed: false, createdAt: 1, updatedAt: 2 };
  const source = JSON.stringify({ version: 2, memos: [memo] });
  writeFileSync(filename, source);
  const backup = join(filename, '..', 'memos.v2.backup.json');
  mkdirSync(backup);
  const service = open();
  assert.throws(() => service.getDueReminders(), /저장/);
  assert.equal(readFileSync(filename, 'utf8'), source);
  assert.deepEqual(service.list(), [{ ...memo, date: localMemoDate(memo.createdAt) }]);
  rmSync(backup, { recursive: true });
  setNow(at(21, 15));
  assert.equal(service.getDueReminders()[0].dueAt, at(20, 14));
  assert.equal(readFileSync(backup, 'utf8'), source);
  assert.equal(open().getDueReminders().length, 1);
}));

test('v3 rejects malformed reminder metadata without replacing the file', () => fixture((filename, _setNow, open) => {
  const memo = { id: randomUUID(), text: '메모', reminderTime: '15:00', completed: false, createdAt: 1, updatedAt: 2 };
  const invalid = [undefined, null, {}, { dueAt: -1, acknowledged: false }, { dueAt: at(20, 15), acknowledged: 'true' },
    { dueAt: NaN, acknowledged: false }, { dueAt: 1.5, acknowledged: false }];
  for (const reminder of invalid) {
    const source = JSON.stringify({ version: 3, memos: [{ ...memo, reminder }] });
    writeFileSync(filename, source);
    assert.throws(open, /저장된 메모/);
    assert.equal(readFileSync(filename, 'utf8'), source);
  }
  for (const override of [{ completed: true }, { reminderTime: null }]) {
    writeFileSync(filename, JSON.stringify({ version: 3, memos: [{ ...memo, ...override, reminder: { dueAt: at(20, 15), acknowledged: false } }] }));
    assert.throws(open, /저장된 메모/);
  }
}));
