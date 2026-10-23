import type { CompanionState, Point } from '../../shared/contracts';

// One full, four-beat cycle. Stance moves backwards at exactly 1px per body pixel.
// Day & Jayne (2007), Table 2: domestic-cat fore/hind duty factors about 62% / 59%.
// This is an illustrated kinematic model, not a captured biological dataset.
export const CHELSEA_STRIDE = 56;
export const CHELSEA_CONTACTS = { RH: 0, RF: 0.25, LH: 0.5, LF: 0.75 } as const;
export type ChelseaFoot = keyof typeof CHELSEA_CONTACTS;
export interface ChelseaLeg {
  id: ChelseaFoot; fore: boolean; near: boolean; phase: number; stance: boolean;
  root: Point; joint: Point; ankle: Point; paw: Point;
}
export interface ChelseaGait { distance: number; phase: number; facing: 1 | -1; bodyY: number; bodyRotation: number; legs: ChelseaLeg[] }
export const ease = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const finite = (value: number) => Number.isFinite(value) ? value : 0;

function supportLoad(phase: number, fore: boolean): number {
  const offsets = fore ? [CHELSEA_CONTACTS.RF, CHELSEA_CONTACTS.LF] : [CHELSEA_CONTACTS.RH, CHELSEA_CONTACTS.LH];
  const duty = fore ? 0.62 : 0.60;
  return offsets.reduce<number>((sum, offset) => {
    const p = (phase - offset + 1) % 1;
    return sum + (p < duty ? Math.sin(Math.PI * p / duty) ** 2 : 0);
  }, 0);
}

export function chelseaWalkDistance(state: CompanionState, now: number): number {
  if (state.pet?.activity === 'walk') {
    // The native window has not moved beyond this sample. Extrapolating a paw
    // ahead of that window produces visible sliding, especially at a stop.
    return Math.max(0, finite(state.pet.strideDistance ?? state.pet.distance));
  }
  return Math.max(0, finite(now - state.motionStartedAt)) * 30 / 1000;
}

/** Solve a joint with a fixed bend side, rather than stretching rubber legs. */
function joint(root: Point, end: Point, upper: number, lower: number, bend: number): Point {
  const dx = end.x - root.x, dy = end.y - root.y;
  const d = Math.max(0.001, Math.hypot(dx, dy));
  const along = (upper * upper - lower * lower + d * d) / (2 * d);
  const across = Math.sqrt(Math.max(0, upper * upper - along * along)) * bend;
  return { x: root.x + dx / d * along - dy / d * across, y: root.y + dy / d * along + dx / d * across };
}

export function getChelseaGait(distance: number, facing: 1 | -1 = 1, lift = 1): ChelseaGait {
  distance = Math.max(0, finite(distance));
  const phase = distance / CHELSEA_STRIDE % 1;
  // Small coat/torso compression follows actual support, with continuous
  // loading/unloading. This is an illustration, not a force simulation.
  const shoulderY = 0.9 * (supportLoad(phase, true) - 0.65);
  const pelvisY = 0.9 * (supportLoad(phase, false) - 0.65);
  const bodyY = (shoulderY + pelvisY) / 2;
  const bodyRotation = (shoulderY - pelvisY) / 54 * facing;
  const legs: ChelseaLeg[] = (Object.keys(CHELSEA_CONTACTS) as ChelseaFoot[]).map(id => {
    const fore = id.endsWith('F');
    const near = id.startsWith(facing > 0 ? 'R' : 'L');
    const p = (phase - CHELSEA_CONTACTS[id] + 1) % 1;
    const duty = fore ? 0.62 : 0.60;
    const reach = CHELSEA_STRIDE * duty / 2;
    const stance = p < duty;
    const swing = (p - duty) / (1 - duty);
    // In world coordinates swing is a smoothstep of one whole stride. Its
    // zero endpoint velocities meet the world-fixed stance without a snap.
    const relativeX = stance ? reach - CHELSEA_STRIDE * p
      : -reach + CHELSEA_STRIDE * ease(swing) - CHELSEA_STRIDE * (1 - duty) * swing;
    const y = stance ? 0 : -(fore ? 6.5 : 6) * Math.sin(Math.PI * swing) ** 2 * Math.max(0, Math.min(1, lift));
    const x = fore ? 27 : -27;
    const root = { x: x * facing, y: (fore ? -31 : -30) + bodyY + x * facing * bodyRotation };
    const paw = { x: (x + relativeX) * facing, y };
    const ankle = { x: paw.x - (fore ? 4 : 5) * facing, y: paw.y - (fore ? 8 : 9) };
    return { id, fore, near, phase: p, stance, root,
      joint: joint(root, ankle, 18.5, 20.5, (fore ? 1 : -1) * facing), ankle, paw };
  });
  return { distance, phase, facing, bodyY, bodyRotation, legs };
}

/** After translation ends, small staggered steps gather the paws under the body. */
export function settleChelseaGait(distance: number, facing: 1 | -1, amount: number): ChelseaGait {
  const gait = getChelseaGait(distance, facing, ease(distance / 6));
  const t = Math.max(0, Math.min(1, amount));
  const bodyY = gait.bodyY * (1 - ease(t));
  const bodyRotation = gait.bodyRotation * (1 - ease(t));
  const planted = gait.legs.filter(leg => leg.stance);
  const legs = gait.legs.map(leg => {
    // Land the airborne feet first. Only then replant the supporting feet one
    // at a time, keeping at least two supports throughout the stop.
    const start = leg.stance ? 0.4 + planted.indexOf(leg) * 0.6 / planted.length : 0;
    const duration = leg.stance ? 0.6 / planted.length : 0.4;
    const step = t >= 1 ? 1 : Math.max(0, Math.min(1, (t - start) / duration));
    const x = leg.fore ? (leg.near ? 32 : 27) : (leg.near ? -28 : -20);
    const paw = { x: leg.paw.x + (x * facing - leg.paw.x) * ease(step),
      y: leg.paw.y * (1 - ease(step)) - 5 * Math.sin(Math.PI * step) ** 2 };
    const rootX = (leg.fore ? 27 : -27) * facing;
    const root = { x: rootX, y: (leg.fore ? -31 : -30) + bodyY + rootX * bodyRotation };
    const ankle = { x: paw.x - (leg.fore ? 4 : 5) * facing, y: paw.y - (leg.fore ? 8 : 9) };
    return { ...leg, root, paw, ankle, stance: step === 0 ? leg.stance : step === 1,
      joint: joint(root, ankle, 18.5, 20.5, (leg.fore ? 1 : -1) * facing) };
  });
  return { ...gait, bodyY, bodyRotation, legs };
}
