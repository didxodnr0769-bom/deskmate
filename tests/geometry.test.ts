import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceRoam, advanceWalk, clampBounds, floorBounds, hitTest, nativePosition, panelBounds, sanitizeHitRegions } from '../src/main/domain/geometry';
import type { HitRegion } from '../src/shared/contracts';

test('native positions normalize negative zero from a fractional drag across the screen origin', () => {
  const rawY = 100 + (100 - 200.5);
  assert.ok(Object.is(Math.round(rawY), -0));
  const point = nativePosition({ x: -0.1, y: rawY });
  assert.deepEqual(point, { x: 0, y: 0 });
  assert.equal(Object.is(point?.x, -0), false);
  assert.equal(Object.is(point?.y, -0), false);
  assert.deepEqual(nativePosition({ x: -1920.4, y: -30.6 }), { x: -1920, y: -31 });
});

test('native positions reject non-finite values and integer overflow instead of calling Electron', () => {
  for (const invalid of [NaN, Infinity, -Infinity, 2_147_483_648, -2_147_483_649]) {
    assert.equal(nativePosition({ x: invalid, y: 1 }), null);
    assert.equal(nativePosition({ x: 1, y: invalid }), null);
  }
  assert.deepEqual(nativePosition({ x: -2_147_483_648, y: 2_147_483_647 }), { x: -2_147_483_648, y: 2_147_483_647 });
});

test('floor positioning respects the negative origin of a left-hand display', () => {
  const work = { x: -1920, y: 25, width: 1920, height: 1055 };
  assert.deepEqual(floorBounds({ x: -2100, y: -500 }, { width: 280, height: 300 }, work), {
    x: -1920, y: 780, width: 280, height: 300,
  });
  assert.deepEqual(floorBounds({ x: -100, y: 100 }, { width: 280, height: 300 }, work), {
    x: -280, y: 780, width: 280, height: 300,
  });
});

test('small screens constrain the whole window instead of creating an invalid clamp interval', () => {
  const work = { x: -200, y: 40, width: 160, height: 200 };
  assert.deepEqual(floorBounds({ x: 500, y: 500 }, { width: 280, height: 300 }, work), work);
  assert.deepEqual(clampBounds({ x: -300, y: -30, width: 90, height: 80 }, work), {
    x: -200, y: 40, width: 90, height: 80,
  });
});

test('panel placement prefers right, falls back to left, then clamps to available screen', () => {
  const work = { x: 0, y: 0, width: 1200, height: 900 };
  const size = { width: 360, height: 580 };
  assert.deepEqual(panelBounds({ x: 100, y: 600, width: 280, height: 300 }, work, size), {
    x: 396, y: 320, ...size,
  });
  assert.deepEqual(panelBounds({ x: 900, y: 600, width: 280, height: 300 }, work, size), {
    x: 524, y: 320, ...size,
  });
  assert.deepEqual(panelBounds({ x: 100, y: 180, width: 280, height: 300 }, {
    x: 0, y: 0, width: 480, height: 480,
  }, size), { x: 120, y: 0, width: 360, height: 480 });
});

test('walking reflects at either edge and reports the next inward direction', () => {
  assert.deepEqual(advanceWalk(90, 1, 2, 10, 0, 100), { x: 90, direction: -1 });
  assert.deepEqual(advanceWalk(10, -1, 2, 10, 0, 100), { x: 10, direction: 1 });
  assert.deepEqual(advanceWalk(90, 1, 1, 10, 0, 100), { x: 100, direction: -1 });
  assert.deepEqual(advanceWalk(10, -1, 1, 10, 0, 100), { x: 0, direction: 1 });
});

test('walking handles a suspended-frame delta without a per-bounce loop', () => {
  assert.deepEqual(advanceWalk(-1900, 1, 7_000_000_013, 40, -1920, -1640), {
    x: -1900, direction: -1,
  });
  assert.deepEqual(advanceWalk(12, -1, 500, 100, 12, 12), { x: 12, direction: 1 });
});

test('roaming advances both axes with fractional positions and signed velocities', () => {
  assert.deepEqual(advanceRoam({ x: 100.25, y: 200.5 }, { x: 25, y: -12.5 }, 0.5,
    { x: 100, y: 200, width: 100, height: 150 }, { x: 0, y: 0, width: 1000, height: 800 }), {
    position: { x: 112.75, y: 194.25 }, velocity: { x: 25, y: -12.5 },
  });
});

test('roaming reflects independently at right and bottom, including exact corner contact', () => {
  const bounds = { x: 880, y: 680, width: 100, height: 100 };
  const work = { x: 0, y: 0, width: 1000, height: 800 };
  assert.deepEqual(advanceRoam({ x: 880, y: 680 }, { x: 20, y: 20 }, 1, bounds, work), {
    position: { x: 900, y: 700 }, velocity: { x: -20, y: -20 },
  });
  assert.deepEqual(advanceRoam({ x: 880, y: 680 }, { x: 40, y: 30 }, 1, bounds, work), {
    position: { x: 880, y: 690 }, velocity: { x: -40, y: -30 },
  });
});

