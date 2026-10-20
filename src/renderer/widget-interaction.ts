import type { Point } from '../shared/contracts';

/** Use the current character silhouette, rather than the transparent canvas bounds. */
export function insideCharacter(point: Point, polygon: Point[]): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || polygon.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[previous], b = polygon[index];
    const dx = b.x - a.x, dy = b.y - a.y;
    const cross = (point.x - a.x) * dy - (point.y - a.y) * dx;
    if (Math.abs(cross) <= 1e-9 * Math.max(1, Math.abs(dx) + Math.abs(dy))
      && point.x >= Math.min(a.x, b.x) - 1e-9 && point.x <= Math.max(a.x, b.x) + 1e-9
      && point.y >= Math.min(a.y, b.y) - 1e-9 && point.y <= Math.max(a.y, b.y) + 1e-9) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
