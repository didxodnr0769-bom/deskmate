import { WIDGET_SIZE, type Rect } from './contracts';

export const CHARACTER_SCALES = [0.75, 1, 1.25, 1.5] as const;
export type CharacterScale = typeof CHARACTER_SCALES[number];
export interface AppearanceSettings { scale: CharacterScale }
export const DEFAULT_APPEARANCE: AppearanceSettings = { scale: 1 };

export function validAppearanceSettings(value: unknown): value is AppearanceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return Object.keys(data).length === 1 && CHARACTER_SCALES.some(scale => scale === data.scale);
}

export function widgetSize(scale: CharacterScale) {
  return { width: Math.max(WIDGET_SIZE.width, Math.round(WIDGET_SIZE.width * scale)),
    height: Math.max(WIDGET_SIZE.height, Math.round(WIDGET_SIZE.height * scale)) };
}

/** Fit the scene into a constrained native window, centered with its feet near the bottom. */
export function sceneLayout(scale: CharacterScale, width: number, height: number) {
  const actual = Math.max(0, Math.min(scale, width / WIDGET_SIZE.width, height / WIDGET_SIZE.height));
  return { scale: actual, width: WIDGET_SIZE.width * actual, height: WIDGET_SIZE.height * actual,
    left: (width - WIDGET_SIZE.width * actual) / 2, top: height - WIDGET_SIZE.height * actual };
}

/** Reserve a visible heading/close button and scroll the text on constrained displays. */
export function bubbleLayout(hpY: number, layout: ReturnType<typeof sceneLayout>, height: number) {
  const bottom = Math.min(height - 8, Math.max(68, layout.top + (hpY - 33) * layout.scale));
  return { bottom: height - bottom, maxHeight: Math.max(0, bottom - 8) };
}

/** Preserve the character's screen-space feet when its native window grows or shrinks. */
export function resizedWidgetBounds(current: Rect, oldScale: CharacterScale, nextScale: CharacterScale, work: Rect): Rect {
  const size = widgetSize(nextScale);
  const width = Math.min(size.width, work.width), height = Math.min(size.height, work.height);
  const previous = sceneLayout(oldScale, current.width, current.height);
  const next = sceneLayout(nextScale, width, height);
  const feet = { x: current.x + current.width / 2, y: current.y + current.height - 34 * previous.scale };
  const round = (value: number) => Math.round(value) || 0;
  return { x: round(Math.max(work.x, Math.min(feet.x - width / 2, work.x + work.width - width))),
    y: round(Math.max(work.y, Math.min(feet.y - height + 34 * next.scale, work.y + work.height - height))), width, height };
}
