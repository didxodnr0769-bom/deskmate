import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoService } from '../src/main/features/memos';
import type { Memo } from '../src/shared/contracts';

function fixture(run: (filename: string, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'companion-memos-'));
  try { run(join(directory, 'memos.json'), directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function storedMemo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: randomUUID(), text: '회의', reminderTime: '15:00',
    completed: false, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function legacyMemo(reminderAt: string | null): Omit<Memo, 'reminderTime'> & { reminderAt: string | null } {
  const { reminderTime: _time, ...metadata } = storedMemo();
  return { ...metadata, reminderAt };
}

test('memo CRUD trims text, generates IDs and timestamps, and persists without temporary files', () => fixture((filename, directory) => {
  const service = new MemoService(filename);
  assert.deepEqual(service.list(), []);
  const before = Date.now();
  service.add({ text: '  회의 자료 준비  ', reminderTime: null });
  const [memo] = service.list();
  assert.equal(memo.text, '회의 자료 준비');
  assert.match(memo.id, /^[0-9a-f-]{36}$/);
  assert.equal(memo.completed, false);
  assert.ok(memo.createdAt >= before && memo.createdAt <= Date.now());
  assert.equal(memo.updatedAt, memo.createdAt);
  assert.deepEqual(new MemoService(filename).list(), [memo]);
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).version, 4);
  assert.deepEqual(readdirSync(directory), ['memos.json']);
  service.delete(memo.id);
  assert.deepEqual(service.list(), []);
  assert.deepEqual(new MemoService(filename).list(), []);
}));

test('editing the body preserves completion and creation, and completion can be undone without deleting', () => fixture(filename => {
  const original = storedMemo({ completed: true });
  writeFileSync(filename, JSON.stringify({ version: 2, memos: [original] }));
  const service = new MemoService(filename);
  service.update(original.id, { text: '  수정한 회의  ', reminderTime: null });
  const [edited] = service.list();
  assert.equal(edited.text, '수정한 회의');
  assert.equal(edited.id, original.id);
  assert.equal(edited.createdAt, original.createdAt);
  assert.equal(edited.completed, true);
  assert.ok(edited.updatedAt >= original.updatedAt);
  service.setCompleted(original.id, false);
  assert.equal(service.list()[0].completed, false);
  service.setCompleted(original.id, true);
  assert.equal(service.list().length, 1);
  assert.equal(new MemoService(filename).list()[0].completed, true);
}));

test('an optional memo clock time can be added, changed, or removed without any calendar date', () => fixture(filename => {
  const service = new MemoService(filename);
  service.add({ text: '메모', reminderTime: null });
  const id = service.list()[0].id;
  service.update(id, { text: '메모', reminderTime: '00:00' });
  assert.equal(service.list()[0].reminderTime, '00:00');
  service.update(id, { text: '메모', reminderTime: '23:59' });
  assert.equal(new MemoService(filename).list()[0].reminderTime, '23:59');
  service.update(id, { text: '메모', reminderTime: null });
  assert.equal(new MemoService(filename).list()[0].reminderTime, null);
}));

test('list results are detached copies that cannot mutate in-memory or persisted memos', () => fixture(filename => {
  const service = new MemoService(filename);
  service.add({ text: '원본', reminderTime: null });
  const list = service.list();
  list[0].text = '외부 수정';
  list[0].completed = true;
  list.push(storedMemo());
  assert.equal(service.list().length, 1);
  assert.equal(service.list()[0].text, '원본');
  assert.equal(service.list()[0].completed, false);
  assert.equal(new MemoService(filename).list()[0].text, '원본');
}));

test('malformed drafts and invalid or date-bearing clock times are rejected without changing state', () => fixture(filename => {
  const service = new MemoService(filename);
  service.add({ text: 'x'.repeat(1000), reminderTime: null });
  const baseline = service.list();
  const contents = readFileSync(filename, 'utf8');
  const invalid: unknown[] = [null, [], {}, '메모', { text: 123, reminderTime: null },
    { text: '', reminderTime: null }, { text: ' \n ', reminderTime: null },
    { text: 'x'.repeat(1001), reminderTime: null }, { text: '메모' }, { text: '메모', reminderTime: 123 }];
  for (const reminderTime of ['', '9:00', '09:0', '24:00', '12:60', '09:00:00', '09:00\n', ' 09:00',
    '2026-10-20', '2026-10-20T06:00:00.000Z', '2026-10-20T15:00:00.000+09:00']) {
    invalid.push({ text: '메모', reminderTime });
  }
  for (const draft of invalid) {
    assert.throws(() => service.add(draft));
    assert.throws(() => service.update(baseline[0].id, draft));
  }
  assert.deepEqual(service.list(), baseline);
  assert.equal(readFileSync(filename, 'utf8'), contents);
}));

