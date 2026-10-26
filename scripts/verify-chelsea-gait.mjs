// Browser/Canvas validation and review evidence; this does not certify naturalness or native macOS.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root = resolve(import.meta.dirname, '..');
const out = process.env.GAIT_EVIDENCE_DIR || '/tmp/deskmate-gait-evidence';
await mkdir(out, { recursive: true });
const bundle = (await build({ stdin: { resolveDir: root, contents: `
export { prepareChelseaSprites, getChelseaSpriteFrame } from './src/renderer/characters/chelsea-sprites';
export { getChelseaGait, CHELSEA_STRIDE } from './src/renderer/characters/chelsea-gait';
export { createPetSpriteLoader } from './src/renderer/characters/pet-sprites';
export { splitSpriteComponents } from './src/renderer/characters/sprite-components';
export { chelsea } from './src/renderer/characters/chelsea';
export { selectChelseaOriginalFrame } from './src/renderer/characters/chelsea-animation';
` }, bundle: true, format: 'esm', write: false })).outputFiles[0].text;
const previousBundle = (await build({ stdin: { resolveDir: root, contents: `
export { prepareChelseaSprites, getChelseaSpriteFrame } from './src/renderer/characters/chelsea-sprites';
` }, bundle: true, format: 'esm', write: false, plugins: [{ name: 'previous-reviewed-candidate', setup(b) {
  b.onLoad({ filter: /chelsea-(gait|walk-rig)\.ts$/ }, args => ({
    contents: execFileSync('git', ['show', '8681d3cf:src/renderer/characters/' + args.path.split('/').at(-1)], { cwd: root }).toString(),
    loader: 'ts', resolveDir: resolve(root, 'src/renderer/characters'),
  }));
} }] })).outputFiles[0].text;
const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f5f5ef;font:14px system-ui;color:#354238}canvas{display:block}</style><canvas id="review" width="1000" height="460"></canvas>`;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
    if (path === '/characters/gait.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); return; }
    if (path === '/characters/previous-gait.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(previousBundle); return; }
    if (!['/assets/chelsea-pet.png', '/assets/chelsea-walk-rig.png', '/assets/chelsea-turn.png'].includes(path)) throw new Error();
    response.setHeader('Content-Type', 'image/png'); response.end(await readFile(root + '/src/renderer' + path));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 460 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const measurements = await page.evaluate(async () => {
    const m = await import('/characters/gait.js'); await m.prepareChelseaSprites();
    const previous = await import('/characters/previous-gait.js'); await previous.prepareChelseaSprites();
    const original = m.createPetSpriteLoader('/assets/chelsea-pet.png', m.selectChelseaOriginalFrame);
    await original.prepare();
    const epoch = 1_800_000_000_000;
    const base = { appearance: { characterId: 'chelsea', scale: 1 }, motion: 'walking', direction: 1, motionStartedAt: epoch,
      panelOpen: false, chatOpen: false, bubble: null, hp: 50 };
    function state(distance, direction = 1) { return { ...base, direction, pet: { activity: 'walk', facing: direction, fromFacing: direction,
      startedAt: epoch, durationMs: 8000, distance, speed: 32, sampledAt: epoch } }; }
    const loaded = m.getChelseaSpriteFrame(state(20), epoch);
    if (!loaded || loaded.image.width !== 400) throw new Error('articulated rig did not load; legacy fallback was displayed');
    const held = state(19), drawImage = CanvasRenderingContext2D.prototype.drawImage;
    m.getChelseaSpriteFrame(held, epoch);
    let heldDrawCalls = 0;
    CanvasRenderingContext2D.prototype.drawImage = function(...args) { heldDrawCalls++; return drawImage.apply(this, args); };
    m.getChelseaSpriteFrame(held, epoch + 20);
    CanvasRenderingContext2D.prototype.drawImage = drawImage;
    if (heldDrawCalls !== 0) throw new Error('held actual-distance pose should reuse its raster between IPC samples');
    const stablePixels = new Uint8ClampedArray(m.getChelseaSpriteFrame(held, epoch + 20).image.getContext('2d').getImageData(0, 0, 400, 240).data);
    m.getChelseaSpriteFrame(state(33), epoch + 500);
    const repeatedPixels = m.getChelseaSpriteFrame(held, epoch + 1200).image.getContext('2d').getImageData(0, 0, 400, 240).data;
    if (!stablePixels.every((value, index) => value === repeatedPixels[index])) throw new Error('same gait pose must have identical fur pixels after repaint; no time-dependent sparkle');
    const renderTimings = [];
    for (let i = 0; i < 180; i++) {
      const start = performance.now();
      const frame = m.getChelseaSpriteFrame(state(20 + i / 4), epoch + 100 + i * 33);
      frame.image.getContext('2d').getImageData(100, 100, 1, 1); // Flush Canvas work; browser diagnostic only.
      renderTimings.push(performance.now() - start);
    }
    renderTimings.sort((a,b) => a-b);
    const browserRenderMs = { median: renderTimings[90], p95: renderTimings[171], max: renderTimings[179], includesForcedReadback: true };
    const image = new Image(); image.src = '/assets/chelsea-walk-rig.png'; await image.decode();
    const input = document.createElement('canvas'); input.width = image.width; input.height = image.height;
    const ic = input.getContext('2d'); ic.drawImage(image, 0, 0);
    if (!m.splitSpriteComponents(ic.getImageData(0, 0, image.width, image.height).data, image.width, image.height, 2, 4)) throw new Error('rig art must contain eight separate parts');
    const bounds = frame => {
      const ctx = frame.image.getContext('2d'), rgba = ctx.getImageData(0, 0, frame.image.width, frame.image.height).data;
      let left = frame.image.width, right = 0, top = frame.image.height, bottom = 0;
      for (let y = 0; y < frame.image.height; y++) for (let x = 0; x < frame.image.width; x++) if (rgba[(y * frame.image.width + x) * 4 + 3] >= 48) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      return { width: (right - left + 1) / 2, height: (bottom - top + 1) / 2, top: top / 2 + frame.destination.y,
        bottom: bottom / 2 + frame.destination.y };
    };
    const walkBounds = [], transitionBounds = [];
    for (const direction of [-1, 1]) {
      for (let i = 0; i <= 64; i++) {
        const s = state(i / 64 * m.CHELSEA_STRIDE, direction), frame = m.getChelseaSpriteFrame(s, epoch);
        if (frame.polygons.length > 16) throw new Error('click regions exceed native sanitizer bound');
        walkBounds.push({ direction, ...bounds(frame) });
        const gait = m.getChelseaGait(s.pet.distance, direction);
        const rgba = frame.image.getContext('2d').getImageData(0, 0, frame.image.width, frame.image.height).data;
        for (const leg of gait.legs.filter(leg => leg.stance)) {
          const x = Math.round((leg.paw.x - frame.destination.x) * 2), y = Math.round((-2 - frame.destination.y) * 2);
          if (rgba[(y * frame.image.width + x) * 4 + 3] < 48) throw new Error('a planted model paw has no visible rendered paw');
        }
      }
      for (const age of Array.from({ length: 72 }, (_, i) => i * 16)) {
        const stopped = { ...state(0, direction), motion: 'idle', pet: { ...state(0, direction).pet, activity: 'idle', fromActivity: 'walk', previousWalkDistance: 85 } };
        const frame = m.getChelseaSpriteFrame(stopped, epoch + age);
        // Convert original atlas bounds to logical units when the transition has ended.
        const b = frame.image.width === 400 ? bounds(frame) : { width: frame.destination.width, height: -frame.top, bottom: 0 };
        if (age >= 420 && age < 980 && frame.polygons.length !== 1) throw new Error('turn must use one coherent cat silhouette, never two overlapping bodies');
        transitionBounds.push({ direction, age, ...b });
      }
    }
    for (const direction of [-1, 1]) for (const age of Array.from({ length: 28 }, (_, i) => i * 16)) {
      const s = { ...state(0, direction), motion: 'idle', pet: { ...state(0, direction).pet, activity: 'turn', durationMs: 420 } };
      const frame = m.getChelseaSpriteFrame(s, epoch + age);
      if (frame.polygons.length !== 1) throw new Error('starting turn must display one opaque cat');
    }
    const canvas = document.querySelector('#review'), ctx = canvas.getContext('2d');
    const colors = { RH: '#965546', RF: '#335f9d', LH: '#977b22', LF: '#497a44' };
    function drawFrame(frame, x, ground) {
      const s = frame.source, d = frame.destination;
      ctx.drawImage(frame.image, s.x, s.y, s.width, s.height, x + d.x, ground + d.y, d.width, d.height);
    }
    window.drawReview = seconds => {
      ctx.fillStyle = '#f5f5ef'; ctx.fillRect(0, 0, 1000, 460);
      ctx.fillStyle = '#354238'; ctx.font = '17px system-ui'; ctx.fillText('첼시 보행 비교 · 실제 렌더러 / 위치·시간은 제어된 모의 환경', 22, 30);
      ctx.font = '13px system-ui'; ctx.fillText('위: 이전 8681d3c    아래: 같은 움직임 + 다리·발 볼륨 보정', 22, 55);
      const left = seconds >= 7.5, t = left ? seconds - 7.5 : seconds;
      const direction = left ? -1 : 1, walkTime = Math.max(0, Math.min(5.5, t - 0.45)), distance = walkTime * 32;
      const root = left ? 520 - distance : 180 + distance;
      let s = state(distance, direction), now = epoch + seconds * 1000;
      if (t < 0.45) s = { ...s, motion: 'idle', pet: { ...s.pet, activity: 'turn', startedAt: now - t * 1000, durationMs: 450, fromActivity: 'idle' } };
      else if (t > 5.95) s = { ...s, motion: 'idle', pet: { ...s.pet, activity: 'idle', fromActivity: 'walk', previousWalkDistance: distance,
        startedAt: now - (t - 5.95) * 1000, durationMs: 3000 } };
      for (const y of [180, 365]) {
        ctx.strokeStyle = '#bac5b2'; ctx.beginPath(); ctx.moveTo(20, y + 0.5); ctx.lineTo(980, y + 0.5); ctx.stroke();
        ctx.strokeStyle = '#e1e6db';
        for (let x = 24; x < 990; x += 24) { ctx.beginPath(); ctx.moveTo(x, y - 100); ctx.lineTo(x, y + 10); ctx.stroke(); }
      }
      const old = previous.getChelseaSpriteFrame(s, now);
      if (old) drawFrame(old, root, 180);
      const frame = m.getChelseaSpriteFrame(s, now); drawFrame(frame, root, 365);
      ctx.fillStyle = '#354238'; ctx.font = '13px system-ui';
      ctx.fillText(`이전 8681d3c: 잔털 보정 / 가는 다리`, 22, 205);
      ctx.fillText(`수정 후보: 보폭 ${m.CHELSEA_STRIDE}px / ${s.pet.activity} / ${direction > 0 ? '오른쪽' : '왼쪽'}`, 22, 392);
      const g = m.getChelseaGait(distance, direction);
      if (window.showContactMarkers && s.pet.activity === 'walk') for (const leg of g.legs) {
        ctx.strokeStyle = colors[leg.id]; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(root + leg.paw.x, 365 + leg.paw.y - 2, 4.5, 0, Math.PI * 2); ctx.stroke();
      }
      let x = 350;
      for (const leg of g.legs) { ctx.fillStyle = colors[leg.id]; ctx.fillText(`${leg.id}: ${leg.stance ? '지지' : '스윙'}`, x, 423); x += 115; }
      ctx.fillStyle = '#596752'; ctx.fillText('위치·시간은 모의 환경입니다. 자연스러움·접지 오차는 native 앱에서 별도 판정해야 합니다.', 22, 448);
      return canvas.toDataURL('image/png').split(',')[1];
    };
    window.drawFilmstrip = () => {
      const sheet = document.createElement('canvas'); sheet.width = 1120; sheet.height = 480;
      const sc = sheet.getContext('2d'); sc.fillStyle = '#f5f5ef'; sc.fillRect(0, 0, sheet.width, sheet.height);
      sc.fillStyle = '#354238'; sc.font = '16px system-ui'; sc.fillText('현재 수정 연구 · 실제 renderer · 정상 크기 / 양방향 각 8위상', 20, 25);
      for (const [row, direction] of [1, -1].entries()) for (let i = 0; i < 8; i++) {
        const frame = m.getChelseaSpriteFrame(state((i / 8 + 1) * m.CHELSEA_STRIDE, direction), epoch);
        const x = 90 + (i % 4) * 270, y = 130 + row * 220 + Math.floor(i / 4) * 105;
        const src = frame.source, dst = frame.destination;
        sc.strokeStyle = '#c6cdbf'; sc.beginPath(); sc.moveTo(x - 68, y + .5); sc.lineTo(x + 100, y + .5); sc.stroke();
        sc.drawImage(frame.image, src.x, src.y, src.width, src.height, x + dst.x, y + dst.y, dst.width, dst.height);
        sc.fillStyle = '#354238'; sc.font = '12px system-ui'; sc.fillText((direction > 0 ? '오른쪽' : '왼쪽') + ' ' + i + '/8', x + 90, y - 60);
      }
      return sheet.toDataURL('image/png').split(',')[1];
    };
    window.drawTransitions = () => {
      const sheet = document.createElement('canvas'); sheet.width = 1280; sheet.height = 440;
      const sc = sheet.getContext('2d'); sc.fillStyle = '#f5f5ef'; sc.fillRect(0, 0, sheet.width, sheet.height);
      for (const [row, direction] of [1,-1].entries()) for (let i=0;i<8;i++) {
        const age = 360 + i * 100;
        const stopped = { ...state(0,direction), motion:'idle', pet:{...state(0,direction).pet, activity:'idle', fromActivity:'walk',previousWalkDistance:85} };
        const frame = m.getChelseaSpriteFrame(stopped,epoch+age),src=frame.source,dst=frame.destination;
        const x = 80 + i * 160, y = 160 + row * 210;
        sc.strokeStyle='#bac5b2';sc.beginPath();sc.moveTo(x-70,y);sc.lineTo(x+70,y);sc.stroke();
        sc.drawImage(frame.image,src.x,src.y,src.width,src.height,x+dst.x,y+dst.y,dst.width,dst.height);
        sc.fillStyle='#354238';sc.font='12px system-ui';sc.fillText(age+'ms',x-20,y+20);
      }
      sc.fillStyle='#354238';sc.font='16px system-ui';sc.fillText('정지 전환 실제 크기 · 위 오른쪽 / 아래 왼쪽 · 모델 위치/시간',20,30);
      return sheet.toDataURL('image/png').split(',')[1];
    };
    window.drawCalibration = async () => {
      let index = 0;
      const turns = m.createPetSpriteLoader('/assets/chelsea-turn.png', () => ({clip:'turn', row: Math.floor(index / 4), column: index % 4}), {columns:4,rows:2,width:128,height:102});
      await turns.prepare();
      const sheet = document.createElement('canvas'); sheet.width = 1120; sheet.height = 300;
      const sc = sheet.getContext('2d'); sc.fillStyle = '#f5f5ef'; sc.fillRect(0, 0, sheet.width, sheet.height);
      const frames = [m.getChelseaSpriteFrame(state(56), epoch)];
      for(index = 0; index < 8; index++) frames.push(turns.getFrame(base, epoch));
      frames.push(original.getFrame({...base,motion:'idle',pet:undefined}, epoch));
      frames.forEach((frame,i) => {
        if (!frame) throw new Error('transition asset parsing failed');
        const x = 90 + i % 5 * 220, y = 140 + Math.floor(i / 5) * 140;
        const src = frame.source, dst = frame.destination;
        sc.strokeStyle = '#bac5b2'; sc.beginPath(); sc.moveTo(x-85,y); sc.lineTo(x+85,y); sc.stroke();
        sc.drawImage(frame.image,src.x,src.y,src.width,src.height,x+dst.x,y+dst.y,dst.width,dst.height);
        sc.fillStyle = '#354238'; sc.font='12px system-ui'; sc.fillText(i===0?'rig':i===9?'original idle':'turn '+(i-1),x-25,y+18);
      });
      return sheet.toDataURL('image/png').split(',')[1];
    };
    window.drawFurComparison = () => {
      const sheet = document.createElement('canvas'); sheet.width = 1100; sheet.height = 480;
      const sc=sheet.getContext('2d');sc.fillStyle='#f5f5ef';sc.fillRect(0,0,1100,480);
      sc.fillStyle='#354238';sc.font='17px system-ui';sc.fillText('정면 기준 / 이전 보행 / 다리·발 볼륨 보정 · 같은 거리·자세',20,30);
      const s=state(85), front=original.getFrame({...base,motion:'idle',pet:undefined},epoch);
      const a=previous.getChelseaSpriteFrame(s,epoch),b=m.getChelseaSpriteFrame(s,epoch);
      const oldPixels=a.image.getContext('2d').getImageData(0,0,400,240).data, newPixels=b.image.getContext('2d').getImageData(0,0,400,240).data;
      for(let i=0;i<400*128*4;i++) if(oldPixels[i]!==newPixels[i]) throw new Error('fur-only change altered head/back pixels above the legs');
      for(const [frame,x,label] of [[front,150,'정면 기준'],[a,460,'보정 전 8681d3c'],[b,790,'볼륨 보정 후']]){
        const src=frame.source,dst=frame.destination;
        sc.drawImage(frame.image,src.x,src.y,src.width,src.height,x+dst.x,160+dst.y,dst.width,dst.height);
        sc.font='14px system-ui';sc.fillText(label,x-40,190);
      }
      sc.font='13px system-ui';sc.fillText('아래: 다리 부분 4배 확대 (위는 실제 크기)',20,235);
      sc.drawImage(a.image,90,158,220,70,40,270,440,140);
      sc.drawImage(b.image,90,158,220,70,590,270,440,140);
      sc.fillText('보정 전',40,435);sc.fillText('보정 후',590,435);
      return sheet.toDataURL('image/png').split(',')[1];
    };
    window.drawReview(2.1);
    return { walkBounds, transitionBounds, browserRenderMs, heldDrawCalls, startingTransitionsChecked: 56, rigParts: 8, actualRigLoaded: true };
  });
  assert.equal(measurements.actualRigLoaded, true);
  for (const bounds of measurements.walkBounds) {
    assert.ok(bounds.bottom <= 0.01 && bounds.bottom >= -1, 'ground line stays fixed');
    assert.ok(bounds.width > 115 && bounds.width < 150); assert.ok(bounds.height > 65 && bounds.height < 105);
  }
  const minimumWalkHeight = Math.min(...measurements.walkBounds.map(b => b.height));
  for (const bounds of measurements.transitionBounds) assert.ok(bounds.height >= minimumWalkHeight * 0.9, 'stop-to-sit must not shrink through a small legacy turn pose');
  await writeFile(out + '/fur-comparison.png', Buffer.from(await page.evaluate(() => window.drawFurComparison()), 'base64'));
  await writeFile(out + '/walking-phases.png', Buffer.from(await page.evaluate(() => window.drawFilmstrip()), 'base64'));
  await writeFile(out + '/transition-calibration.png', Buffer.from(await page.evaluate(() => window.drawCalibration()), 'base64'));
  await writeFile(out + '/stop-transitions.png', Buffer.from(await page.evaluate(() => window.drawTransitions()), 'base64'));
  await page.evaluate(() => window.drawReview(2.1));
  await page.locator('#review').screenshot({ path: out + '/walking-comparison.png' });
  await writeFile(out + '/measurements.json', JSON.stringify({ ...measurements, exceptions: errors }, null, 2));
  if (process.env.GAIT_VIDEO === '1') {
    await mkdir(out + '/frames', { recursive: true });
    for (let i = 0; i < 450; i++) {
      const pixels = await page.evaluate(t => window.drawReview(t), i / 30);
      await writeFile(`${out}/frames/${String(i).padStart(4, '0')}.png`, Buffer.from(pixels, 'base64'));
    }
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', out + '/frames/%04d.png', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '19', out + '/walking-comparison.mp4']);
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', artParts: 8, posesChecked: measurements.walkBounds.length,
    transitionsChecked: measurements.transitionBounds.length, startingTransitionsChecked: measurements.startingTransitionsChecked, evidence: out, nativeReview: 'motion accepted 2026-10-26; fur polish awaits native review' }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
