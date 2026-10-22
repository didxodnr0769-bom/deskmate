import type { Rect } from '../../shared/contracts';

export interface SpriteComponent { id: number; area: number; bounds: Rect }
export interface SpriteComponents {
  width: number;
  height: number;
  threshold: number;
  labels: Int32Array;
  frames: SpriteComponent[];
}

/** Find actors independently of uneven generated row spacing and overlapping bounding boxes. */
export function splitSpriteComponents(rgba: Uint8ClampedArray, width: number, height: number,
  columns: number, rows: number, minimumArea = 200, threshold = 48): SpriteComponents | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || !Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1
    || rgba.length !== width * height * 4) return null;
  const labels = new Int32Array(width * height);
  const queue = new Int32Array(width * height);
  const components: SpriteComponent[] = [];
  let id = 0;
  for (let index = 0; index < labels.length; index += 1) {
    if (labels[index] || rgba[index * 4 + 3] < threshold) continue;
    id += 1;
    let read = 0, write = 1;
    queue[0] = index; labels[index] = id;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    const visit = (next: number) => {
      if (!labels[next] && rgba[next * 4 + 3] >= threshold) { labels[next] = id; queue[write++] = next; }
    };
    while (read < write) {
      const current = queue[read++], x = current % width, y = Math.floor(current / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (x > 0) visit(current - 1);
      if (x + 1 < width) visit(current + 1);
      if (y > 0) visit(current - width);
      if (y + 1 < height) visit(current + width);
    }
    if (write >= minimumArea) components.push({ id, area: write, bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } });
  }
  // A missing/merged actor should use the complete code-native fallback, never silently shift every clip.
  if (components.length !== columns * rows) return null;
  components.sort((a, b) => a.bounds.y + a.bounds.height - b.bounds.y - b.bounds.height || a.bounds.x - b.bounds.x);
  const frames: SpriteComponent[] = [];
  for (let start = 0; start < components.length; start += columns) {
    frames.push(...components.slice(start, start + columns).sort((a, b) => a.bounds.x + a.bounds.width / 2 - b.bounds.x - b.bounds.width / 2));
  }
  return { width, height, threshold, labels, frames };
}

/** Copy only one labelled actor, preserving RGBA and its immediate antialiased edge. */
export function extractSpriteComponent(rgba: Uint8ClampedArray, components: SpriteComponents,
  component: SpriteComponent): { rgba: Uint8ClampedArray; width: number; height: number } {
  const { width, height, labels, threshold } = components;
  const x = Math.max(0, component.bounds.x - 1), y = Math.max(0, component.bounds.y - 1);
  const cropWidth = Math.min(width, component.bounds.x + component.bounds.width + 1) - x;
  const cropHeight = Math.min(height, component.bounds.y + component.bounds.height + 1) - y;
  const pixels = new Uint8ClampedArray(cropWidth * cropHeight * 4);
  const actors = new Set(components.frames.map(frame => frame.id));
  const softOwner = (sourceX: number, sourceY: number): number => {
    let owner = 0, closest = 3;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      if ((dx === 0 && dy === 0) || sourceX + dx < 0 || sourceX + dx >= width || sourceY + dy < 0 || sourceY + dy >= height) continue;
      const candidate = labels[(sourceY + dy) * width + sourceX + dx];
      const distance = Math.abs(dx) + Math.abs(dy);
      if (actors.has(candidate) && (distance < closest || (distance === closest && (owner === 0 || candidate < owner)))) {
        owner = candidate; closest = distance;
      }
    }
    return owner;
  };
  for (let row = 0; row < cropHeight; row += 1) for (let column = 0; column < cropWidth; column += 1) {
    const sourceX = x + column, sourceY = y + row, source = sourceY * width + sourceX;
    const alpha = rgba[source * 4 + 3];
    if (alpha === 0 || (alpha >= threshold ? labels[source] !== component.id : softOwner(sourceX, sourceY) !== component.id)) continue;
    pixels.set(rgba.subarray(source * 4, source * 4 + 4), (row * cropWidth + column) * 4);
  }
  return { rgba: pixels, width: cropWidth, height: cropHeight };
}
