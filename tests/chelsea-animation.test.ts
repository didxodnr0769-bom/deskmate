import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompanionState } from '../src/shared/contracts';
import type { PetAnimationState } from '../src/shared/pet-behavior';
import { selectChelseaFrame, traceAlphaSilhouette } from '../src/renderer/characters/chelsea-animation';
import { getCharacterFrame, type CharacterDefinition } from '../src/renderer/character-runtime';
import { insideCharacter } from '../src/renderer/widget-interaction';
import { sanitizeHitRegions } from '../src/main/domain/geometry';

const epoch = 1_800_000_000_000;
function state(activity: PetAnimationState['activity'] = 'idle', overrides: Partial<CompanionState> = {}): CompanionState {
  return { motion: activity === 'walk' ? 'walking' : 'idle', direction: 1, motionStartedAt: epoch,
    pet: { activity, facing: 1, fromFacing: 1, startedAt: epoch, durationMs: 4_000, speed: 30, distance: 0, sampledAt: epoch }, ...overrides } as CompanionState;
}
const hasPoint = (polygons: { x: number; y: number }[][], x: number, y: number) => polygons.some(polygon => insideCharacter({ x, y }, polygon));

function rgba(width: number, height: number, opaque: (x: number, y: number) => boolean): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data[(y * width + x) * 4 + 3] = opaque(x, y) ? 255 : 0;
  return data;
}

test('Chelsea uses separately drawn left/right profiles and advances the gait by traveled distance', () => {
  const right = state('walk');
  assert.deepEqual(selectChelseaFrame(right, epoch), { clip: 'walk-right', row: 2, column: 0 });
  const left = state('walk', { pet: { ...right.pet!, facing: -1 } });
  assert.deepEqual(selectChelseaFrame(left, epoch), { clip: 'walk-left', row: 1, column: 0 });
  assert.equal(selectChelseaFrame(right, epoch + 120).column, 1, 'fresh movement sample is interpolated');
  right.pet!.distance = 14; right.pet!.speed = 0;
  assert.equal(selectChelseaFrame(right, epoch + 60_000).column, 4, 'a stopped gait does not keep stepping');
  assert.equal(selectChelseaFrame(left, epoch + 60_000).column, selectChelseaFrame(left, epoch + 150).column, 'stale samples cannot accumulate unlimited animation');
});

test('held, release, notification and chat thinking override autonomous sleep and walking', () => {
  assert.equal(selectChelseaFrame(state('sleep', { motion: 'dragged' }), epoch + 600).clip, 'held');
  assert.equal(selectChelseaFrame(state('walk', { motion: 'dropping' }), epoch + 60).column, 6);
  assert.equal(selectChelseaFrame(state('sleep', { motion: 'notify' }), epoch + 300).clip, 'alert');
  assert.equal(selectChelseaFrame(state('sleep', { motion: 'notify' }), epoch + 1_200).clip, 'idle');
  assert.equal(selectChelseaFrame(state('sleep', { bubble: { id: 'q', kind: 'chat-loading', requestId: 'q', text: '' } }), epoch + 600).clip, 'thinking');
  assert.equal(selectChelseaFrame(state('sleep', { panelOpen: true }), epoch + 600).clip, 'idle');
  assert.equal(selectChelseaFrame(state('walk', { chatOpen: true }), epoch + 600).clip, 'idle');
});

test('groom and stretch finish their sequences while sleep holds a resting pose', () => {
  for (const activity of ['groom', 'stretch'] as const) {
    assert.equal(selectChelseaFrame(state(activity), epoch).column, 0);
    assert.equal(selectChelseaFrame(state(activity), epoch + 3_999).column, 7);
  }
  assert.equal(selectChelseaFrame(state('sleep'), epoch + 1_600).column, 6);
  assert.equal(selectChelseaFrame(state('sleep'), epoch + 2_400).column, 7);
  assert.equal(selectChelseaFrame(state('sleep'), epoch + 10_000).clip, 'sleep');
});

