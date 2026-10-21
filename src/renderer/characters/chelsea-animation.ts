import type { CompanionState, Point, Rect } from '../../shared/contracts';

export const CHELSEA_ATLAS = { columns: 8, rows: 8 } as const;
export type ChelseaClip = 'idle' | 'walk-left' | 'walk-right' | 'turn' | 'groom' | 'stretch' | 'sleep' | 'alert' | 'held' | 'thinking' | 'wake' | 'landing';
export interface ChelseaFrameSelection { clip: ChelseaClip; row: number; column: number }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const elapsedSince = (now: number, startedAt: number) => Math.max(0, finite(now) - finite(startedAt));
const frame = (clip: ChelseaClip, row: number, column: number): ChelseaFrameSelection => ({ clip, row, column: clamp(Math.floor(finite(column)), 0, 7) });

function turnFrame(direction: 1 | -1, amount: number): ChelseaFrameSelection {
  if (direction < 0) return frame('turn', 3, Math.round(amount * 3));
  // The right three-quarter atlas cell contains a left-facing pose, so use the real right profile.
  return amount < 0.3 ? frame('turn', 3, 4) : amount < 0.75 ? frame('turn', 3, 5) : frame('turn', 2, 0);
}

/** Select once from the shared clock/distance so drawing and its click outline agree. */
export function selectChelseaFrame(state: CompanionState, now: number, reducedMotion = false): ChelseaFrameSelection {
  const elapsed = elapsedSince(now, state.motionStartedAt);
  if (state.motion === 'dragged') {
    return frame('held', 7, 4);
  }
  if (state.motion === 'dropping') return elapsed < 280 ? frame('landing', 7, elapsed < 140 ? 6 : 7) : frame('idle', 0, 0);
  const pet = state.pet;
  if (state.motion === 'notify') return elapsed < 1_120
    ? frame('alert', 7, reducedMotion || elapsed < 560 ? 0 : 1) : frame('idle', 0, 0);
  if (state.bubble?.kind === 'chat-loading') {
    return frame('thinking', 7, reducedMotion ? 1 : [1, 2, 1, 3][Math.floor(elapsed / 2_000) % 4]);
  }
  const waking = pet?.fromActivity === 'sleep' && pet.activity !== 'sleep';
  const wakeAge = pet ? elapsedSince(now, pet.startedAt) : 0;
  if (waking && wakeAge < 550) return frame('wake', 6, reducedMotion ? 0 : Math.max(0, 7 - Math.floor(wakeAge / 550 * 8)));
  const restingFromWalk = pet?.fromActivity === 'walk' && state.motion === 'idle'
    && pet.activity !== 'walk' && pet.activity !== 'turn';
  const restOffset = restingFromWalk ? 420 : 0;
  if (restingFromWalk && wakeAge < restOffset && !reducedMotion) {
    return turnFrame(pet.facing, 1 - wakeAge / restOffset);
  }
  // Opening a conversation or management panel should not leave a sleeping/walking pose frozen there.
  if (state.panelOpen || state.chatOpen || state.bubble) return frame('idle', 0, 0);
  if (pet?.activity === 'walk' && state.motion === 'walking') {
    const age = clamp(elapsedSince(now, pet.sampledAt), 0, 150);
    const distance = Math.max(0, finite(pet.distance)) + Math.max(0, finite(pet.speed)) * age / 1_000;
    return frame(pet.facing < 0 ? 'walk-left' : 'walk-right', pet.facing < 0 ? 1 : 2, reducedMotion ? 0 : Math.floor(distance / 28 * 8) % 8);
  }
  if (pet?.activity === 'turn') {
    const offset = waking ? 550 : 0;
    const progress = reducedMotion ? 1 : clamp((elapsedSince(now, pet.startedAt) - offset) / Math.max(1, finite(pet.durationMs, 1) - offset), 0, 1);
    if (pet.fromActivity !== 'walk' || pet.fromFacing === pet.facing) return turnFrame(pet.facing, progress);
    return progress < 0.5
      ? turnFrame(pet.fromFacing, 1 - progress * 2)
      : turnFrame(pet.facing, progress * 2 - 1);
  }
  if (pet && state.motion === 'idle') {
    const age = Math.max(0, elapsedSince(now, pet.startedAt) - restOffset);
    const progress = clamp(age / Math.max(1, finite(pet.durationMs, 1) - restOffset), 0, 1);
    if (pet.activity === 'groom') return frame('groom', 4, reducedMotion ? 3 : Math.min(7, Math.floor(progress * 8)));
    if (pet.activity === 'stretch') return frame('stretch', 5, reducedMotion ? 4 : Math.min(7, Math.floor(progress * 8)));
    if (pet.activity === 'sleep') {
      const column = age < 1_400 ? Math.min(6, Math.floor(age / 200)) : 6 + Math.floor((age - 1_400) / 900) % 2;
      return frame('sleep', 6, reducedMotion ? 7 : column);
    }
  }
  // Preview and legacy snapshots still get a true directional walk.
  if (state.motion === 'walking') return frame(state.direction < 0 ? 'walk-left' : 'walk-right', state.direction < 0 ? 1 : 2, reducedMotion ? 0 : Math.floor(elapsed / 110) % 8);
  const idleAge = Math.max(0, elapsedSince(now, pet?.startedAt ?? state.motionStartedAt) - restOffset) % 4_400;
  return frame('idle', 0, reducedMotion || idleAge < 2_800 ? 0 : Math.floor((idleAge - 2_800) / 200));
}

