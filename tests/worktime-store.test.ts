import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkSchedule, saveWorkSchedule } from '../src/main/domain/worktime-store';

test('committed work schedule survives reopening and is replaced without leftover temporary files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-worktime-'));
  try {
    const filename = join(dir, 'worktime.json');
    assert.equal(loadWorkSchedule(filename), null);
    const first = { date: '2026-10-19', startTime: '09:00', endTime: '18:00' };
    saveWorkSchedule(filename, first);
    assert.deepEqual(loadWorkSchedule(filename), first);
    const changed = { ...first, endTime: '19:30' };
    saveWorkSchedule(filename, changed);
    assert.deepEqual(loadWorkSchedule(filename), changed);
    assert.deepEqual(readdirSync(dir), ['worktime.json']);
    assert.throws(() => saveWorkSchedule(filename, { ...first, endTime: '09:00' }));
    assert.deepEqual(loadWorkSchedule(filename), changed);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('corrupted or unknown persisted schedules are rejected without overwriting the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-worktime-'));
  try {
    const filename = join(dir, 'worktime.json');
    for (const invalid of ['{', '{"version":2}', JSON.stringify({ version: 1, schedule: { date: '2026-02-30', startTime: '09:00', endTime: '18:00' } })]) {
      writeFileSync(filename, invalid);
      assert.throws(() => loadWorkSchedule(filename));
      assert.equal(readFileSync(filename, 'utf8'), invalid);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