test('roaming reflects at the left and top of a display with a negative origin', () => {
  assert.deepEqual(advanceRoam({ x: -1910, y: -190 }, { x: -30, y: -20 }, 1,
    { x: -1910, y: -190, width: 280, height: 300 },
    { x: -1920, y: -200, width: 1920, height: 1080 }), {
    position: { x: -1900, y: -190 }, velocity: { x: 30, y: 20 },
  });
});

test('a small display locks only the axes without room to move', () => {
  const bounds = { x: -500, y: -500, width: 280, height: 300 };
  assert.deepEqual(advanceRoam({ x: -500, y: -500 }, { x: -40, y: 20 }, 2, bounds,
    { x: -200, y: 40, width: 160, height: 500 }), {
    position: { x: -200, y: 80 }, velocity: { x: 0, y: 20 },
  });
  assert.deepEqual(advanceRoam({ x: -500, y: -500 }, { x: -40, y: 20 }, 2, bounds,
    { x: -200, y: 40, width: 160, height: 200 }), {
    position: { x: -200, y: 40 }, velocity: { x: 0, y: 0 },
  });
});

test('roaming handles many bounces and overflow-sized deltas without loops or NaN', () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  const work = { x: -100, y: -200, width: 300, height: 300 };
  assert.deepEqual(advanceRoam({ x: -50, y: -150 }, { x: 40, y: -40 }, 10_000_000_003,
    bounds, work), {
    position: { x: 70, y: -130 }, velocity: { x: 40, y: 40 },
  });
  const huge = advanceRoam({ x: -50, y: -150 }, { x: 40, y: -40 }, Number.MAX_VALUE,
    bounds, work);
  assert.ok(Number.isFinite(huge.position.x) && Number.isFinite(huge.position.y));
  assert.ok(huge.position.x >= -100 && huge.position.x <= 100);
  assert.ok(huge.position.y >= -200 && huge.position.y <= 0);
  assert.equal(Math.abs(huge.velocity.x), 40);
  assert.equal(Math.abs(huge.velocity.y), 40);
});

test('polygon hit regions leave transparent corners clickable through to other apps', () => {
  const regions: HitRegion[] = [{ type: 'polygon', points: [
    { x: 0, y: 100 }, { x: 50, y: 0 }, { x: 100, y: 100 },
  ] }];
  assert.equal(hitTest({ x: 5, y: 5 }, regions), false);
  assert.equal(hitTest({ x: 50, y: 60 }, regions), true);
  assert.equal(hitTest({ x: 25, y: 50 }, regions), true);
  assert.equal(hitTest({ x: 50, y: 0 }, regions), true);
  assert.equal(hitTest({ x: 100, y: 100 }, regions), true);
});

test('rectangles include boundary pixels and reject non-finite pointer coordinates', () => {
  const regions: HitRegion[] = [{ type: 'rect', rect: { x: 10, y: 20, width: 100, height: 40 } }];
  assert.equal(hitTest({ x: 110, y: 60 }, regions), true);
  assert.equal(hitTest({ x: 110.1, y: 60 }, regions), false);
  assert.equal(hitTest({ x: Number.NaN, y: 30 }, regions), false);
});

test('IPC hit region validation drops malformed, non-finite and over-sized data', () => {
  const rect = { type: 'rect', rect: { x: -5, y: 0, width: 12, height: 15 } };
  const triangle = { type: 'polygon', points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 30 }] };
  assert.deepEqual(sanitizeHitRegions([
    null, {}, rect,
    { type: 'rect', rect: { x: NaN, y: 0, width: 1, height: 1 } },
    { type: 'rect', rect: { x: 0, y: 0, width: Infinity, height: 1 } },
    { type: 'rect', rect: { x: 0, y: 0, width: -1, height: 1 } },
    { type: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] },
    { type: 'polygon', points: Array.from({ length: 65 }, () => ({ x: 0, y: 0 })) },
    { type: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: Infinity }] },
    triangle,
  ]), [rect, triangle]);
  assert.deepEqual(sanitizeHitRegions({ regions: [rect] }), []);
  assert.equal(sanitizeHitRegions(Array.from({ length: 10_000 }, () => rect)).length, 16);
});

test('validated regions are detached from the renderer payload', () => {
  const payload = [{ type: 'polygon', points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 30 }] }];
  const result = sanitizeHitRegions(payload);
  payload[0].points[0].x = 99;
  assert.equal(result[0].type === 'polygon' && result[0].points[0].x, 0);
});
