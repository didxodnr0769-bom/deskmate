import test from 'node:test';
import assert from 'node:assert/strict';
import { PetBehavior, type PetActivity } from '../src/shared/pet-behavior';
import type { Point, Rect } from '../src/shared/contracts';

const epoch = 1_800_000_000_000;
const workArea: Rect = { x: -1_000, y: -500, width: 2_000, height: 1_200 };

function setup(options: { scale?: number; position?: Point; work?: Rect; bounds?: Rect; random?: () => number } = {}) {
  let now = epoch;
  let position = options.position ?? { x: -300, y: -100 };
  const pet = new PetBehavior(now, 1, options.random ?? (() => 0.8));
  const step = (milliseconds = 50, allowMovement = true) => {
    now += milliseconds;
    const result = pet.advance({ now, seconds: milliseconds / 1_000, position,
      bounds: options.bounds ?? { ...position, width: 280, height: 300 },
      workArea: options.work ?? workArea, scale: options.scale ?? 1, allowMovement });
    position = result.position;
    return result;
  };
  return { pet, step, position: () => ({ ...position }), now: () => now };
}

function until(h: ReturnType<typeof setup>, activity: PetActivity, limit = 1_000) {
  for (let i = 0; i < limit; i += 1) {
    const result = h.step();
    if (result.animation.activity === activity) return result;
  }
  assert.fail(`pet never entered ${activity}`);
}

test('a pet turns at its current height before beginning an eased two-axis walk', () => {
  const h = setup();
  const initial = h.position();
  const turning = until(h, 'turn');
  assert.deepEqual(turning.position, initial, 'turning must not translate the native window');
  const walking = until(h, 'walk');
  assert.deepEqual(walking.position, initial, 'walk starts at the original foot position');
  const samples: { speed: number; position: Point }[] = [];
  while (h.pet.animation.activity === 'walk') {
    const next = h.step();
    if (next.animation.activity === 'walk') samples.push({ speed: next.animation.speed, position: next.position });
  }
  assert.ok(samples.length > 20);
  const middle = samples[Math.floor(samples.length / 2)].speed;
  assert.ok(middle > samples[0].speed * 10, 'gait accelerates from rest');
  assert.ok(middle > samples.at(-1)!.speed * 5, 'gait slows before reaching its target');
  assert.ok(middle <= 40.01, 'walking never exceeds the planned logical peak speed');
  assert.ok(h.position().x > initial.x && h.position().y > initial.y, 'free X/Y motion is retained');
  assert.ok(Math.hypot(h.position().x - initial.x, h.position().y - initial.y) < 220);
  assert.equal(h.pet.animation.speed, 0, 'the stopped pet cannot keep extrapolating foot steps');
});

test('gait distance follows actual travel and stays consistent across character sizes', () => {
  const distances: number[] = [];
  for (const scale of [0.75, 1, 1.25, 1.5]) {
    const h = setup({ scale });
    until(h, 'walk');
    const start = h.position();
    let previousDistance = 0;
    for (let i = 0; i < 30; i += 1) {
      const next = h.step();
      assert.equal(next.animation.sampledAt, h.now());
      const actual = Math.hypot(next.position.x - start.x, next.position.y - start.y) / scale;
      assert.ok(Math.abs(next.animation.distance - actual) < 1e-8);
      assert.ok(Math.abs(next.animation.strideDistance! - Math.abs(next.position.x - start.x) / scale) < 1e-8,
        'profile gait follows horizontal movement even on a diagonal journey');
      assert.ok(next.animation.distance >= previousDistance);
      previousDistance = next.animation.distance;
    }
    distances.push(previousDistance);
  }
  assert.ok(distances.every(distance => Math.abs(distance - distances[0]) < 1e-8));
});

