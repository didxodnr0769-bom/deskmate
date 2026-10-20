import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkBriefingService } from '../src/main/features/briefing';
import type { Memo } from '../src/shared/contracts';
const schedule = { date: '2026-10-20', startTime: '09:00', endTime: '18:00' };
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
const memo: Memo = { id: 'fixture', text: '마무리할 일', reminderTime: null, completed: false, createdAt: 0, updatedAt: 0 };
function fixture(run: (service: WorkBriefingService, path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'deskmate-briefing-')); const path = join(directory, 'briefing.json');
  try { run(new WorkBriefingService(path), path); } finally { rmSync(directory, { recursive: true, force: true }); }
}
test('briefing is opt-in, persists its lead time and only appears within the active shift window with unfinished work', () => fixture((service, path) => {
  assert.equal(service.due(schedule, [memo], at(20, 17, 40)), null);
  service.configure({ enabled: true, beforeMinutes: 30 });
  assert.equal(service.due(schedule, [memo], at(20, 17, 29)), null);
  assert.match(service.due(schedule, [memo], at(20, 17, 30))!.text, /남은 할 일 1개/);
  assert.equal(service.due(schedule, [{ ...memo, completed: true }], at(20, 17, 40)), null);
  assert.equal(service.due(schedule, [memo], at(20, 18)), null);
  assert.deepEqual(new WorkBriefingService(path).settings, { enabled: true, beforeMinutes: 30 });
}));
test('unclosed briefing survives restarting before the end and an acknowledged shift never repeats', () => fixture((service, path) => {
  service.configure({ enabled: true, beforeMinutes: 30 });
  const first = service.due(schedule, [memo], at(20, 17, 40))!;
  const reopened = new WorkBriefingService(path);
  assert.equal(reopened.due(schedule, [memo], at(20, 17, 45))!.occurrence, first.occurrence);
  reopened.acknowledge(first.occurrence);
  assert.equal(new WorkBriefingService(path).due(schedule, [memo], at(20, 17, 50)), null);
}));
test('overnight briefing uses the original start date and suppresses a missed summary after the end', () => fixture(service => {
  const night = { date: '2026-10-20', startTime: '22:00', endTime: '07:00' };
  service.configure({ enabled: true, beforeMinutes: 30 });
  assert.equal(service.due(night, [memo], at(20, 21)), null);
  assert.equal(service.due(night, [memo], at(21, 6, 29)), null);
  assert.ok(service.due(night, [memo], at(21, 6, 30)));
  assert.equal(service.due(night, [memo], at(21, 7)), null);
}));
test('failed settings or acknowledgement writes preserve memory and the original data and can be retried', () => fixture((service, path) => {
  service.configure({ enabled: true, beforeMinutes: 30 });
  const occurrence = service.due(schedule, [memo], at(20, 17, 40))!.occurrence;
  const original = readFileSync(path); const backup = path + '.preserved';
  renameSync(path, backup); mkdirSync(path);
  assert.throws(() => service.configure({ enabled: false, beforeMinutes: 10 }));
  assert.deepEqual(service.settings, { enabled: true, beforeMinutes: 30 });
  assert.throws(() => service.acknowledge(occurrence));
  assert.ok(service.due(schedule, [memo], at(20, 17, 45)));
  assert.deepEqual(readFileSync(backup), original);
  rmSync(path, { recursive: true }); renameSync(backup, path);
  service.acknowledge(occurrence); assert.equal(new WorkBriefingService(path).due(schedule, [memo], at(20, 17, 50)), null);
}));
test('corrupt files and invalid settings are rejected without replacing the file or the committed setting', () => fixture((service, path) => {
  for (const value of [{ enabled: 'yes', beforeMinutes: 30 }, { enabled: true, beforeMinutes: 0 }, { enabled: true, beforeMinutes: 121 }]) assert.throws(() => service.configure(value));
  assert.deepEqual(service.settings, { enabled: false, beforeMinutes: 30 });
  writeFileSync(path, '{broken'); const original = readFileSync(path);
  assert.throws(() => new WorkBriefingService(path)); assert.deepEqual(readFileSync(path), original);
}));
test('settings snapshots and completed memos cannot mutate or appear in a summary', () => fixture(service => {
  service.configure({ enabled: true, beforeMinutes: 30 }); const snapshot = service.settings; snapshot.enabled = false;
  const items = [memo, { ...memo, id: 'done', text: '끝낸 일', completed: true }];
  const due = service.due(schedule, items, at(20, 17, 40))!;
  assert.match(due.text, /마무리할 일/); assert.doesNotMatch(due.text, /끝낸 일/); assert.equal(service.settings.enabled, true);
}));