test('unknown IDs and invalid completion values never change other memos', () => fixture(filename => {
  const service = new MemoService(filename);
  service.add({ text: '유지할 메모', reminderTime: null });
  const baseline = service.list();
  for (const id of [null, 12, '', randomUUID()]) {
    assert.throws(() => service.update(id, { text: '변경', reminderTime: null }));
    assert.throws(() => service.setCompleted(id, true));
    assert.throws(() => service.delete(id));
  }
  for (const completed of [null, undefined, 1, 'true']) assert.throws(() => service.setCompleted(baseline[0].id, completed));
  assert.deepEqual(service.list(), baseline);
  assert.deepEqual(new MemoService(filename).list(), baseline);
}));

test('corrupt or unknown-version files remain untouched when loading fails', () => fixture(filename => {
  const memo = storedMemo();
  const invalid = [
    '{', '', JSON.stringify({ version: 5, memos: [] }), JSON.stringify({ version: 2, memos: {} }),
    JSON.stringify({ version: 2, memos: [memo, { ...memo }] }),
    JSON.stringify({ version: 2, memos: [{ ...memo, id: 'invalid-id' }] }),
    JSON.stringify({ version: 2, memos: [{ ...memo, id: `${memo.id}\n` }] }),
    JSON.stringify({ version: 2, memos: [{ ...memo, text: '   ' }] }),
    JSON.stringify({ version: 2, memos: [{ ...memo, completed: 'true' }] }),
    JSON.stringify({ version: 2, memos: [{ ...memo, createdAt: -1 }] }),
    JSON.stringify({ version: 2, memos: [{ ...memo, updatedAt: 'today' }] }),
    JSON.stringify({ version: 2, memos: [{ ...memo, reminderTime: '24:00' }] }),
    JSON.stringify({ version: 2, memos: [{ ...memo, reminderTime: '2026-10-20T06:00:00.000Z' }] }),
    JSON.stringify({ version: 2, memos: [null] }),
  ];
  for (const contents of invalid) {
    writeFileSync(filename, contents);
    assert.throws(() => new MemoService(filename), /저장된 메모/);
    assert.equal(readFileSync(filename, 'utf8'), contents);
  }
}));

test('five hundred memos including completed entries are retained and the limit cannot be exceeded', () => fixture(filename => {
  const memos = Array.from({ length: 500 }, (_, index) => storedMemo({ text: `메모 ${index}`, completed: index % 2 === 0 }));
  writeFileSync(filename, JSON.stringify({ version: 2, memos }));
  const service = new MemoService(filename);
  assert.equal(service.list().length, 500);
  assert.throws(() => service.add({ text: '추가', reminderTime: null }), /500/);
  assert.deepEqual(service.list(), memos);
  const oversizedList = JSON.stringify({ version: 2, memos: [...memos, storedMemo()] });
  writeFileSync(filename, oversizedList);
  assert.throws(() => new MemoService(filename));
  assert.equal(readFileSync(filename, 'utf8'), oversizedList);
}));

test('oversized files and non-file paths fail safely instead of loading as an empty list', () => fixture((filename, directory) => {
  const contents = 'x'.repeat(2 * 1024 * 1024 + 1);
  writeFileSync(filename, contents);
  assert.throws(() => new MemoService(filename), /저장된 메모/);
  assert.equal(readFileSync(filename, 'utf8'), contents);
  assert.throws(() => new MemoService(directory), error => error instanceof Error && !error.message.includes(directory));
}));

test('saving creates nested parent folders without leaving temporary files', () => fixture((_filename, directory) => {
  const filename = join(directory, 'nested', 'data', 'memos.json');
  const service = new MemoService(filename);
  service.add({ text: '중첩 경로 메모', reminderTime: null });
  assert.deepEqual(new MemoService(filename).list(), service.list());
  assert.deepEqual(readdirSync(join(directory, 'nested', 'data')), ['memos.json']);
}));

test('every failed write leaves memory unchanged, cleans temporary files, and hides OS paths', () => fixture((filename, directory) => {
  const service = new MemoService(filename);
  service.add({ text: '원본', reminderTime: null });
  const baseline = service.list();
  const backup = `${filename}.backup`;
  const contents = readFileSync(filename, 'utf8');
  renameSync(filename, backup);
  mkdirSync(filename);
  for (const operation of [
    () => service.add({ text: '추가 실패', reminderTime: null }),
    () => service.update(baseline[0].id, { text: '수정 실패', reminderTime: null }),
    () => service.setCompleted(baseline[0].id, true),
    () => service.delete(baseline[0].id),
  ]) {
    assert.throws(operation, error => error instanceof Error && /저장/.test(error.message) && !error.message.includes(directory));
    assert.deepEqual(service.list(), baseline);
    assert.equal(readFileSync(backup, 'utf8'), contents);
    assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  }
  rmSync(filename, { recursive: true });
  renameSync(backup, filename);
  service.update(baseline[0].id, { text: '저장 재시도', reminderTime: null });
  assert.equal(new MemoService(filename).list()[0].text, '저장 재시도');
}));