test('resting behaviours include grooming, stretching and sleeping without spontaneous sounds or bubbles', () => {
  const h = setup();
  const observed = new Set<PetActivity>();
  for (let i = 0; i < 6_000 && observed.size < 6; i += 1) {
    const next = h.step();
    observed.add(next.animation.activity);
    assert.ok(Object.values(next.animation).every(value => typeof value !== 'number' || Number.isFinite(value)));
  }
  assert.deepEqual([...observed].sort(), ['groom', 'idle', 'sleep', 'stretch', 'turn', 'walk']);
});

test('disabling travel leaves the pet at the chosen location while quiet resting animations continue', () => {
  const h = setup();
  until(h, 'walk');
  h.step();
  const parked = h.position();
  const observed = new Set<PetActivity>();
  for (let i = 0; i < 1_500; i += 1) {
    const next = h.step(50, false);
    observed.add(next.animation.activity);
    assert.deepEqual(next.position, parked);
    assert.equal(next.animation.speed, 0);
    assert.ok(next.animation.activity !== 'walk' && next.animation.activity !== 'turn');
  }
  assert.ok(observed.has('groom') && observed.has('stretch') && observed.has('sleep'));
});

test('a pet at a side boundary turns away before moving and remains inside its work area', () => {
  const work = { x: -900, y: -100, width: 1_000, height: 800 };
  const h = setup({ position: { x: -180, y: 100 }, work });
  const turning = until(h, 'turn');
  assert.equal(turning.animation.facing, -1);
  assert.equal(turning.animation.fromFacing, 1);
  for (let i = 0; i < 2_500; i += 1) {
    const { position } = h.step();
    assert.ok(position.x >= work.x && position.x <= work.x + work.width - 280);
    assert.ok(position.y >= work.y && position.y <= work.y + work.height - 300);
  }
});

test('cramped screens lock unavailable axes and do not spin forever trying to walk', () => {
  const work = { x: -200, y: -40, width: 210, height: 220 };
  const h = setup({ position: { x: -200, y: -40 }, work, bounds: { x: -200, y: -40, width: 210, height: 220 } });
  const initial = h.position();
  const observed = new Set<PetActivity>();
  for (let i = 0; i < 1_000; i += 1) {
    const next = h.step();
    assert.deepEqual(next.position, initial);
    assert.ok(next.animation.speed === 0);
    observed.add(next.animation.activity);
  }
  assert.ok(!observed.has('walk') && !observed.has('turn'));
  assert.ok(observed.has('groom'));
});

test('suspend, backward clock adjustment and explicit interruption discard an old destination', () => {
  for (const interruption of ['suspend', 'clock', 'reset']) {
    const h = setup();
    until(h, 'walk'); h.step();
    const before = h.position();
    if (interruption === 'reset') h.pet.reset(h.now());
    const next = h.step(interruption === 'suspend' ? 60_000 : interruption === 'clock' ? -10_000 : 50);
    assert.deepEqual(next.position, before, interruption);
    assert.equal(next.animation.activity, 'idle');
    assert.equal(next.animation.distance, 0);
    assert.equal(next.animation.speed, 0);
    assert.ok(next.transitioned || interruption === 'reset');
  }
});


test('waking from sleep reverses the resting pose before turning and starts the walk only after that transition', () => {
  const h = setup();
  assert.equal(h.pet.animation.fromActivity, undefined, 'the initial idle has no preceding activity');
  until(h, 'sleep', 6_000);
  const turning = until(h, 'turn');
  assert.equal(turning.animation.fromActivity, 'sleep');
  assert.equal(turning.animation.durationMs, 1_000);
  const sleepingPosition = h.position();
  for (let i = 0; i < 19; i += 1) {
    const next = h.step(50);
    assert.equal(next.animation.activity, 'turn');
    assert.deepEqual(next.position, sleepingPosition, 'waking and turning happen before native travel');
    assert.equal(next.animation.speed, 0);
  }
  const walking = h.step(50);
  assert.equal(walking.animation.activity, 'walk');
  assert.equal(walking.animation.fromActivity, 'turn');
  assert.deepEqual(walking.position, sleepingPosition);
  const firstStep = h.step(50);
  assert.notDeepEqual(firstStep.position, sleepingPosition);
});
