import test from 'node:test';
import assert from 'node:assert/strict';
import type { CompanionState } from '../src/shared/contracts';
import type { PetAnimationState } from '../src/shared/pet-behavior';
import { selectChelseaFrame } from '../src/renderer/characters/chelsea-animation';
import { selectChuchuFrame } from '../src/renderer/characters/chuchu-animation';
import { createPetSpriteLoader } from '../src/renderer/characters/pet-sprites';
import { createSpritePetCharacter } from '../src/renderer/characters/sprite-pet';
import { chuchuFallback } from '../src/renderer/characters/chuchu-fallback';
import { getCharacterFrame } from '../src/renderer/character-runtime';

const epoch = 1_800_000_000_000;
const state = (activity: PetAnimationState['activity'] = 'idle', overrides: Partial<CompanionState> = {}) => ({
  motion: activity === 'walk' ? 'walking' : 'idle', motionStartedAt: epoch, direction: 1,
  pet: { activity, facing: 1, fromFacing: 1, startedAt: epoch, durationMs: 4_000, speed: 0, distance: 0, sampledAt: epoch },
  ...overrides,
}) as CompanionState;

test('Chuchu uses real left/right walking frames and its own authored right-turn endpoint', () => {
  const walk = state('walk');
  const rightFrames = new Set<number>();
  for (let frame = 0; frame < 8; frame += 1) {
    walk.pet!.distance = frame * 3.5;
    const selection = selectChuchuFrame(walk, epoch);
    assert.equal(selection.row, 2); rightFrames.add(selection.column);
  }
  assert.equal(rightFrames.size, 8);
  walk.pet!.facing = -1;
  assert.equal(selectChuchuFrame(walk, epoch).row, 1);
  const turning = state('turn');
  turning.pet!.durationMs = 420;
  assert.deepEqual(selectChuchuFrame(turning, epoch + 420), { clip: 'turn', row: 3, column: 7 });
  assert.deepEqual(selectChelseaFrame(turning, epoch + 420), { clip: 'turn', row: 2, column: 0 });
  for (let age = 0; age <= 420; age += 10) assert.notEqual(selectChuchuFrame(turning, epoch + age).column, 6, 'wrongly facing cell is never selected');
});

test('Chuchu keeps wake, rest and direct interaction priorities with reduced-motion support', () => {
  const stopped = state('groom');
  Object.assign(stopped.pet!, { fromActivity: 'walk', facing: -1 });
  assert.equal(selectChuchuFrame(stopped, epoch + 200).clip, 'turn');
  assert.deepEqual(selectChuchuFrame(stopped, epoch + 420), { clip: 'groom', row: 4, column: 0 });
  assert.equal(selectChuchuFrame(stopped, epoch + 3_999).column, 7);
  const waking = state('turn');
  Object.assign(waking.pet!, { fromActivity: 'sleep', durationMs: 1_000 });
  assert.equal(selectChuchuFrame(waking, epoch + 300).clip, 'wake');
  assert.deepEqual(selectChuchuFrame(waking, epoch + 1_000), { clip: 'turn', row: 3, column: 7 });
  waking.motion = 'dragged'; assert.equal(selectChuchuFrame(waking, epoch + 100).clip, 'held');
  waking.motion = 'notify'; assert.equal(selectChuchuFrame(waking, epoch + 100).clip, 'alert');
  waking.motion = 'idle'; waking.bubble = { id: 'q', kind: 'chat-loading', requestId: 'q', text: '' };
  assert.equal(selectChuchuFrame(waking, epoch + 2_100).clip, 'thinking');
  const walk = state('walk'); walk.pet!.distance = 100;
  assert.equal(selectChuchuFrame(walk, epoch, true).column, 0);
});

function atlas(red: number, count = 64): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(256 * 256 * 4);
  for (let frame = 0; frame < count; frame += 1) {
    const left = frame % 8 * 32 + 6, top = Math.floor(frame / 8) * 32 + 6;
    for (let y = top; y < top + 20; y += 1) for (let x = left; x < left + 20; x += 1) {
      rgba.set([red, 100, 90, 255], (y * 256 + x) * 4);
    }
  }
  return rgba;
}

