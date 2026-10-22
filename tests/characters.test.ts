import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompanionState, Motion, Point } from '../src/shared/contracts';
import { hitTest, sanitizeHitRegions } from '../src/main/domain/geometry';
import { cat } from '../src/renderer/characters/cat';
import { rabbit } from '../src/renderer/characters/rabbit';
import { CHARACTER_OPTIONS } from '../src/shared/appearance';
import { BUILT_IN_CHARACTERS, getCharacterDefinition } from '../src/renderer/characters';
import { rock } from '../src/renderer/characters/rock';

const addedCharacters = BUILT_IN_CHARACTERS.filter(character => character.id !== 'rock');
const motions: Motion[] = ['idle', 'walking', 'dragged', 'dropping', 'notify'];
const epoch = 1_800_000_000_000;
const state = (motion: Motion, direction: 1 | -1 = 1) => ({
  motion, direction, motionStartedAt: epoch,
}) as CompanionState;

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function contains(points: readonly Point[], x: number, y: number): boolean {
  return hitTest({ x, y }, [{ type: 'polygon', points: [...points] }]);
}

test('built-in characters have distinct stable IDs and valid, non-crossing click silhouettes', () => {
  assert.equal(new Set([rock, ...addedCharacters].map(character => character.id)).size, 5);
  for (const character of [rock, ...addedCharacters]) {
    const points = character.hitPolygon;
    assert.ok(points.length >= 3 && points.length <= 64, character.id);
    assert.equal(sanitizeHitRegions([{ type: 'polygon', points: [...points] }]).length, 1);
    assert.ok(contains(points, 0, -25), `${character.id} body is clickable`);
    assert.ok(!contains(points, 65, -45), `${character.id} transparent corner passes through`);
    let twiceArea = 0;
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      twiceArea += a.x * b.y - b.x * a.y;
      for (let j = i + 2; j < points.length; j += 1) {
        if ((j + 1) % points.length === i) continue;
        const c = points[j];
        const d = points[(j + 1) % points.length];
        const crosses = cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
        assert.equal(crosses, false, `${character.id} click outline must not cross itself`);
      }
    }
    assert.ok(Math.abs(twiceArea) > 2_000, `${character.id} has a usable click area`);
  }
});

test('ears and tails are clickable while the gap between rabbit ears stays transparent', () => {
  for (const [character, points] of [
    [cat, [[-28, -64], [28, -64], [49, -22]]],
    [rabbit, [[-26, -64], [13, -64], [41, -14]]],
  ] as const) {
    for (const [x, y] of points) assert.ok(contains(character.hitPolygon, x, y), `${character.id}: ${x}, ${y}`);
  }
  assert.equal(contains(rabbit.hitPolygon, -6, -63), false);
});

test('new characters keep a finite silhouette inside the canvas and below HP for every motion and direction', () => {
  for (const character of addedCharacters) {
    for (const motion of motions) {
      for (const direction of [1, -1] as const) {
        for (let elapsed = 0; elapsed <= 5_000; elapsed += 20) {
          const pose = character.getPose(state(motion, direction), epoch + elapsed);
          assert.ok(Object.values(pose).every(Number.isFinite), `${character.id}/${motion}`);
          assert.ok(Math.abs(pose.scaleX) >= 0.9 && Math.abs(pose.scaleX) <= 1.1);
          assert.ok(pose.scaleY >= 0.9 && pose.scaleY <= 1.1);
          assert.equal(Math.sign(pose.scaleX), direction, 'drawing and click polygon mirror together');
          for (const point of character.hitPolygon) {
            const scaledX = point.x * pose.scaleX;
            const scaledY = point.y * pose.scaleY;
            const x = scaledX * Math.cos(pose.rotation) - scaledY * Math.sin(pose.rotation);
            const y = scaledX * Math.sin(pose.rotation) + scaledY * Math.cos(pose.rotation);
            assert.ok(Math.abs(x) < 65 && y >= -76 && y <= 5, `${character.id}/${motion}: ${x}, ${y}`);
            assert.ok(140 + pose.x + x > 0 && 140 + pose.x + x < 280);
            assert.ok(266 + pose.y + y > 0 && 266 + pose.y + y < 300);
          }
        }
      }
    }
  }
});

test('notification jumps finish at the declared duration and dropping settles after 280 ms', () => {
  for (const character of addedCharacters) {
    const duration = character.notification.jumpCount * character.notification.jumpDurationMs;
    assert.ok(character.getPose(state('notify'), epoch + character.notification.jumpDurationMs / 2).y < 0);
    for (const direction of [1, -1] as const) {
      const neutral = { x: 0, y: 0, rotation: 0, scaleX: direction, scaleY: 1 };
      for (const elapsed of [duration, duration + 1, duration + 60_000]) {
        assert.deepEqual(character.getPose(state('notify', direction), epoch + elapsed), neutral);
      }
      const dropped = character.getPose(state('dropping', direction), epoch + 280);
      for (const key of Object.keys(neutral) as (keyof typeof neutral)[]) {
        assert.ok(Math.abs(dropped[key] - neutral[key]) < 1e-12);
      }
    }
  }
});

test('all new character drawing paths remain finite across their five motions', () => {
  let drawCalls = 0;
  const context = new Proxy({}, {
    get(_target, property) {
      if (property === 'createLinearGradient') return (...args: number[]) => {
        assert.ok(args.every(Number.isFinite));
        return { addColorStop() {} };
      };
      return (...args: unknown[]) => {
        drawCalls += 1;
        for (const value of args) if (typeof value === 'number') assert.ok(Number.isFinite(value));
      };
    },
    set() { return true; },
  }) as CanvasRenderingContext2D;
  for (const character of addedCharacters) {
    for (const motion of motions) {
      for (const elapsed of [0, 140, 280, 650, 1_700, 4_800, 5_200]) {
        character.draw(context, state(motion), epoch + elapsed);
      }
    }
  }
  assert.ok(drawCalls > 100);
});


test('every selectable character maps to its own definition and visible label', () => {
  assert.deepEqual(BUILT_IN_CHARACTERS.map(character => ({ id: character.id, label: character.label })), [...CHARACTER_OPTIONS]);
  for (const option of CHARACTER_OPTIONS) assert.equal(getCharacterDefinition(option.id).id, option.id);
});
