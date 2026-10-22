import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoService } from '../src/main/features/memos';
import { AppCommandService, type AppCommandPorts } from '../src/main/features/app-commands';
import type { CommandResult, PanelTab, WorkSchedule } from '../src/shared/contracts';

function fixture(run: (h: ReturnType<typeof create>) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'deskmate-app-commands-'));
  try { run(create(directory)); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function create(directory: string) {
  let now = new Date(2026, 9, 20, 9, 0, 12, 345).getTime();
  const memos = new MemoService(join(directory, 'memos.json'), () => now);
  let work: WorkSchedule | null = null, walking = true, opened: PanelTab | 'chat' | null = null, fail = false;
  const mutate = (action: () => void): CommandResult => {
    if (fail) return { ok: false, error: 'PRIVATE_STORAGE_DIAGNOSTIC' };
    action(); return { ok: true };
  };
  const ports: AppCommandPorts = {
    memos: () => memos.list(), addMemo: draft => mutate(() => memos.add(draft)),
    updateMemo: (id, draft) => mutate(() => memos.update(id, draft)),
    completeMemo: (id, completed) => mutate(() => memos.setCompleted(id, completed)),
    workSchedule: () => work, saveWorkSchedule: schedule => mutate(() => { work = { ...schedule }; }),
    setWalking: enabled => { walking = enabled; }, open: target => { opened = target; },
  };
  const service = new AppCommandService(ports, () => now);
  return { memos, service, now: () => now, setNow: (value: number) => { now = value; },
    state: () => ({ work, walking, opened }), fail: (value: boolean) => { fail = value; },
    command: (command: Record<string, unknown>, question = '앱에 요청') => service.process(JSON.stringify({ kind: 'command', command }), question),
    reply: (question: string) => service.process(JSON.stringify({ kind: 'reply', text: '일반 답변' }), question),
  };
}

test('memo commands save exact relative minutes and daily or selected-weekday reminders through the real domain', () => fixture(h => {
  assert.match(h.command({ name: 'memo.add', text: '회의', reminder: { kind: 'after', minutes: 30 } }), /추가했어요/);
  assert.deepEqual(h.memos.list()[0].schedule, { kind: 'once', dueAt: h.now() + 30 * 60000 });
  h.command({ name: 'memo.add', text: '아침 확인', reminder: { kind: 'daily', time: '09:00' } });
  assert.deepEqual(h.memos.list().find(m => m.text === '아침 확인')!.schedule, { kind: 'daily', time: '09:00' });
  h.command({ name: 'memo.add', text: '주간 확인', reminder: { kind: 'weekly', time: '10:00', weekdays: [5, 1, 3] } });
  assert.deepEqual(h.memos.list().find(m => m.text === '주간 확인')!.schedule, { kind: 'weekly', time: '10:00', weekdays: [1, 3, 5] });
}));

test('memo search, complete and undo report only actual stored values', () => fixture(h => {
  h.command({ name: 'memo.add', text: '회의 자료' }); h.command({ name: 'memo.add', text: '장보기' });
  assert.match(h.command({ name: 'memo.list', query: '회의', completed: false }), /회의 자료/);
  assert.doesNotMatch(h.command({ name: 'memo.list', query: '회의' }), /장보기/);
  h.command({ name: 'memo.complete', target: '회의 자료', completed: true });
  assert.equal(h.memos.list().find(m => m.text === '회의 자료')!.completed, true);
  assert.doesNotMatch(h.command({ name: 'memo.list', completed: false }), /회의 자료/);
  h.command({ name: 'memo.complete', target: '회의 자료', completed: false });
  assert.equal(h.memos.list().find(m => m.text === '회의 자료')!.completed, false);
}));

test('editing text retains the scheduled instant while an explicit clock removes repetition at the same time', () => fixture(h => {
  h.command({ name: 'memo.add', text: '반복 회의', reminder: { kind: 'daily', time: '09:00' } });
  const item = h.memos.list()[0];
  h.command({ name: 'memo.update', target: '반복 회의', text: '바뀐 회의' });
  assert.deepEqual(h.memos.list()[0].schedule, item.schedule);
  h.command({ name: 'memo.update', target: '바뀐 회의', reminder: { kind: 'clock', time: '09:00' } });
  assert.equal(h.memos.list()[0].schedule, undefined);
  h.command({ name: 'memo.update', target: '바뀐 회의', reminder: null });
  assert.equal(h.memos.list()[0].reminderTime, null);
}));

test('duplicate memo titles never select the first match implicitly and an explicit number resolves one target', () => fixture(h => {
  h.command({ name: 'memo.add', text: '회의' }); h.command({ name: 'memo.add', text: '회의' });
  const ids = h.memos.list().map(m => m.id);
  assert.match(h.command({ name: 'memo.complete', target: '회의', completed: true }), /어느 메모/);
  assert.match(h.reply('회의'), /번호로/);
  assert.ok(h.memos.list().every(m => !m.completed));
  assert.match(h.reply('2번'), /완료를 기록/);
  assert.equal(h.memos.list().find(m => m.id === ids[0])!.completed, false);
  assert.equal(h.memos.list().find(m => m.id === ids[1])!.completed, true);
}));

test('stale target state and negative ordinal replies cannot execute a pending mutation', () => fixture(h => {
  h.command({ name: 'memo.add', text: '회의 A' }); h.command({ name: 'memo.add', text: '회의 B' });
  const items = h.memos.list();
  h.command({ name: 'memo.complete', target: '회의', completed: true });
  h.memos.setCompleted(items[1].id, true); // Same millisecond still changes the revision.
  assert.match(h.reply('두 번째'), /변경되었어요/);
  h.command({ name: 'memo.complete', target: '회의', completed: false });
  h.reply('두 번째는 선택하지 마');
  assert.equal(h.memos.list().find(m => m.id === items[1].id)!.completed, true);
}));

test('new-conversation reset and cancellation of a choice clear pending targets', () => fixture(h => {
  h.command({ name: 'memo.add', text: '회의 A' }); h.command({ name: 'memo.add', text: '회의 B' });
  h.command({ name: 'memo.complete', target: '회의', completed: true }); h.service.reset();
  assert.equal(h.reply('1번'), '일반 답변');
  h.command({ name: 'memo.complete', target: '회의', completed: true }); assert.match(h.reply('취소'), /취소했어요/);
  h.reply('2번'); assert.ok(h.memos.list().every(m => !m.completed));
}));

test('work updates keep an overnight shift date unless the user explicitly supplies a new date', () => fixture(h => {
  h.command({ name: 'work.update', date: '2026-10-19', startTime: '22:00', endTime: '07:00' });
  h.setNow(new Date(2026, 9, 20, 1, 0).getTime());
  assert.match(h.command({ name: 'work.update', endTime: '08:00' }), /저장했어요/);
  assert.deepEqual(h.state().work, { date: '2026-10-19', startTime: '22:00', endTime: '08:00' });
  h.command({ name: 'work.update', date: '2026-10-20', startTime: '09:00' });
  assert.deepEqual(h.state().work, { date: '2026-10-20', startTime: '09:00', endTime: '18:00' });
  assert.match(h.command({ name: 'work.get' }), /2026-10-20/);
  const before = h.state().work;
  h.command({ name: 'work.update', date: '2026-02-30', startTime: '09:00' }); assert.deepEqual(h.state().work, before);
}));

test('character, screen and summary commands use only their explicit application ports', () => fixture(h => {
  h.command({ name: 'character.walk', enabled: false }); assert.equal(h.state().walking, false);
  h.command({ name: 'character.walk', enabled: true }); assert.equal(h.state().walking, true);
  for (const target of ['chat', 'work', 'memos', 'appearance', 'settings']) { h.command({ name: 'ui.open', target }); assert.equal(h.state().opened, target); }
  h.command({ name: 'memo.add', text: '확인할 일' });
  const summary = h.command({ name: 'summary.get' }); assert.match(summary, /확인할 일/); assert.match(summary, /근무 시간이 없어요/);
}));

test('unsupported names, extra execution fields, malformed envelopes and invalid schedule values never mutate', () => fixture(h => {
  for (const command of [
    { name: 'shell.exec', command: 'anything' }, { name: 'memo.add', text: '추가 금지', executable: 'anything' },
    { name: 'memo.add', text: '추가 금지', reminder: { kind: 'after', minutes: -1 } },
    { name: 'memo.add', text: '추가 금지', reminder: { kind: 'weekly', time: '09:00', weekdays: [1, 1] } },
    { name: 'character.walk', enabled: 'true' }, { name: 'briefing.configure', enabled: true, beforeMinutes: 0 },
    { name: 'work.update', startTime: '25:00' },
  ]) h.command(command);
  h.service.process('{"kind":"command",', '요청'); h.service.process('[]', '요청');
  assert.equal(h.memos.list().length, 0); assert.equal(h.state().work, null);
  assert.equal(h.state().walking, true);
}));

test('storage failures never become successful action messages or disclose raw diagnostics and remain retryable', () => fixture(h => {
  h.fail(true);
  const result = h.command({ name: 'memo.add', text: '저장 실패' });
  assert.doesNotMatch(result, /추가했어요|PRIVATE_STORAGE_DIAGNOSTIC/); assert.equal(h.memos.list().length, 0);
  h.fail(false); assert.match(h.command({ name: 'memo.add', text: '다시 저장' }), /추가했어요/);
}));

test('ordinary conversation and quoted command-shaped text do not execute application work', () => fixture(h => {
  assert.equal(h.service.process('안녕하세요.', '안녕'), '안녕하세요.');
  const quoted = '{"kind":"command","command":{"name":"memo.add","text":"인용문"}}';
  assert.equal(h.service.process(JSON.stringify({ kind: 'reply', text: quoted }), '이 문구를 설명해줘'), quoted);
  assert.equal(h.memos.list().length, 0);
}));


test('memo defaults and summary contain only today while explicit dates can read and edit archives', () => fixture(h => {
  const yesterday = h.memos.add({ text: '어제 작업', reminderTime: null, date: '2026-10-19' });
  h.command({ name: 'memo.add', text: '오늘 작업' });
  h.command({ name: 'memo.add', text: '내일 작업', date: '2026-10-21' });
  assert.match(h.command({ name: 'memo.list' }), /오늘 작업/);
  assert.doesNotMatch(h.command({ name: 'memo.list' }), /어제 작업|내일 작업/);
  assert.doesNotMatch(h.command({ name: 'summary.get' }), /어제 작업|내일 작업/);
  assert.match(h.command({ name: 'memo.list', date: '2026-10-19' }), /어제 작업/);
  h.command({ name: 'memo.complete', target: '어제 작업', completed: true });
  assert.equal(h.memos.list().find(item => item.id === yesterday.id)!.completed, false);
  h.command({ name: 'memo.update', date: '2026-10-19', target: '어제 작업', text: '어제 작업 수정' });
  const edited = h.memos.list().find(item => item.id === yesterday.id)!;
  assert.equal(edited.date, '2026-10-19'); assert.equal(edited.text, '어제 작업 수정');
  h.command({ name: 'memo.complete', date: '2026-10-19', target: '어제 작업 수정', completed: true });
  assert.equal(h.memos.list().find(item => item.id === yesterday.id)!.completed, true);
  h.setNow(new Date(2026, 9, 21, 0, 0).getTime());
  assert.match(h.command({ name: 'memo.list' }), /내일 작업/);
  assert.doesNotMatch(h.command({ name: 'memo.list' }), /오늘 작업|어제 작업/);
}));

test('invalid memo dates cannot read archives or mutate and retired briefing commands stay unsupported', () => fixture(h => {
  h.command({ name: 'memo.add', text: '원본' });
  const before = h.memos.list();
  for (const date of ['2026-02-30', '2026-1-1', '', null, 20261020]) {
    assert.match(h.command({ name: 'memo.list', date }), /날짜/);
    h.command({ name: 'memo.add', date, text: '생성 금지' });
    h.command({ name: 'memo.complete', date, target: '원본', completed: true });
    h.command({ name: 'memo.update', date, target: '원본', text: '변경 금지' });
  }
  assert.match(h.command({ name: 'briefing.configure', enabled: true, beforeMinutes: 30 }), /지원하지 않는/);
  assert.deepEqual(h.memos.list(), before);
}));

test('midnight invalidates an implicit-date pending choice but an explicitly scoped archive choice remains valid', () => fixture(h => {
  h.command({ name: 'memo.add', text: '회의 A' }); h.command({ name: 'memo.add', text: '회의 B' });
  h.command({ name: 'memo.complete', target: '회의', completed: true });
  h.setNow(new Date(2026, 9, 21, 0, 0).getTime());
  assert.match(h.reply('1번'), /날짜가 바뀌었어요/);
  assert.ok(h.memos.list().every(item => !item.completed));
  h.command({ name: 'memo.complete', date: '2026-10-20', target: '회의', completed: true });
  h.setNow(new Date(2026, 9, 22, 0, 0).getTime());
  assert.match(h.reply('2번'), /완료를 기록/);
  assert.equal(h.memos.list()[1].completed, true);
}));
