import { app, Menu, nativeImage, powerMonitor, Tray } from 'electron';
import { mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { DesktopController } from './desktop/controller';

app.setName('Desktop Companion');
if (process.env.COMPANION_DATA_DIR) {
  mkdirSync(process.env.COMPANION_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.COMPANION_DATA_DIR);
}

// A tiny code-drawn monochrome stone for the macOS menu bar.
function trayImage() {
  const size = 20;
  const bytes = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inside = ((x - 10) / 8) ** 2 + ((y - 11) / 6) ** 2 < 1;
    const eye = y >= 9 && y <= 11 && (x === 7 || x === 12);
    bytes[y * (size * 4 + 1) + 1 + x * 4 + 3] = inside && !eye ? 255 : 0;
  }
  const crc = (data: Buffer) => {
    let value = 0xffffffff;
    for (const b of data) { value ^= b; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1)); }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, body: Buffer) => {
    const data = Buffer.concat([Buffer.from(name), body]);
    const n = Buffer.alloc(4), c = Buffer.alloc(4); n.writeUInt32BE(body.length); c.writeUInt32BE(crc(data));
    return Buffer.concat([n, data, c]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const image = nativeImage.createFromBuffer(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))]));
  image.setTemplateImage(true);
  return image;
}

let desktop: DesktopController | undefined;
let tray: Tray | undefined;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => desktop?.openPanel());
  void app.whenReady().then(() => {
    app.dock?.hide();
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Desktop Companion', submenu: [
      { label: '패널 열기', click: () => desktop?.openPanel() },
      { label: '캐릭터 숨기기 / 표시', click: () => desktop?.toggleVisibility() },
      { type: 'separator' }, { role: 'quit', label: '종료' },
    ] }, { role: 'editMenu' }]));
    desktop = new DesktopController();
    tray = new Tray(trayImage());
    tray.setToolTip('Desktop Companion · 돌멩이');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '패널 열기', click: () => desktop?.openPanel() },
      { label: '캐릭터 숨기기 / 표시', click: () => desktop?.toggleVisibility() },
      { label: '무음 알림 미리보기', click: () => desktop?.previewNotification() },
      { type: 'separator' }, { label: '종료', click: () => app.quit() },
    ]));
    powerMonitor.on('resume', () => desktop?.onResume());
  }).catch(error => { console.error(error); app.exit(1); });
}
app.on('before-quit', () => { desktop?.dispose(); tray?.destroy(); });
app.on('window-all-closed', () => {});
