// Optional Linux/browser verification. Build first; native macOS behavior is a separate check.
// CHROMIUM_PATH=/usr/bin/chromium node scripts/verify-renderer.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const bundle = (await build({ stdin: { contents: `
  export { prepareChelseaSprites, getChelseaSpriteFrame } from './src/renderer/characters/chelsea-sprites';
  export { splitSpriteComponents, extractSpriteComponent } from './src/renderer/characters/sprite-components';
  export { createPetSpriteLoader } from './src/renderer/characters/pet-sprites';
  export { selectChelseaFrame, selectChelseaOriginalFrame } from './src/renderer/characters/chelsea-animation';
  export { getChelseaGait, CHELSEA_STRIDE } from './src/renderer/characters/chelsea-gait';
  export { createChelseaWalkRig } from './src/renderer/characters/chelsea-walk-rig';
  export { chelsea } from './src/renderer/characters/chelsea';
  export { getCharacterFrame, renderCharacterScene } from './src/renderer/character-runtime';
`, resolveDir: root }, bundle: true, format: 'esm', write: false })).outputFiles[0].text;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/characters/pets.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); return; }
    const file = ['/assets/chelsea-walk-rig.png', '/assets/chelsea-pet.png', '/assets/chelsea-turn.png'].includes(path) ? resolve(root, 'src/renderer', '.' + path)
      : resolve(root, 'dist/renderer', '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(root + '/')) throw new Error();
    response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, timezoneId: process.env.TZ || 'UTC' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date(2026, 9, 20, 23, 59, 50) });
  await page.addInitScript(() => {
    const schedule = { date: '2026-10-20', startTime: '09:00', endTime: '18:00' };
    let listener;
    window.testState = { appearance: { characterId: 'chelsea', scale: 1 }, appearanceError: null,
      chat: { conversationId: 'test', messages: [], provider: 'test', providerLabel: 'test', connection: { status: 'unchecked', message: '' }, status: 'idle', requestId: null, question: '', answer: null, error: null },
      chatOpen: false, chatShortcut: '', chatShortcutRegistered: false, chatShortcutError: null,
      motion: 'idle', direction: 1, hp: 100, workSchedule: schedule,
      workProgress: { hp: 100, phase: 'finished', remainingMinutes: 0, isOvernight: false },
      memos: [], memoError: null, reminderError: null, walking: true, visible: true, userHidden: false,
      panelOpen: true, panelNavigation: { tab: 'work', sequence: 1 }, motionStartedAt: Date.now(), bubble: null,
      displayId: 1, displays: [], shortcut: '', shortcutRegistered: true, error: null };
    window.emitState = patch => { Object.assign(window.testState, patch); listener?.({ ...window.testState }); };
    window.companion = {
      getState: async () => window.testState, onState: callback => { listener = callback; return () => {}; },
      setWorkSchedule: async schedule => { if (window.failSave) return { ok: false, error: '저장 실패' }; window.emitState({ workSchedule: schedule }); return { ok: true }; },
      setHitRegions() {}, closePanel() {}, openChat() {}, onChatFocus: () => () => {},
    };
  });
  await page.goto(url + '/#panel');
  const date = page.getByTestId('work-date');
  const start = page.getByTestId('work-start');
  const end = page.getByTestId('work-end');
  assert.equal(await date.inputValue(), '2026-10-20');
  await page.evaluate(() => window.emitState({ workSchedule: { ...window.testState.workSchedule, date: '2026-10-21' } }));
  await page.waitForFunction(() => document.querySelector('#work-date').value === '2026-10-21');
  await date.fill('2026-10-25'); await start.fill('10:00'); await end.fill('20:00');
  await page.evaluate(() => window.emitState({ workSchedule: { date: '2026-10-22', startTime: '08:00', endTime: '17:00' } }));
  await page.clock.fastForward('24:00:00');
  assert.equal(await date.inputValue(), '2026-10-25');
  assert.equal(await start.inputValue(), '10:00'); assert.equal(await end.inputValue(), '20:00');
  await page.evaluate(() => { window.failSave = true; });
  await page.getByTestId('apply-work-schedule').click();
  await page.getByTestId('work-error').waitFor();
  await page.evaluate(() => window.emitState({ workSchedule: { ...window.testState.workSchedule, date: '2026-10-23' } }));
  assert.equal(await date.inputValue(), '2026-10-25', 'failed saves retain dirty edits');
  await page.evaluate(() => { window.failSave = false; });
  await page.getByTestId('apply-work-schedule').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="apply-work-schedule"]').disabled);
  await page.evaluate(() => window.emitState({ workSchedule: { ...window.testState.workSchedule, date: '2026-10-26' } }));
  await page.waitForFunction(() => document.querySelector('#work-date').value === '2026-10-26');
  await page.reload();
  await page.evaluate(() => window.emitState({ workSchedule: null }));
  await page.clock.fastForward('24:00:00');
  await page.waitForFunction(() => document.querySelector('#work-date').value === new Date().toLocaleDateString('sv-SE'));
  console.log('PASS: clean rollover, dirty date/time edits, failed/successful saves and unset date at local midnight');

  // Exercise actual PNG pixels and the production loader in Canvas, not synthetic fixtures.
  const sprites = await page.evaluate(async () => {
    const m = await import('/characters/pets.js');
    await m.prepareChelseaSprites();
    const image = new Image(); image.src = '/assets/chelsea-walk-rig.png'; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const components = m.splitSpriteComponents(rgba, canvas.width, canvas.height, 2, 4);
    if (!components) throw new Error('walk asset must have exactly 8 isolated rig parts');
    const geometry = [];
    document.body.innerHTML = '<div id="poses" style="display:grid;grid-template-columns:repeat(8,140px);background:#f5f3ef"></div>';
    for (const facing of [-1, 1]) for (let i = 0; i < 64; i++) {
      const now = Date.now();
      const state = { ...window.testState, panelOpen: false, motion: 'walking', pet: { activity: 'walk', facing,
        fromFacing: facing, startedAt: now, durationMs: 4000, distance: i * m.CHELSEA_STRIDE / 64, speed: 0, sampledAt: now } };
      const sprite = m.getChelseaSpriteFrame(state, now);
      if (!sprite || sprite.image.width !== 400) throw new Error('articulated gait was replaced by the legacy fallback');
      const frame = m.getCharacterFrame(m.chelsea, state, now);
      geometry.push({ points: frame.polygons.flat().length, regions: frame.polygons.length, hpY: frame.hp.y,
        foot: Math.max(...frame.polygons.flat().map(p => p.y)) });
      if (i % 4 === 0) {
        const preview = document.createElement('canvas'); preview.width = 280; preview.height = 300;
        preview.style.width = '140px'; preview.style.height = '150px';
        m.renderCharacterScene(preview.getContext('2d'), m.chelsea, state, now); document.querySelector('#poses').append(preview);
      }
    }
    const broken = m.createPetSpriteLoader('/missing.png', m.selectChelseaFrame);
    await broken.prepare();
    const invalid = broken.getFrame(window.testState, Date.now());
    return { components: components.frames.length, geometry, fallback: invalid === null };
  });
  assert.equal(sprites.components, 8);
  assert.equal(sprites.fallback, true);
  console.log('Canvas geometry:', JSON.stringify({ minFoot: Math.min(...sprites.geometry.map(f => f.foot)), maxFoot: Math.max(...sprites.geometry.map(f => f.foot)), minHpY: Math.min(...sprites.geometry.map(f => f.hpY)), maxHpY: Math.max(...sprites.geometry.map(f => f.hpY)) }));
  for (const frame of sprites.geometry) {
    assert.ok(frame.points >= 3); assert.ok(frame.hpY > 100 && frame.hpY < 266);
    // Polygon simplification can omit an isolated lowest pixel; artwork feet stay at the alpha bound.
    assert.ok(Math.abs(frame.foot - 266) <= 1); assert.ok(frame.regions <= 16);
  }
  await page.setViewportSize({ width: 1140, height: 650 });
  await page.screenshot({ path: '/tmp/deskmate-chelsea-rig-poses.png', fullPage: true });
  await page.route('**/assets/chelsea-walk-rig.png', route => route.abort());
  await page.reload();
  const originalFallback = await page.evaluate(async () => {
    const m = await import('/characters/pets.js'); await m.prepareChelseaSprites();
    const now = Date.now();
    return [-1, 1].map(facing => {
      const state = { ...window.testState, panelOpen: false, motion: 'walking', pet: {
        activity: 'walk', facing, fromFacing: facing, startedAt: now, durationMs: 4000, distance: 14, speed: 0, sampledAt: now } };
      return m.getChelseaSpriteFrame(state, now)?.selection;
    });
  });
  assert.deepEqual(originalFallback, [
    { clip: 'walk-left', row: 1, column: 4 }, { clip: 'walk-right', row: 2, column: 4 },
  ]);
  await page.route('**/assets/chelsea-pet.png', route => route.abort());
  await page.reload();
  assert.equal(await page.evaluate(async () => {
    const m = await import('/characters/pets.js'); await m.prepareChelseaSprites();
    return m.getChelseaSpriteFrame(window.testState, Date.now()) === null
      && m.getCharacterFrame(m.chelsea, window.testState, Date.now()).polygons.length > 0;
  }), true);
  assert.deepEqual(errors, []);
  console.log('PASS: eight rig art parts, 128 articulated directional poses, foot/HP/click geometry, original-sheet and Canvas fallbacks; no renderer exceptions (naturalness needs visual review)');
  console.log('Pose contact sheet: /tmp/deskmate-chelsea-rig-poses.png');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