test('turning visits the front between distinct side profiles and stays within the atlas', () => {
  const turning = state('turn');
  turning.pet!.fromFacing = -1;
  turning.pet!.fromActivity = 'walk';
  assert.equal(selectChelseaFrame(turning, epoch).column, 3);
  assert.equal(selectChelseaFrame(turning, epoch + 2_000).column, 4);
  assert.deepEqual(selectChelseaFrame(turning, epoch + 4_000), { clip: 'turn', row: 2, column: 0 });
  for (const activity of ['idle', 'turn', 'walk', 'groom', 'stretch', 'sleep'] as const) for (const elapsed of [0, 40, 600, 1_400, 5_000, 1e9]) {
    const selection = selectChelseaFrame(state(activity), epoch + elapsed);
    assert.ok(selection.row >= 0 && selection.row < 8);
    assert.ok(selection.column >= 0 && selection.column < 8);
  }
  assert.equal(selectChelseaFrame(state('walk'), epoch + 600, true).column, 0);
});

test('alpha tracing preserves the concave transparent space between a pet’s legs', () => {
  const mask = rgba(24, 24, (x, y) => x >= 3 && x < 21 && y >= 3 && y < 21 && (y < 10 || x < 8 || x >= 16));
  const outline = traceAlphaSilhouette(mask, 24, 24)!;
  assert.deepEqual(outline.bounds, { x: 3, y: 3, width: 18, height: 18 });
  assert.ok(hasPoint(outline.polygons, 12, 5));
  assert.ok(hasPoint(outline.polygons, 5, 18));
  assert.ok(hasPoint(outline.polygons, 18, 18));
  assert.equal(hasPoint(outline.polygons, 12, 18), false);
  assert.equal(hasPoint(outline.polygons, 1, 1), false);
  assert.equal(sanitizeHitRegions(outline.polygons.map(points => ({ type: 'polygon', points }))).length, outline.polygons.length);
});

test('separate opaque components remain clickable and empty or invalid sprite frames are rejected', () => {
  const outline = traceAlphaSilhouette(rgba(30, 20, (x, y) => (x > 2 && x < 13 && y > 2 && y < 17) || (x > 20 && x < 28 && y > 8 && y < 16)), 30, 20)!;
  assert.equal(outline.polygons.length, 2);
  assert.ok(hasPoint(outline.polygons, 5, 5)); assert.ok(hasPoint(outline.polygons, 24, 12));
  assert.equal(hasPoint(outline.polygons, 17, 12), false);
  assert.equal(traceAlphaSilhouette(rgba(8, 8, () => false), 8, 8), null);
  assert.equal(traceAlphaSilhouette(new Uint8ClampedArray(3), 8, 8), null);
});

test('runtime transforms every pose-specific silhouette and uses its HP anchor without changing legacy geometry', () => {
  const character: CharacterDefinition = {
    id: 'geometry-fixture', label: 'fixture', notification: { jumpCount: 0, jumpDurationMs: 0, jumpHeight: 0 },
    hitPolygon: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 0, y: 0 }],
    getPose: () => ({ x: 4, y: -3, rotation: 0, scaleX: -1, scaleY: 1 }),
    getGeometry: () => ({ polygons: [[{ x: -20, y: -30 }, { x: 20, y: -30 }, { x: 20, y: 0 }], [{ x: 40, y: -5 }, { x: 50, y: -5 }, { x: 50, y: 0 }]], hpY: -56 }),
    draw() {},
  };
  const frame = getCharacterFrame(character, state(), epoch);
  assert.equal(frame.polygons.length, 2);
  assert.deepEqual(frame.polygons[0][0], { x: 164, y: 233 });
  assert.deepEqual(frame.polygons[1][0], { x: 104, y: 258 });
  assert.equal(frame.hp.y, 207);
  const legacy = { ...character, getGeometry: undefined };
  assert.deepEqual(getCharacterFrame(legacy, state(), epoch).polygons, [getCharacterFrame(legacy, state(), epoch).polygon]);
  assert.equal(getCharacterFrame(legacy, state(), epoch).hp.y, 168);
});


