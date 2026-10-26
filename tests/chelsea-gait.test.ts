import test from 'node:test';
import assert from 'node:assert/strict';
import { CHELSEA_CONTACTS, CHELSEA_STRIDE, chelseaWalkDistance, ease, getChelseaGait, settleChelseaGait } from '../src/renderer/characters/chelsea-gait';
import type { CompanionState } from '../src/shared/contracts';

test('Chelsea has a single RH → RF → LH → LF four-beat cycle with at least two supporting feet', () => {
  assert.deepEqual(Object.keys(CHELSEA_CONTACTS), ['RH', 'RF', 'LH', 'LF']);
  for (let index = 0; index < 1000; index++) {
    const gait = getChelseaGait(index / 1000 * CHELSEA_STRIDE);
    assert.ok(gait.legs.filter(leg => leg.stance).length >= 2);
    for (const leg of gait.legs) {
      if (leg.stance) assert.equal(leg.paw.y, 0);
      else assert.ok(leg.paw.y <= 0, 'toe-off and contact endpoints may touch the ground');
    }
  }
  for (const [id, phase] of Object.entries(CHELSEA_CONTACTS)) {
    assert.equal(getChelseaGait(phase * CHELSEA_STRIDE).legs.find(leg => leg.id === id)!.phase, 0);
    const before = (phase + 1 - 1e-6) % 1 * CHELSEA_STRIDE;
    assert.equal(getChelseaGait(before).legs.find(leg => leg.id === id)!.stance, false);
  }
});

test('planted paws stay fixed in world X throughout support at every direction and display scale', () => {
  for (const facing of [-1, 1] as const) for (const scale of [0.75, 1, 1.25, 1.5]) {
    for (const [id, offset] of Object.entries(CHELSEA_CONTACTS)) {
      let world: number | undefined;
      const duty = id.endsWith('F') ? 0.62 : 0.60;
      // Irregular distance increments also cover acceleration/deceleration, not just constant FPS.
      for (let i = 0; i < 60; i++) {
        const distance = (offset + (i / 60) ** 2 * duty) * CHELSEA_STRIDE;
        const leg = getChelseaGait(distance, facing).legs.find(leg => leg.id === id)!;
        assert.equal(leg.stance, true);
        const position = (facing * distance + leg.paw.x) * scale;
        if (world === undefined) world = position;
        assert.ok(Math.abs(position - world) < 1e-10, `${facing}/${scale}/${id}: planted foot slipped`);
      }
    }
  }
});

test('each foot actually trails, lifts, swings forward and lands without changing segment lengths', () => {
  for (const [id, offset] of Object.entries(CHELSEA_CONTACTS)) {
    const duty = id.endsWith('F') ? 0.62 : 0.60;
    const sample = (phase: number) => getChelseaGait((offset + phase) * CHELSEA_STRIDE).legs.find(leg => leg.id === id)!;
    assert.ok(sample(0).paw.x > sample(duty - 1e-6).paw.x);
    assert.ok(sample(duty + (1 - duty) * 0.5).paw.y < -5.9);
    assert.ok(sample(duty + (1 - duty) * 0.75).paw.x > sample(duty + (1 - duty) * 0.25).paw.x);
    assert.ok(Math.abs(sample(1 - 1e-8).paw.x - sample(0).paw.x) < 1e-5);
    assert.ok(Math.abs(sample(1 - 1e-8).paw.y) < 1e-8);
  }
  for (let i = 0; i < 500; i++) for (const leg of getChelseaGait(i / 500 * CHELSEA_STRIDE).legs) {
    assert.ok(Math.abs(Math.hypot(leg.joint.x - leg.root.x, leg.joint.y - leg.root.y) - 18.5) < 1e-8);
    assert.ok(Math.abs(Math.hypot(leg.ankle.x - leg.joint.x, leg.ankle.y - leg.joint.y) - 20.5) < 1e-8);
  }
});

