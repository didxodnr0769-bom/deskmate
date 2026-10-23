import type { CompanionState, Point } from '../../shared/contracts';
import { chelseaWalkDistance, ease, getChelseaGait, settleChelseaGait, type ChelseaGait } from './chelsea-gait';
import { traceAlphaSilhouette, type AlphaSilhouette } from './pet-animation';
import { createPetSpriteLoader, type PetSpriteFrame } from './pet-sprites';
import { extractSpriteComponent, splitSpriteComponents } from './sprite-components';

interface Part { image: HTMLCanvasElement; outline: AlphaSilhouette }
const WIDTH = 200, HEIGHT = 120, ORIGIN = { x: 100, y: 114 };
const STOP_SETTLE = 420, STOP_TOTAL = 980;

/** Fixed anatomical root + articulated image parts. Never recenters each walk pose on its bbox. */
export function createChelseaWalkRig(assetUrl: string, turnUrl?: string) {
  let parts: Part[] | null = null;
  let skins: Part[] = [];
  let preparing: Promise<void> | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let context: CanvasRenderingContext2D | null = null;
  let preference: MediaQueryList | null = null;
  let cachedKey = '', cached: PetSpriteFrame | null = null;
  let turnIndex = 0;
  let turns: PetSpriteFrame[] = [];
  const turnLoader = turnUrl ? createPetSpriteLoader(turnUrl,
    () => ({ clip: 'turn', row: Math.floor(turnIndex / 4), column: turnIndex % 4 }),
    { columns: 4, rows: 2, width: 128, height: 102 }) : null;
  async function prepareTurns() {
    if (!turnLoader) return;
    await turnLoader.prepare();
    for (turnIndex = 0; turnIndex < 8; turnIndex++) {
      const frame = turnLoader.getFrame({} as CompanionState, 0);
      if (!frame) { turns = []; return; }
      // The white ground-contact paws locate the anatomical root. A sweeping
      // tail must not drag this root around as the body turns in place.
      const source = frame.image.getContext('2d')!;
      const { width, height } = frame.image;
      const rgba = source.getImageData(0, 0, width, height).data;
      let bottom = 0, left = width, right = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (rgba[(y * width + x) * 4 + 3] >= 128) bottom = y;
      }
      for (let y = Math.max(0, bottom - 10); y <= bottom; y++) for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        if (rgba[p + 3] >= 128 && Math.min(rgba[p], rgba[p + 1], rgba[p + 2]) >= 150) {
          left = Math.min(left, x); right = Math.max(right, x);
        }
      }
      const scale = frame.destination.width / width;
      const shift = right > left ? -(left + right) / 2 * scale - frame.destination.x : 0;
      turns.push({ ...frame, destination: { ...frame.destination, x: frame.destination.x + shift },
        polygons: frame.polygons.map(poly => poly.map(p => ({ x: p.x + shift, y: p.y }))) });
    }
  }
  function prepare(): Promise<void> {
    if (preparing) return preparing;
    if (typeof Image === 'undefined' || typeof document === 'undefined') return Promise.resolve();
    preparing = Promise.all([prepareTurns().catch(() => { turns = []; }), new Promise<void>(resolve => {
      const image = new Image(); image.onerror = () => resolve();
      image.onload = () => {
        try {
          if (image.naturalWidth > 8192 || image.naturalHeight > 8192) { resolve(); return; }
          const source = document.createElement('canvas'); source.width = image.naturalWidth; source.height = image.naturalHeight;
          const ctx = source.getContext('2d', { willReadFrequently: true }); if (!ctx) { resolve(); return; }
          ctx.drawImage(image, 0, 0);
          const rgba = ctx.getImageData(0, 0, source.width, source.height).data;
          const components = splitSpriteComponents(rgba, source.width, source.height, 2, 4);
          if (!components) { resolve(); return; }
          const loaded: Part[] = [];
          for (const component of components.frames) {
            const pixels = extractSpriteComponent(rgba, components, component);
            const outline = traceAlphaSilhouette(pixels.rgba, pixels.width, pixels.height);
            if (!outline?.polygons[0]) { resolve(); return; }
            const part = document.createElement('canvas'); part.width = pixels.width; part.height = pixels.height;
            const pc = part.getContext('2d'); if (!pc) { resolve(); return; }
            pc.putImageData(new ImageData(new Uint8ClampedArray(pixels.rgba), pixels.width, pixels.height), 0, 0);
            loaded.push({ image: part, outline });
          }
          canvas = document.createElement('canvas'); canvas.width = WIDTH * 2; canvas.height = HEIGHT * 2;
          context = canvas.getContext('2d');
          if (context) {
            // The old individual pieces have pale rounded end caps. One gray
            // coat texture now spans each entire curved leg; its cut ends are
            // concealed by the torso and the paw's gray cuff.
            skins = [loaded[2], loaded[4]].map(part => {
              const bounds = part.outline.bounds, image = document.createElement('canvas');
              image.width = Math.ceil(bounds.width); image.height = Math.floor(bounds.height * 0.7);
              const dc = image.getContext('2d')!;
              dc.drawImage(part.image, bounds.x, bounds.y, bounds.width, image.height, 0, 0, image.width, image.height);
              const pixels = dc.getImageData(0, 0, image.width, image.height);
              const outline = traceAlphaSilhouette(pixels.data, image.width, image.height);
              if (!outline?.polygons[0]) throw new Error('missing continuous leg coat');
              return { image, outline };
            });
            parts = loaded;
          }
        } catch { /* The independently loaded original atlas remains the fallback. */ }
        resolve();
      };
      image.src = assetUrl;
    })]).then(() => {});
    return preparing;
  }

  function paint(gait: ChelseaGait, polygons: Point[][]): number {
    const ctx = context!, art = parts!;
    let top = 0;
    // Map exactly the same source alpha outline and affine transform used to draw each part.
    const draw = (part: Part, map: (p: Point) => Point, paintPart: () => void, shade = 1) => {
      ctx.save();
      if (shade < 1) ctx.filter = `brightness(${shade})`;
      paintPart(); ctx.restore();
      const polygon = part.outline.polygons[0].map(map).map(p => ({ ...p, y: Math.min(0, p.y) }));
      polygons.push(polygon);
      top = Math.min(top, ...polygon.map(p => p.y));
    };
    const triangle = (part: Part, source: Point[], dest: Point[]) => {
      const sx = source[1].x - source[0].x, sy = source[1].y - source[0].y;
      const tx = source[2].x - source[0].x, ty = source[2].y - source[0].y, det = sx * ty - tx * sy;
      const dx = dest[1].x - dest[0].x, dy = dest[1].y - dest[0].y;
      const ex = dest[2].x - dest[0].x, ey = dest[2].y - dest[0].y;
      const a = (dx * ty - ex * sy) / det, b = (dy * ty - ey * sy) / det;
      const c = (ex * sx - dx * tx) / det, d = (ey * sx - dy * tx) / det;
      const center = { x: (dest[0].x + dest[1].x + dest[2].x) / 3, y: (dest[0].y + dest[1].y + dest[2].y) / 3 };
      // Tiny opaque overdraw covers antialias cracks between adjacent skin
      // triangles. No blur, transparency, or secondary limb is introduced.
      const edge = dest.map(p => ({ x: p.x + (p.x - center.x) * 0.025, y: p.y + (p.y - center.y) * 0.025 }));
      ctx.save(); ctx.beginPath(); ctx.moveTo(edge[0].x, edge[0].y); ctx.lineTo(edge[1].x, edge[1].y); ctx.lineTo(edge[2].x, edge[2].y); ctx.closePath(); ctx.clip();
      ctx.transform(a, b, c, d, dest[0].x - a * source[0].x - c * source[0].y, dest[0].y - b * source[0].x - d * source[0].y);
      ctx.drawImage(part.image, 0, 0); ctx.restore();
    };
    const drawCoat = (leg: ChelseaGait['legs'][number], front = false) => {
      const part = skins[leg.fore ? 0 : 1], bounds = part.outline.bounds;
      const map = (p: Point) => {
        const t = Math.max(0, Math.min(1, (p.y - bounds.y) / bounds.height)), u = 1 - t;
        const center = { x: u * u * leg.root.x + 2 * u * t * leg.joint.x + t * t * leg.ankle.x,
          y: u * u * leg.root.y + 2 * u * t * leg.joint.y + t * t * leg.ankle.y };
        const tangent = { x: 2 * (u * (leg.joint.x - leg.root.x) + t * (leg.ankle.x - leg.joint.x)),
          y: 2 * (u * (leg.joint.y - leg.root.y) + t * (leg.ankle.y - leg.joint.y)) };
        const length = Math.hypot(tangent.x, tangent.y);
        const width = u * u * (leg.fore ? 18 : 23) + 2 * u * t * 12 + t * t * 8.5;
        const across = ((p.x - bounds.x) / bounds.width - 0.5) * width;
        return { x: center.x + tangent.y / length * across, y: center.y - tangent.x / length * across };
      };
      ctx.save();
      if (!leg.near) ctx.filter = 'brightness(0.86)';
      if (front) { ctx.beginPath(); ctx.rect(-100, -20, 200, 20); ctx.clip(); }
      const rows: Point[][] = [];
      for (let i = 0; i <= 8; i++) rows.push([
        map({ x: bounds.x, y: bounds.y + bounds.height * i / 8 }),
        map({ x: bounds.x + bounds.width, y: bounds.y + bounds.height * i / 8 }),
      ]);
      for (let i = 0; i < 8; i++) {
        const y0 = bounds.y + bounds.height * i / 8, y1 = bounds.y + bounds.height * (i + 1) / 8;
        const source = [{ x: bounds.x, y: y0 }, { x: bounds.x + bounds.width, y: y0 },
          { x: bounds.x + bounds.width, y: y1 }, { x: bounds.x, y: y1 }];
        const dest = [rows[i][0], rows[i][1], rows[i + 1][1], rows[i + 1][0]];
        triangle(part, [source[0], source[1], source[2]], [dest[0], dest[1], dest[2]]);
        triangle(part, [source[0], source[2], source[3]], [dest[0], dest[2], dest[3]]);
      }
      ctx.restore();
      if (!front) polygons.push(part.outline.polygons[0].map(p => {
        const x = Math.max(0, Math.min(1, (p.x - bounds.x) / bounds.width));
        const v = Math.max(0, Math.min(8, (p.y - bounds.y) / bounds.height * 8));
        const row = Math.min(7, Math.floor(v)), y = v - row;
        const a = rows[row][0], b = rows[row][1], c = rows[row + 1][1], d = rows[row + 1][0];
        // Barycentric coordinates match the two actual raster triangles.
        return x >= y ? { x: a.x * (1 - x) + b.x * (x - y) + c.x * y, y: Math.min(0, a.y * (1 - x) + b.y * (x - y) + c.y * y) }
          : { x: a.x * (1 - y) + c.x * x + d.x * (y - x), y: Math.min(0, a.y * (1 - y) + c.y * x + d.y * (y - x)) };
      }));
    };
    const drawPaw = (leg: ChelseaGait['legs'][number]) => {
      const shade = leg.near ? 1 : 0.86;
      const paw = art[leg.fore ? 6 : 7], bounds = paw.outline.bounds, w = leg.fore ? 12 : 13, h = leg.fore ? 10.5 : 11;
      const map = (p: Point) => ({ x: leg.paw.x + ((p.x - bounds.x) / bounds.width * w - w / 2) * gait.facing,
        y: leg.paw.y - h + (p.y - bounds.y) / bounds.height * h });
      draw(paw, map, () => { ctx.translate(leg.paw.x, leg.paw.y); ctx.scale(gait.facing, 1);
        ctx.drawImage(paw.image, bounds.x, bounds.y, bounds.width, bounds.height, -w / 2, -h, w, h); }, shade);
    };
    for (const leg of gait.legs.filter(leg => !leg.near)) { drawCoat(leg); drawPaw(leg); }
    for (const leg of gait.legs.filter(leg => leg.near)) drawCoat(leg);
    const body = art[gait.facing > 0 ? 0 : 1], bounds = body.outline.bounds;
    const scale = 128 / Math.max(art[0].outline.bounds.width, art[1].outline.bounds.width);
    const w = bounds.width * scale, h = bounds.height * scale;
    const x = -(gait.facing > 0 ? 0.58 : 0.42) * w, y = -16 - h;
    const cos = Math.cos(gait.bodyRotation), sin = Math.sin(gait.bodyRotation);
    const map = (p: Point) => {
      const px = x + (p.x - bounds.x) * scale, py = y + (p.y - bounds.y) * scale;
      return { x: px * cos - py * sin, y: gait.bodyY + px * sin + py * cos };
    };
    draw(body, map, () => { ctx.translate(0, gait.bodyY); ctx.rotate(gait.bodyRotation);
      ctx.drawImage(body.image, bounds.x, bounds.y, bounds.width, bounds.height, x, y, w, h); });
    for (const leg of gait.legs.filter(leg => leg.near)) { drawCoat(leg, true); drawPaw(leg); }
    return top;
  }

  function compose(gait: ChelseaGait, selection: PetSpriteFrame['selection']): PetSpriteFrame {
    const ctx = context!, image = canvas!;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, image.width, image.height);
    ctx.setTransform(2, 0, 0, 2, ORIGIN.x * 2, ORIGIN.y * 2);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.save(); ctx.beginPath(); ctx.rect(-ORIGIN.x, -ORIGIN.y, WIDTH, ORIGIN.y); ctx.clip();
    const polygons: Point[][] = [];
    const top = paint(gait, polygons);
    ctx.restore();
    return { image, source: { x: 0, y: 0, width: image.width, height: image.height },
      destination: { x: -ORIGIN.x, y: -ORIGIN.y, width: WIDTH, height: HEIGHT },
      polygons, top, selection };
  }

  function turnFrame(index: number, facing: 1 | -1): PetSpriteFrame | null {
    cachedKey = ''; cached = null;
    const frame = turns[Math.max(0, Math.min(7, index))];
    if (!frame) return null;
    if (facing > 0) return frame;
    // Mirror one coherent body, including its click geometry; never blend two cats.
    const ctx = context!, image = canvas!, s = frame.source, d = frame.destination;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, image.width, image.height);
    ctx.setTransform(-2, 0, 0, 2, ORIGIN.x * 2, ORIGIN.y * 2);
    ctx.drawImage(frame.image, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
    return { image, source: { x: 0, y: 0, width: image.width, height: image.height },
      destination: { x: -ORIGIN.x, y: -ORIGIN.y, width: WIDTH, height: HEIGHT },
      polygons: frame.polygons.map(poly => poly.map(p => ({ x: -p.x, y: p.y }))), top: frame.top, selection: frame.selection };
  }

  function getFrame(state: CompanionState, now: number, original: (state: CompanionState, now: number) => PetSpriteFrame | null): PetSpriteFrame | null {
    void prepare();
    if (!parts || !canvas || !context) return original(state, now);
    if (!preference && typeof window !== 'undefined') preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const reduced = !!preference?.matches, pet = state.pet;
    if (state.motion === 'dragged' || state.motion === 'dropping' || state.motion === 'notify' || state.bubble?.kind === 'chat-loading') return original(state, now);
    let distance = 0, lift = 0, settling: number | null = null;
    const facing = pet?.facing ?? state.direction;
    const age = Math.max(0, now - (pet?.startedAt ?? state.motionStartedAt));
    let selection: PetSpriteFrame['selection'] = { clip: facing < 0 ? 'walk-left' : 'walk-right', row: facing < 0 ? 1 : 2, column: 0 };
    const waking = pet?.activity === 'turn' && pet.fromActivity === 'sleep';
    if (waking && age < 550) return original(state, now);
    if (state.motion === 'walking' && (!pet || pet.activity === 'walk') && !state.panelOpen && !state.chatOpen && !state.bubble) {
      distance = reduced ? 0 : chelseaWalkDistance(state, now);
      lift = reduced ? 0 : ease(distance / 6);
    } else if (pet?.activity === 'turn' && !state.panelOpen && !state.chatOpen && !state.bubble) {
      const offset = waking ? 550 : 0;
      const progress = (age - offset) / Math.max(1, pet.durationMs - offset);
      return turnFrame(reduced ? 0 : 7 - Math.min(7, Math.floor(progress * 8)), facing)
        ?? compose(getChelseaGait(0, facing, 0), { clip: 'turn', row: 0, column: 0 });
    } else if (pet?.fromActivity === 'walk' && state.motion === 'idle') {
      distance = pet.previousWalkDistance ?? 0;
      const rest = { ...state, pet: { ...pet, fromActivity: undefined, startedAt: pet.startedAt + STOP_TOTAL,
        durationMs: Math.max(1, pet.durationMs - STOP_TOTAL) } };
      if (age >= STOP_TOTAL || reduced) return original(rest, now);
      if (age >= STOP_SETTLE) return turnFrame(Math.min(7, Math.floor((age - STOP_SETTLE) / (STOP_TOTAL - STOP_SETTLE) * 8)), facing)
        ?? compose(settleChelseaGait(distance, facing, 1), { clip: 'turn', row: 0, column: 0 });
      settling = age / STOP_SETTLE;
      selection = { clip: 'turn', row: 0, column: 0 };
    } else return original(state, now);
    // Main publishes actual travel at 30Hz. Reuse identical walking geometry
    // between those samples rather than reskinning it on every renderer RAF.
    const key = [state.motion, pet?.startedAt, facing, distance, lift, settling].join(':');
    if (key === cachedKey && cached) return cached;
    cachedKey = key;
    cached = compose(settling === null ? getChelseaGait(distance, facing, lift) : settleChelseaGait(distance, facing, settling), selection);
    return cached;
  }
  return { prepare, getFrame };
}
