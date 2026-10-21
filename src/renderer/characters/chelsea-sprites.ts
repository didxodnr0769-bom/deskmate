import type { CompanionState, Point, Rect } from '../../shared/contracts';
import { CHELSEA_ATLAS, selectChelseaFrame, traceAlphaSilhouette, type ChelseaFrameSelection } from './chelsea-animation';
import { extractSpriteComponent, splitSpriteComponents } from './sprite-components';

interface SpriteFrame {
  image: HTMLCanvasElement;
  source: Rect;
  destination: Rect;
  polygons: Point[][];
  top: number;
}
interface SpriteAtlas { frames: SpriteFrame[] }
export interface ChelseaSpriteFrame extends SpriteFrame { selection: ChelseaFrameSelection }
let atlas: SpriteAtlas | null = null;
let preparation: Promise<void> | null = null;
let motionPreference: MediaQueryList | null = null;

/** The generated atlas is a packaged local input; loading never contacts an image service. */
export function prepareChelseaSprites(): Promise<void> {
  if (preparation) return preparation;
  if (typeof Image === 'undefined' || typeof document === 'undefined') return Promise.resolve();
  preparation = new Promise(resolve => {
    const image = new Image();
    image.decoding = 'async';
    image.onerror = () => resolve();
    image.onload = () => {
      try {
        if (image.naturalWidth < 8 || image.naturalHeight < 8 || image.naturalWidth > 8_192 || image.naturalHeight > 8_192) { resolve(); return; }
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) { resolve(); return; }
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        context.drawImage(image, 0, 0);
        const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const components = splitSpriteComponents(rgba, canvas.width, canvas.height, CHELSEA_ATLAS.columns, CHELSEA_ATLAS.rows);
        if (!components) { resolve(); return; }
        const actors = [];
        let maximumWidth = 1, maximumHeight = 1;
        for (const component of components.frames) {
          // The generated sheet has uneven rows; exclude every neighbouring actor even when bounds overlap.
          const extracted = extractSpriteComponent(rgba, components, component);
          const silhouette = traceAlphaSilhouette(extracted.rgba, extracted.width, extracted.height);
          if (!silhouette?.polygons.length) { resolve(); return; }
          const frameCanvas = document.createElement('canvas');
          frameCanvas.width = extracted.width; frameCanvas.height = extracted.height;
          const frameContext = frameCanvas.getContext('2d');
          if (!frameContext) { resolve(); return; }
          frameContext.putImageData(new ImageData(new Uint8ClampedArray(extracted.rgba), extracted.width, extracted.height), 0, 0);
          maximumWidth = Math.max(maximumWidth, silhouette.bounds.width);
          maximumHeight = Math.max(maximumHeight, silhouette.bounds.height);
          actors.push({ image: frameCanvas, silhouette });
        }
        const scale = Math.min(128 / maximumWidth, 102 / maximumHeight);
        const frames: SpriteFrame[] = actors.map(({ image: actorImage, silhouette }) => {
          const { bounds } = silhouette;
          const foot = bounds.y + bounds.height;
          const center = bounds.x + bounds.width / 2;
          const map = (point: Point): Point => ({ x: (point.x - center) * scale, y: (point.y - foot) * scale });
          return {
            image: actorImage,
            source: { x: 0, y: 0, width: actorImage.width, height: actorImage.height },
            destination: { x: -center * scale, y: -foot * scale, width: actorImage.width * scale, height: actorImage.height * scale },
            polygons: silhouette.polygons.map(polygon => polygon.map(map)),
            top: (bounds.y - foot) * scale,
          };
        });
        atlas = { frames };
      } catch {
        // The code-native Chelsea remains available after an unreadable local asset.
      }
      resolve();
    };
    image.src = new URL('../assets/chelsea-pet.png', import.meta.url).href;
  });
  return preparation;
}

export function getChelseaSpriteFrame(state: CompanionState, epochNow: number): ChelseaSpriteFrame | null {
  void prepareChelseaSprites();
  if (!atlas) return null;
  if (!motionPreference && typeof window !== 'undefined' && window.matchMedia) motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const selection = selectChelseaFrame(state, epochNow, !!motionPreference?.matches);
  const sprite = atlas.frames[selection.row * CHELSEA_ATLAS.columns + selection.column];
  return { selection, ...sprite };
}
