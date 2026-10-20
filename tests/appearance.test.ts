import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppearanceService } from '../src/main/features/appearance';

function fixture(run: (filename: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'deskmate-appearance-'));
  try { run(join(directory, 'appearance.json')); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('appearance defaults without a write and persists the chosen scale with private file permissions', () => fixture(filename => {
  const service = new AppearanceService(filename);
  assert.deepEqual(service.settings, { scale: 1 }); assert.equal(existsSync(filename), false);
  service.configure({ scale: 1.5 });
  assert.deepEqual(new AppearanceService(filename).settings, { scale: 1.5 });
  assert.equal(statSync(filename).mode & 0o777, 0o600);
  const copy = service.settings; copy.scale = 0.75; assert.equal(service.settings.scale, 1.5);
}));

test('invalid scale and additional execution fields never change stored appearance', () => fixture(filename => {
  const service = new AppearanceService(filename); service.configure({ scale: 1.25 });
  const before = readFileSync(filename, 'utf8');
  for (const value of [null, [], { scale: 0 }, { scale: 2 }, { scale: NaN }, { scale: Infinity }, { scale: '1' }, { scale: 1, executable: 'anything' }]) {
    assert.throws(() => service.configure(value));
    assert.equal(readFileSync(filename, 'utf8'), before); assert.equal(service.settings.scale, 1.25);
  }
}));

test('unsupported, malformed and oversized preference files preserve their original bytes', () => fixture(filename => {
  for (const original of ['{broken', JSON.stringify({ version: 9, settings: { scale: 1 } }), JSON.stringify({ version: 1, settings: { scale: -1 } }), ' '.repeat(4097)]) {
    writeFileSync(filename, original); assert.throws(() => new AppearanceService(filename));
    assert.equal(readFileSync(filename, 'utf8'), original);
  }
}));

test('failed preference replacement preserves memory and removes only its temporary file before a retry', () => fixture(filename => {
  const service = new AppearanceService(filename); mkdirSync(filename);
  assert.throws(() => service.configure({ scale: 1.5 }));
  assert.deepEqual(service.settings, { scale: 1 }); assert.deepEqual(readdirSync(filename), []);
  assert.equal(readdirSync(join(filename, '..')).length, 1);
  rmSync(filename, { recursive: true }); service.configure({ scale: 1.5 });
  assert.deepEqual(new AppearanceService(filename).settings, { scale: 1.5 });
}));