async function withBrowser(run: (loads: Map<string, number>) => Promise<void>) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const keys = ['Image', 'ImageData', 'document', 'window'];
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const loads = new Map<string, number>();
  class FakeImage {
    naturalWidth = 256; naturalHeight = 256;
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    decoding = ''; private source = '';
    get src() { return this.source; }
    set src(value: string) {
      this.source = value; loads.set(value, (loads.get(value) ?? 0) + 1);
      queueMicrotask(() => value.includes('missing') ? this.onerror?.() : this.onload?.());
    }
  }
  class FakeCanvas {
    width = 0; height = 0; pixels: Uint8ClampedArray | null = null;
    private original: FakeImage | null = null;
    getContext() {
      return {
        drawImage: (image: FakeImage) => { this.original = image; },
        getImageData: () => ({ data: atlas(this.original?.src.includes('dog') ? 210 : 50, this.original?.src.includes('broken') ? 63 : 64) }),
        putImageData: (image: { data: Uint8ClampedArray }) => { this.pixels = image.data; },
      };
    }
  }
  globals.Image = FakeImage;
  globals.ImageData = class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} };
  globals.document = { createElement: () => new FakeCanvas() };
  globals.window = { matchMedia: () => ({ matches: false }) };
  try { await run(loads); }
  finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('pet sprite preparation and cached frames stay independent across two character assets', async () => withBrowser(async loads => {
  const cat = createPetSpriteLoader('file:///cat.png', selectChelseaFrame);
  const dog = createPetSpriteLoader('file:///dog.png', selectChuchuFrame);
  const pending = cat.prepare(); assert.equal(cat.prepare(), pending);
  await pending;
  const catFrame = cat.getFrame(state(), epoch)!;
  assert.ok(catFrame);
  assert.equal(dog.getFrame(state(), epoch), null, 'loading another pet never reuses the already loaded cat');
  await dog.prepare();
  const dogFrame = dog.getFrame(state(), epoch)!;
  assert.ok(dogFrame);
  assert.notEqual(catFrame.image, dogFrame.image);
  const colored = (image: HTMLCanvasElement) => [...(image as unknown as { pixels: Uint8ClampedArray }).pixels].filter((_n, index) => index % 4 === 0 && (image as unknown as { pixels: Uint8ClampedArray }).pixels[index + 3] > 0);
  assert.ok(colored(catFrame.image).every(red => red === 50));
  assert.ok(colored(dogFrame.image).every(red => red === 210));
  assert.equal(loads.get('file:///cat.png'), 1); assert.equal(loads.get('file:///dog.png'), 1);
  assert.equal(cat.getFrame(state(), epoch)!.image, catFrame.image);
}));

test('a failed or incomplete sprite keeps its dog fallback without affecting a different loaded pet', async () => withBrowser(async loads => {
  const good = createPetSpriteLoader('file:///cat.png', selectChelseaFrame);
  for (const url of ['file:///missing-dog.png', 'file:///broken-dog.png']) {
    const failed = createPetSpriteLoader(url, selectChuchuFrame);
    await Promise.all([good.prepare(), failed.prepare()]);
    assert.ok(good.getFrame(state(), epoch)); assert.equal(failed.getFrame(state(), epoch), null);
    let fallbackDraws = 0;
    const fallback = { ...chuchuFallback, draw() { fallbackDraws += 1; } };
    const dog = createSpritePetCharacter('chuchu', '츄츄', fallback, failed);
    dog.draw({} as CanvasRenderingContext2D, state(), epoch);
    assert.equal(fallbackDraws, 1); assert.equal(dog.label, '츄츄');
    assert.deepEqual(dog.getPose(state(), epoch), chuchuFallback.getPose(state(), epoch));
    assert.deepEqual(dog.getGeometry!(state(), epoch).polygons, [chuchuFallback.hitPolygon]);
    assert.equal(loads.get(url), 1, 'failed image decoding is not retried on every render frame');
  }
}));

test('loaded pet drawing and pose-aware geometry select the same frame with a planted mirrored-direction origin', async () => withBrowser(async () => {
  const sprites = createPetSpriteLoader('file:///dog.png', selectChuchuFrame);
  await sprites.prepare();
  const dog = createSpritePetCharacter('chuchu', '츄츄', chuchuFallback, sprites);
  const walking = state('walk');
  walking.direction = -1; walking.pet!.facing = -1; walking.pet!.distance = 10.5;
  const selected = sprites.getFrame(walking, epoch)!;
  const pose = dog.getPose(walking, epoch);
  assert.deepEqual(pose, { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, 'an authored left view must not be mirrored again');
  const frame = getCharacterFrame(dog, walking, epoch);
  assert.deepEqual(frame.origin, { x: 140, y: 266 });
  assert.ok(frame.polygons.length > 0);
  assert.equal(frame.hp.y, 266 + selected.top - 26);
  let drawn: unknown[] | null = null;
  dog.draw({ drawImage(...args: unknown[]) { drawn = args; } } as CanvasRenderingContext2D, walking, epoch);
  assert.equal(drawn![0], selected.image);
  assert.deepEqual(drawn!.slice(1, 5), [selected.source.x, selected.source.y, selected.source.width, selected.source.height]);
  assert.equal(selected.selection.row, 1); assert.equal(selected.selection.column, 3);
}));
