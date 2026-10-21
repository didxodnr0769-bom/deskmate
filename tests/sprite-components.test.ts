import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSpriteComponent, splitSpriteComponents } from '../src/renderer/characters/sprite-components';

function bitmap(width: number, height: number) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  return { rgba, pixel(x: number, y: number, alpha = 255, red = 100) {
    rgba.set([red, 80, 70, alpha], (y * width + x) * 4);
  }, rect(x: number, y: number, w: number, h: number) {
    for (let row = y; row < y + h; row += 1) for (let col = x; col < x + w; col += 1) rgba.set([100, 80, 70, 255], (row * width + col) * 4);
  } };
}

test('actors sort by actual feet into unevenly spaced rows, then left to right', () => {
  const { rgba, rect, pixel } = bitmap(70, 90);
  rect(35, 2, 12, 18); rect(2, 6, 12, 13);
  rect(3, 60, 12, 18); rect(40, 48, 12, 29);
  pixel(60, 20); // A detached speck must not become a fifth frame.
  const split = splitSpriteComponents(rgba, 70, 90, 2, 2, 100)!;
  assert.ok(split);
  assert.deepEqual(split.frames.map(frame => frame.bounds.x), [2, 35, 3, 40]);
  assert.deepEqual(split.frames.map(frame => frame.bounds.y + frame.bounds.height), [19, 20, 78, 77]);
});

test('component extraction excludes a neighbouring actor inside overlapping bounding boxes', () => {
  const { rgba, rect } = bitmap(40, 30);
  // A U-shaped body wraps around a separate actor: a rectangle crop alone includes both.
  rect(2, 2, 22, 4); rect(2, 2, 4, 22); rect(20, 2, 4, 22);
  rect(11, 11, 5, 8);
  const split = splitSpriteComponents(rgba, 40, 30, 2, 1, 30)!;
  assert.ok(split);
  const outer = split.frames.find(frame => frame.area > 100)!;
  const extracted = extractSpriteComponent(rgba, split, outer);
  let opaque = 0;
  for (let index = 3; index < extracted.rgba.length; index += 4) if (extracted.rgba[index]) opaque += 1;
  assert.equal(opaque, outer.area, 'only the selected connected actor is copied');
  const inner = split.frames.find(frame => frame.area === 40)!;
  const isolated = extractSpriteComponent(rgba, split, inner);
  assert.equal(isolated.width, 7); assert.equal(isolated.height, 10);
});

test('immediate antialiased RGBA is preserved without copying detached soft noise', () => {
  const { rgba, rect, pixel } = bitmap(20, 20);
  rect(5, 5, 8, 8);
  pixel(4, 8, 30, 170); // One-pixel antialiasing edge next to the actor.
  pixel(3, 8, 30, 200); // Detached soft noise beyond the one-pixel edge.
  const split = splitSpriteComponents(rgba, 20, 20, 1, 1, 30)!;
  const extracted = extractSpriteComponent(rgba, split, split.frames[0]);
  assert.equal(extracted.width, 10); assert.equal(extracted.height, 10);
  assert.deepEqual([...extracted.rgba.subarray((4 * 10) * 4, (4 * 10) * 4 + 4)], [170, 80, 70, 30]);
  let softPixels = 0;
  for (let index = 3; index < extracted.rgba.length; index += 4) if (extracted.rgba[index] === 30) softPixels += 1;
  assert.equal(softPixels, 1);
});

test('missing, merged or malformed sprite actors reject the sheet instead of shifting clip indices', () => {
  const { rgba, rect } = bitmap(30, 20);
  rect(2, 2, 10, 12);
  assert.equal(splitSpriteComponents(rgba, 30, 20, 2, 1, 30), null);
  assert.equal(splitSpriteComponents(new Uint8ClampedArray(3), 30, 20, 1, 1), null);
  assert.equal(splitSpriteComponents(rgba, 30, 20, 0, 1), null);
});
