import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHpAppearance } from '../src/renderer/hp-colors';

test('HP uses the requested five inclusive color bands at every integer percentage', () => {
  const bands = [
    { from: 0, to: 20, color: '#d86c65' },
    { from: 21, to: 40, color: '#d89a58' },
    { from: 41, to: 60, color: '#d5bd5f' },
    { from: 61, to: 80, color: '#a0bb75' },
    { from: 81, to: 100, color: '#4f8255' },
  ];
  for (const band of bands) {
    for (let percent = band.from; percent <= band.to; percent += 1) {
      const appearance = getHpAppearance(percent);
      assert.equal(appearance.percent, percent);
      assert.equal(appearance.color, band.color, `${percent}%`);
    }
  }
});

test('fractional HP selects the band of its displayed floored percentage', () => {
  for (const boundary of [20, 40, 60, 80]) {
    assert.deepEqual(getHpAppearance(boundary + 0.999999), getHpAppearance(boundary));
    assert.notEqual(getHpAppearance(boundary + 1).color, getHpAppearance(boundary).color);
  }
  assert.equal(getHpAppearance(99.999999).percent, 99);
  assert.equal(getHpAppearance(0.999999).percent, 0);
});

test('finite values clamp to the supported range without emitting negative zero', () => {
  for (const value of [-Number.MAX_VALUE, -1, -0.5, -0]) {
    assert.deepEqual(getHpAppearance(value), getHpAppearance(0));
    assert.equal(Object.is(getHpAppearance(value).percent, -0), false);
  }
  for (const value of [100.5, 101, Number.MAX_VALUE]) {
    assert.deepEqual(getHpAppearance(value), getHpAppearance(100));
  }
});

test('non-finite HP safely falls back to zero rather than invalid geometry or a finished state', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.deepEqual(getHpAppearance(value), getHpAppearance(0));
  }
});

test('each band includes a darker matching text color so zero HP still conveys its color', () => {
  const appearances = [0, 21, 41, 61, 81].map(getHpAppearance);
  assert.equal(new Set(appearances.map(({ textColor }) => textColor)).size, 5);
  for (const appearance of appearances) {
    assert.match(appearance.textColor, /^#[0-9a-f]{6}$/);
    assert.notEqual(appearance.textColor, appearance.color);
  }
  assert.equal(appearances[0].textColor, '#9c3f39');
});