test('renderer feet use actual traveled distance and never run ahead of a held or stopped native window', () => {
  const state = { motion: 'walking', motionStartedAt: 1000,
    pet: { activity: 'walk', sampledAt: 1000, distance: 12, speed: 40 } } as CompanionState;
  assert.equal(chelseaWalkDistance(state, 1150), 12);
  assert.equal(chelseaWalkDistance(state, 60000), 12);
  state.pet!.speed = 0;
  assert.equal(chelseaWalkDistance(state, 60000), 12);
});

test('shoulder and pelvis response follows alternating supports with continuous, bounded body movement', () => {
  const first = getChelseaGait(0), quarter = getChelseaGait(CHELSEA_STRIDE / 4);
  assert.ok(first.legs.find(l => l.id === 'RF')!.root.y - quarter.legs.find(l => l.id === 'RF')!.root.y > 0.4);
  assert.ok(quarter.legs.find(l => l.id === 'RH')!.root.y - first.legs.find(l => l.id === 'RH')!.root.y > 0.4);
  for (let i = 0; i < 1000; i++) {
    const d = i / 1000 * CHELSEA_STRIDE, a = getChelseaGait(d), b = getChelseaGait(d + 1e-5);
    const mirrored = getChelseaGait(d, -1);
    assert.ok(Math.abs(a.bodyY) < 0.7 && Math.abs(a.bodyRotation) < Math.PI / 180);
    assert.ok(Math.abs(a.bodyY - b.bodyY) < 1e-5 && Math.abs(a.bodyRotation - b.bodyRotation) < 1e-5);
    assert.equal(a.bodyY, mirrored.bodyY); assert.equal(a.bodyRotation, -mirrored.bodyRotation);
  }
});

test('swing world trajectory advances monotonically and meets contact/toe-off with zero velocity', () => {
  for (const [id, offset] of Object.entries(CHELSEA_CONTACTS)) {
    const duty = id.endsWith('F') ? 0.62 : 0.60;
    const world = (q: number) => {
      const d = (offset + duty + (1 - duty) * q) * CHELSEA_STRIDE;
      return d + getChelseaGait(d).legs.find(leg => leg.id === id)!.paw.x;
    };
    const first = world(0), last = world(1 - 1e-12);
    assert.ok(Math.abs(last - first - CHELSEA_STRIDE) < 1e-8);
    let previous = first;
    for (let i = 1; i < 100; i++) { const next = world(i / 100); assert.ok(next >= previous); previous = next; }
    assert.ok(Math.abs(world(1e-5) - first) < 1e-6);
    assert.ok(Math.abs(world(1 - 1e-5) - last) < 1e-6);
  }
});

test('stopping starts at the last walk pose and gathers paws without stretching legs or crossing the floor', () => {
  for (const facing of [-1, 1] as const) for (const distance of [0, 1, 6, 20, 56, 85, 150]) {
    assert.deepEqual(settleChelseaGait(distance, facing, 0), getChelseaGait(distance, facing, ease(distance / 6)));
    for (let i = 0; i <= 100; i++) {
      const pose = settleChelseaGait(distance, facing, i / 100);
      assert.ok(pose.legs.filter(leg => leg.stance).length >= 2, 'stopping must retain at least two support feet');
      for (const leg of pose.legs) {
        assert.ok(leg.paw.y <= 0);
        assert.ok(Math.abs(Math.hypot(leg.joint.x - leg.root.x, leg.joint.y - leg.root.y) - 18.5) < 1e-8);
        assert.ok(Math.abs(Math.hypot(leg.ankle.x - leg.joint.x, leg.ankle.y - leg.joint.y) - 20.5) < 1e-8);
      }
    }
    const settled = settleChelseaGait(distance, facing, 1);
    assert.ok(Math.abs(settled.bodyY) < 1e-10); assert.ok(Math.abs(settled.bodyRotation) < 1e-10);
    assert.ok(settled.legs.every(leg => leg.stance && Math.abs(leg.paw.y) < 1e-10));
  }
});
