import test from 'node:test';
import assert from 'node:assert/strict';
import { bubbleLayout, CHARACTER_SCALES, resizedWidgetBounds, sceneLayout, widgetSize } from '../src/shared/appearance';
import { getCharacterFrame } from '../src/renderer/character-runtime';
import { BUILT_IN_CHARACTERS } from '../src/renderer/characters';
import type { CompanionState } from '../src/shared/contracts';

const work = { x: -1920, y: -1080, width: 3840, height: 2160 };
const feet = (bounds: typeof work, scale: typeof CHARACTER_SCALES[number]) => ({ x: bounds.x + bounds.width / 2,
  y: bounds.y + bounds.height - 34 * sceneLayout(scale, bounds.width, bounds.height).scale });

test('resizing through all supported scales preserves screen-space feet away from display edges', () => {
  for (const oldScale of CHARACTER_SCALES) for (const nextScale of CHARACTER_SCALES) {
    const current = { x: -600, y: -500, ...widgetSize(oldScale) };
    const next = resizedWidgetBounds(current, oldScale, nextScale, work);
    const before = feet(current, oldScale), after = feet(next, nextScale);
    assert.ok(Math.abs(before.x - after.x) <= 0.5); assert.ok(Math.abs(before.y - after.y) <= 0.5);
    assert.deepEqual({ width: next.width, height: next.height }, widgetSize(nextScale));
  }
});

test('large character windows clamp to small displays and negative coordinates without negative zero', () => {
  for (const workArea of [{ x: -500, y: -300, width: 220, height: 250 }, { x: -0, y: -0, width: 420, height: 450 }]) {
    const bounds = resizedWidgetBounds({ x: -1000, y: -1000, width: 280, height: 300 }, 1, 1.5, workArea);
    assert.ok(bounds.x >= workArea.x && bounds.y >= workArea.y);
    assert.ok(bounds.x + bounds.width <= workArea.x + workArea.width);
    assert.ok(bounds.y + bounds.height <= workArea.y + workArea.height);
    assert.equal(Object.is(bounds.x, -0), false); assert.equal(Object.is(bounds.y, -0), false);
    const layout = sceneLayout(1.5, bounds.width, bounds.height);
    assert.ok(layout.left >= 0 && layout.top >= 0);
    assert.ok(layout.width <= bounds.width && layout.height <= bounds.height);
  }
});

test('the longest bubble, HP and every character stay in the window through every motion at every scale', () => {
  const epoch = 1800000000000;
  for (const scale of CHARACTER_SCALES) {
    const size = widgetSize(scale), layout = sceneLayout(scale, size.width, size.height);
    for (const character of BUILT_IN_CHARACTERS) for (const motion of ['idle', 'walking', 'dragged', 'dropping', 'notify'] as const) for (let elapsed = 0; elapsed <= 2000; elapsed += 5) {
      const state = { motion, motionStartedAt: epoch, direction: 1, hp: 70 } as CompanionState;
      const frame = getCharacterFrame(character, state, epoch + elapsed);
      const bubbleBottom = layout.top + (frame.hp.y - 33) * layout.scale;
      assert.ok(bubbleBottom - 114 >= 0, `${scale}/${motion} bubble top`);
      assert.ok(bubbleBottom + 8 < layout.top + (frame.hp.y - 13) * layout.scale, 'bubble tail stays above the HP label');
      for (const p of frame.polygon) {
        assert.ok(layout.left + p.x * layout.scale >= 0 && layout.left + p.x * layout.scale <= size.width);
        assert.ok(layout.top + p.y * layout.scale >= 0 && layout.top + p.y * layout.scale <= size.height);
      }
    }
  }
});


test('a constrained display reserves the bubble heading and scrolls its body instead of clipping above the window', () => {
  for (const character of BUILT_IN_CHARACTERS) for (const scale of CHARACTER_SCALES) for (let elapsed = 0; elapsed <= 1700; elapsed += 5) {
    const layout = sceneLayout(scale, 210, 220);
    const state = { motion: 'notify', motionStartedAt: 0, direction: 1, hp: 70 } as CompanionState;
    const frame = getCharacterFrame(character, state, elapsed);
    const bubble = bubbleLayout(frame.hp.y, layout, 220);
    assert.ok(220 - bubble.bottom - bubble.maxHeight >= 8 - 1e-9);
    assert.ok(bubble.maxHeight >= 60, 'heading and close button keep their space');
    assert.ok(220 - bubble.bottom + 8 < layout.top + (frame.hp.y - 13) * layout.scale);
  }
});