export interface AlphaSilhouette { bounds: Rect; polygons: Point[][] }
function signedArea(points: Point[]): number {
  return points.reduce((area, a, index) => { const b = points[(index + 1) % points.length]; return area + a.x * b.y - b.x * a.y; }, 0) / 2;
}
function segmentDistanceSquared(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx === 0 && dy === 0 ? 0 : clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return (point.x - a.x - t * dx) ** 2 + (point.y - a.y - t * dy) ** 2;
}
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length < 3) return points;
  let furthest = 0, distance = tolerance ** 2;
  for (let index = 1; index < points.length - 1; index += 1) {
    const next = segmentDistanceSquared(points[index], points[0], points[points.length - 1]);
    if (next > distance) { distance = next; furthest = index; }
  }
  if (!furthest) return [points[0], points[points.length - 1]];
  return [...simplify(points.slice(0, furthest + 1), tolerance).slice(0, -1), ...simplify(points.slice(furthest), tolerance)];
}

/** Trace opaque pixel boundaries, including concave gaps between legs, once at image load. */
export function traceAlphaSilhouette(rgba: Uint8ClampedArray, width: number, height: number, threshold = 48): AlphaSilhouette | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) return null;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && rgba[(y * width + x) * 4 + 3] >= threshold;
  const edges = new Map<string, Point[]>();
  const key = (x: number, y: number) => `${x},${y}`;
  const edge = (x: number, y: number, toX: number, toY: number) => {
    const start = key(x, y), end = { x: toX, y: toY };
    const ends = edges.get(start); if (ends) ends.push(end); else edges.set(start, [end]);
  };
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (!solid(x, y)) continue;
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    if (!solid(x, y - 1)) edge(x, y, x + 1, y);
    if (!solid(x + 1, y)) edge(x + 1, y, x + 1, y + 1);
    if (!solid(x, y + 1)) edge(x + 1, y + 1, x, y + 1);
    if (!solid(x - 1, y)) edge(x, y + 1, x, y);
  }
  if (maxX < minX) return null;
  const loops: Point[][] = [];
  while (edges.size) {
    const startKey = edges.keys().next().value!;
    const [x, y] = startKey.split(',').map(Number);
    let point = { x, y };
    const points: Point[] = [];
    let budget = width * height * 4 + 1;
    do {
      points.push(point);
      const start = key(point.x, point.y), ends = edges.get(start);
      if (!ends?.length) break;
      point = ends.pop()!;
      if (!ends.length) edges.delete(start);
    } while (key(point.x, point.y) !== startKey && --budget > 0);
    // Clockwise outer boundaries have positive area; inner transparent holes are excluded.
    if (points.length >= 3 && signedArea(points) >= 3) loops.push(points);
  }
  const polygons = loops.sort((a, b) => signedArea(b) - signedArea(a)).slice(0, 12).map(loop => {
    const middle = Math.floor(loop.length / 2);
    let tolerance = 0.65, points: Point[];
    do {
      points = [...simplify(loop.slice(0, middle + 1), tolerance).slice(0, -1), ...simplify([...loop.slice(middle), loop[0]], tolerance).slice(0, -1)];
      tolerance *= 1.3;
    } while (points.length > 64);
    return points;
  }).filter(points => points.length >= 3);
  return { bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }, polygons };
}