test('sleep interruptions wake through lying and sitting poses before turning or listening', () => {
  const waking = state('turn');
  Object.assign(waking.pet!, { fromActivity: 'sleep', durationMs: 1_000 });
  assert.deepEqual(selectChelseaFrame(waking, epoch), { clip: 'wake', row: 6, column: 7 });
  assert.equal(selectChelseaFrame(waking, epoch + 400).clip, 'wake');
  assert.equal(selectChelseaFrame(waking, epoch + 550).clip, 'turn');
  assert.deepEqual(selectChelseaFrame(waking, epoch + 1_000), { clip: 'turn', row: 2, column: 0 });
  waking.motion = 'notify';
  assert.equal(selectChelseaFrame(waking, epoch + 400).clip, 'alert', 'notifications interrupt the wake transition');
  assert.equal(selectChelseaFrame(waking, epoch + 600).clip, 'alert');
  waking.motion = 'dragged';
  assert.equal(selectChelseaFrame(waking, epoch + 100).clip, 'held', 'direct manipulation always takes priority');
});


test('turning after a front-facing rest starts from the front even when the previous journey faced the other way', () => {
  const turning = state('turn');
  Object.assign(turning.pet!, { fromActivity: 'groom', fromFacing: -1, facing: 1, durationMs: 420 });
  assert.deepEqual(selectChelseaFrame(turning, epoch), { clip: 'turn', row: 3, column: 4 });
  assert.deepEqual(selectChelseaFrame(turning, epoch + 420), { clip: 'turn', row: 2, column: 0 });
});


test('stopping from either walking profile turns to the front before every rest sequence', () => {
  for (const activity of ['idle', 'groom', 'stretch', 'sleep'] as const) for (const facing of [-1, 1] as const) {
    const stopped = state(activity);
    Object.assign(stopped.pet!, { fromActivity: 'walk', fromFacing: facing, facing });
    const first = selectChelseaFrame(stopped, epoch);
    assert.deepEqual(first, facing < 0 ? { clip: 'turn', row: 3, column: 3 } : { clip: 'turn', row: 2, column: 0 });
    assert.equal(selectChelseaFrame(stopped, epoch + 210).clip, 'turn');
    assert.equal(selectChelseaFrame(stopped, epoch + 419).clip, 'turn');
    const restStart = selectChelseaFrame(stopped, epoch + 420);
    assert.equal(restStart.clip, activity);
    assert.equal(restStart.column, 0);
    if (activity === 'groom' || activity === 'stretch') {
      assert.equal(selectChelseaFrame(stopped, epoch + 3_999).column, 7, 'the rest sequence still reaches its last frame within the original duration');
    }
    if (activity === 'sleep') {
      assert.equal(selectChelseaFrame(stopped, epoch + 1_420).column, 5, 'sleep starts only after facing the front');
    }
  }
});

test('interaction responses bypass a walking-to-rest transition and reduced motion skips the turn', () => {
  const stopped = state('groom');
  stopped.pet!.fromActivity = 'walk';
  assert.equal(selectChelseaFrame(stopped, epoch + 100, true).clip, 'groom');
  stopped.motion = 'dragged'; assert.equal(selectChelseaFrame(stopped, epoch + 100).clip, 'held');
  stopped.motion = 'notify'; assert.equal(selectChelseaFrame(stopped, epoch + 100).clip, 'alert');
  stopped.motion = 'idle'; stopped.bubble = { id: 'q', kind: 'chat-loading', requestId: 'q', text: '' };
  assert.equal(selectChelseaFrame(stopped, epoch + 100).clip, 'thinking');
});
