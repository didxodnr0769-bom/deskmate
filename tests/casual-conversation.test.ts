import test from 'node:test';
import assert from 'node:assert/strict';
import { CasualConversation, CASUAL_LINES } from '../src/main/domain/casual-conversation';

const minute = 60_000;
function run(clock: CasualConversation, from: number, minutes: number, allowed = true) {
  const lines: string[] = [];
  for (let i = 1; i <= minutes; i++) {
    const line = clock.poll(from + i * minute, allowed);
    if (line) lines.push(line);
  }
  return lines;
}

test('local casual lines have a long initial delay, a fresh cooldown and no consecutive repeat', () => {
  const now = new Date(2026, 9, 20, 10).getTime();
  const clock = new CasualConversation(now, () => 0);
  assert.deepEqual(run(clock, now, 29), []);
  const first = clock.poll(now + 30 * minute, true)!;
  assert.ok(CASUAL_LINES.includes(first as typeof CASUAL_LINES[number]));
  assert.deepEqual(run(clock, now + 30 * minute, 29), []);
  assert.notEqual(clock.poll(now + 60 * minute, true), first);
});

test('busy periods and quiet hours defer without queuing catch-up conversations', () => {
  const now = new Date(2026, 9, 20, 21, 30).getTime();
  const clock = new CasualConversation(now, () => 0);
  assert.deepEqual(run(clock, now, 629, true), []);
  const morning = now + 629 * minute;
  assert.deepEqual(run(clock, morning, 30, false), []);
  assert.equal(run(clock, morning + 30 * minute, 5).length, 1);
});

test('sleep gaps, explicit resume reset and backwards clock changes start a fresh interval', () => {
  const now = new Date(2026, 9, 20, 10).getTime();
  const clock = new CasualConversation(now, () => 0);
  assert.equal(clock.poll(now + 2 * 60 * minute, true), null);
  assert.deepEqual(run(clock, now + 2 * 60 * minute, 29), []);
  assert.ok(clock.poll(now + 150 * minute, true));
  assert.equal(clock.poll(now, true), null);
  assert.deepEqual(run(clock, now, 29), []);
  clock.reset(now + 29 * minute);
  assert.deepEqual(run(clock, now + 29 * minute, 29), []);
});