test('v1 calendar reminders load as local HH:mm while preserving metadata and the original file', () => fixture((filename, directory) => {
  const calendarReminder = {
    ...legacyMemo(new Date(2026, 0, 1, 0, 15, 45, 678).toISOString()),
    text: '예전 회의', completed: true,
  };
  const untimed = legacyMemo(null);
  const source = `${JSON.stringify({ version: 1, memos: [calendarReminder, untimed] }, null, 2)}\n`;
  writeFileSync(filename, source);
  const service = new MemoService(filename);
  const { reminderAt: _firstTime, ...firstMetadata } = calendarReminder;
  const { reminderAt: _secondTime, ...secondMetadata } = untimed;
  assert.deepEqual(service.list(), [
    { ...firstMetadata, reminderTime: '00:15' },
    { ...secondMetadata, reminderTime: null },
  ]);
  assert.equal(readFileSync(filename, 'utf8'), source);
  assert.deepEqual(readdirSync(directory), ['memos.json']);

  service.setCompleted(calendarReminder.id, false);
  const backup = join(directory, 'memos.v1.backup.json');
  assert.equal(readFileSync(backup, 'utf8'), source);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  const saved = JSON.parse(readFileSync(filename, 'utf8'));
  assert.equal(saved.version, 4);
  assert.equal(saved.memos[0].reminderTime, '00:15');
  assert.equal(saved.memos[1].reminderTime, null);
  assert.equal(saved.memos.some((memo: Record<string, unknown>) => 'reminderAt' in memo), false);
  assert.deepEqual(new MemoService(filename).list(), service.list());
  service.update(untimed.id, { text: '시간 추가', reminderTime: '18:30' });
  assert.equal(readFileSync(backup, 'utf8'), source);
  assert.equal(new MemoService(filename).list()[1].reminderTime, '18:30');
  assert.deepEqual(readdirSync(directory).sort(), ['memos.json', 'memos.v1.backup.json']);
}));

test('an existing v1 backup is never overwritten by a later migration', () => fixture((filename, directory) => {
  const original = legacyMemo('2026-10-20T06:00:00.000Z');
  writeFileSync(filename, JSON.stringify({ version: 1, memos: [original] }));
  const backup = join(directory, 'memos.v1.backup.json');
  const previousBackup = '보존할 이전 원본\n';
  writeFileSync(backup, previousBackup, { mode: 0o600 });
  const service = new MemoService(filename);
  service.update(original.id, { text: '본문 수정', reminderTime: '15:00' });
  assert.equal(readFileSync(backup, 'utf8'), previousBackup);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).version, 4);
  assert.equal(new MemoService(filename).list()[0].text, '본문 수정');
}));

test('a failed v1 backup prevents migration and keeps both live data and memory unchanged', () => fixture((filename, directory) => {
  const source = JSON.stringify({ version: 1, memos: [legacyMemo(null)] });
  writeFileSync(filename, source);
  const service = new MemoService(filename);
  const baseline = service.list();
  const backup = join(directory, 'memos.v1.backup.json');
  mkdirSync(backup);
  assert.throws(() => service.add({ text: '백업 실패', reminderTime: '12:30' }),
    error => error instanceof Error && /저장/.test(error.message) && !error.message.includes(directory));
  assert.equal(readFileSync(filename, 'utf8'), source);
  assert.deepEqual(service.list(), baseline);
  assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
  rmSync(backup, { recursive: true });
  service.add({ text: '백업 재시도', reminderTime: '12:30' });
  assert.equal(readFileSync(backup, 'utf8'), source);
  assert.equal(JSON.parse(readFileSync(filename, 'utf8')).version, 4);
  assert.deepEqual(new MemoService(filename).list(), service.list());
}));

test('malformed v1 dates are rejected without a backup or any modification to the original', () => fixture((filename, directory) => {
  for (const reminderAt of ['2026-02-30T06:00:00.000Z', '2026-10-20T24:00:00.000Z',
    '2026-10-20T06:00:00Z', '2026-10-20T15:00:00.000+09:00', '2026-10-20T06:00:00.000Z\n']) {
    const source = JSON.stringify({ version: 1, memos: [legacyMemo(reminderAt)] });
    writeFileSync(filename, source);
    assert.throws(() => new MemoService(filename), /저장된 메모/);
    assert.equal(readFileSync(filename, 'utf8'), source);
    assert.deepEqual(readdirSync(directory), ['memos.json']);
  }
}));
