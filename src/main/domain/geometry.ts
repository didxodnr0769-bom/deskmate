import type { HitRegion, Point, Rect } from '../../shared/contracts';

type Size = Pick<Rect, 'width' | 'height'>;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/** Electron requires int32 coordinates and rejects JavaScript's negative zero. */
export function nativePosition(point: Point): Point | null {
  const rounded = (value: number): number | null => {
    if (!finite(value)) return null;
    const integer = Math.round(value);
    if (integer < -2_147_483_648 || integer > 2_147_483_647) return null;
    return integer === 0 ? 0 : integer;
  };
  const x = rounded(point.x), y = rounded(point.y);
  return x === null || y === null ? null : { x, y };
}

/** Keep a window inside the usable display area, including displays left of the primary one. */
export function clampBounds(bounds: Rect, workArea: Rect): Rect {
  const width = Math.min(Math.max(0, bounds.width), Math.max(0, workArea.width));
  const height = Math.min(Math.max(0, bounds.height), Math.max(0, workArea.height));
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

export function floorBounds(position: Point, size: Size, workArea: Rect): Rect {
  return clampBounds({
    x: position.x,
    y: workArea.y + workArea.height - size.height,
    ...size,
  }, workArea);
}

/** Prefer the right side of the pet, then the left; short displays also shrink the panel. */
export function panelBounds(widget: Rect, work: Rect, size: Size): Rect {
  const gap = 16;
  const right = widget.x + widget.width + gap;
  const left = widget.x - size.width - gap;
  const x = right + size.width <= work.x + work.width
    ? right
    : left >= work.x ? left : right;
  return clampBounds({ x, y: widget.y + widget.height - size.height, ...size }, work);
}

/** Reflect rather than stopping at a display edge, even after a long suspended frame. */
export function advanceWalk(
  x: number,
  direction: 1 | -1,
  seconds: number,
  speed: number,
  minX: number,
  maxX: number,
): { x: number; direction: 1 | -1 } {
  if (maxX <= minX) return { x: minX, direction: 1 };
  const start = clamp(x, minX, maxX);
  const distance = Math.max(0, seconds) * Math.max(0, speed);
  if (!Number.isFinite(distance)) return { x: start, direction };
  const span = maxX - minX;
  const period = span * 2;
  const phase = ((start - minX + direction * (distance % period)) % period + period) % period;
  if (phase === 0) return { x: minX, direction: 1 };
  if (phase === span) return { x: maxX, direction: -1 };
  return phase < span
    ? { x: minX + phase, direction }
    : { x: minX + period - phase, direction: direction === 1 ? -1 : 1 };
}

function reflectAxis(
  position: number,
  velocity: number,
  seconds: number,
  min: number,
  max: number,
): { position: number; velocity: number } {
  const span = max - min;
  if (span <= 0) return { position: min, velocity: 0 };
  const start = clamp(position, min, max);
  const speed = Number.isFinite(velocity) ? Math.abs(velocity) : 0;
  if (speed === 0) return { position: start, velocity: 0 };
  const direction = velocity < 0 ? -1 : 1;
  const period = span * 2;
  // Reduce time before multiplying: even a finite delta can otherwise overflow distance.
  const cycleSeconds = period / speed;
  const distance = cycleSeconds > 0 ? (seconds % cycleSeconds) * speed : 0;
  const phase = ((start - min + direction * distance) % period + period) % period;
  if (phase === 0) return { position: min, velocity: speed };
  if (phase === span) return { position: max, velocity: -speed };
  return phase < span
    ? { position: min + phase, velocity }
    : { position: min + period - phase, velocity: -velocity };
}

/** Move a window's top-left in DIP at a DIP/second velocity; bounds supplies its size. */
export function advanceRoam(
  position: Point,
  velocity: Point,
  seconds: number,
  bounds: Rect,
  workArea: Rect,
): { position: Point; velocity: Point } {
  const constrained = clampBounds({ ...bounds, ...position }, workArea);
  const elapsed = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const horizontal = reflectAxis(constrained.x, velocity.x, elapsed,
    workArea.x, workArea.x + workArea.width - constrained.width);
  const vertical = reflectAxis(constrained.y, velocity.y, elapsed,
    workArea.y, workArea.y + workArea.height - constrained.height);
  return {
    position: { x: horizontal.position, y: vertical.position },
    velocity: { x: horizontal.velocity, y: vertical.velocity },
  };
}

function isPoint(value: unknown): value is Point {
  return typeof value === 'object' && value !== null
    && finite((value as Point).x) && finite((value as Point).y);
}

function pointOnSegment(point: Point, a: Point, b: Point): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const tolerance = 1e-9;
  const cross = (point.x - a.x) * dy - (point.y - a.y) * dx;
  return Math.abs(cross) <= tolerance * Math.max(1, Math.abs(dx) + Math.abs(dy))
    && point.x >= Math.min(a.x, b.x) - tolerance
    && point.x <= Math.max(a.x, b.x) + tolerance
    && point.y >= Math.min(a.y, b.y) - tolerance
    && point.y <= Math.max(a.y, b.y) + tolerance;
}

function insidePolygon(point: Point, points: Point[]): boolean {
  if (points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j];
    const b = points[i];
    if (pointOnSegment(point, a, b)) return true;
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function hitTest(point: Point, regions: HitRegion[]): boolean {
  if (!isPoint(point)) return false;
  return regions.some((region) => {
    if (region.type === 'polygon') return insidePolygon(point, region.points);
    const rect = region.rect;
    return point.x >= rect.x && point.x <= rect.x + rect.width
      && point.y >= rect.y && point.y <= rect.y + rect.height;
  });
}

/** Copy and bound renderer-provided IPC data before using it in native mouse handling. */
export function sanitizeHitRegions(value: unknown): HitRegion[] {
  if (!Array.isArray(value)) return [];
  const result: HitRegion[] = [];
  // Limit examined entries as well as the output: malformed IPC cannot force a huge scan.
  for (const candidate of value.slice(0, 16)) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    if (candidate.type === 'rect') {
      const rect: unknown = candidate.rect;
      if (!isPoint(rect)) continue;
      const { x, y } = rect;
      const { width, height } = rect as Rect;
      if (!finite(width) || !finite(height) || width <= 0 || height <= 0
        || !finite(x + width) || !finite(y + height)) continue;
      result.push({ type: 'rect', rect: { x, y, width, height } });
    } else if (candidate.type === 'polygon') {
      const points: unknown = candidate.points;
      if (!Array.isArray(points) || points.length < 3 || points.length > 64 || !points.every(isPoint)) continue;
      result.push({ type: 'polygon', points: points.map(({ x, y }) => ({ x, y })) });
    }
  }
  return result;
}
