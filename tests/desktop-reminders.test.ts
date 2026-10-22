import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type { CommandResult, CompanionState, Memo, Rect } from '../src/shared/contracts';
import type { AgentProvider } from '../src/main/ai/provider';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
// Bundle the real controller, domain functions and MemoService. Only Electron's
// native boundary is replaced, so IPC callbacks and disk writes are production code.
const controllerSource = buildSync({
  entryPoints: [join(project, 'src/main/desktop/controller.ts')],
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], write: false,
}).outputFiles[0].text;

interface StoredMemo extends Memo { reminder: { dueAt: number; acknowledged: boolean } | null }
type IpcEvent = { sender: FakeContents; senderFrame: object };
type Handler = (event: IpcEvent, value?: unknown) => unknown;
type Surface = 'widget' | 'panel' | 'chat';

class FakeContents extends EventEmitter {
  readonly mainFrame = {};
  readonly messages: { channel: string; value: unknown }[] = [];
  setWindowOpenHandler(_handler: unknown) {}
  isLoadingMainFrame() { return false; }
  send(channel: string, value?: unknown) {
    this.messages.push({ channel, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeContents();
  shown = false;
  ignored = true;
  private bounds: Rect;
  constructor(options: Rect) {
    super();
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
  }
  setAlwaysOnTop(..._values: unknown[]) {}
  setVisibleOnAllWorkspaces(..._values: unknown[]) {}
  setIgnoreMouseEvents(value: boolean, _options: unknown) { this.ignored = value; }
  isDestroyed() { return false; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds: Rect) { this.bounds = { ...bounds }; }
  setPosition(x: number, y: number) { this.bounds = { ...this.bounds, x, y }; }
  showInactive() { this.shown = true; }
  show() { this.shown = true; }
  hide() { this.shown = false; }
  focus() {}
  loadFile(..._values: unknown[]) {
    this.webContents.emit('did-finish-load');
    this.emit('ready-to-show');
    return Promise.resolve();
  }
}

function localTime(hour: number, minute: number, second = 0): number {
  return new Date(2026, 9, 20, hour, minute, second).getTime();
}

function memo(text: string, reminderTime: string, dueAt: number): StoredMemo {
  return { id: randomUUID(), date: '2026-10-20', text, reminderTime, completed: false,
    createdAt: localTime(8, 0), updatedAt: localTime(8, 0),
    reminder: { dueAt, acknowledged: false } };
}

function harness(directory: string, initialNow: number, agentProvider?: AgentProvider) {
  let now = initialNow;
  const intervals = new Set<() => void>();
  const events = new Map<string, Handler>();
  const handlers = new Map<string, Handler>();
  const screen = Object.assign(new EventEmitter(), {
    getPrimaryDisplay: () => display,
    getAllDisplays: () => [display],
    getDisplayNearestPoint: () => display,
    getDisplayMatching: () => display,
    getCursorScreenPoint: () => ({ x: -1000, y: -1000 }),
  });
  const display = { id: 1, label: '테스트 화면', workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  class ClockDate extends Date {
    constructor(value?: string | number) { super(value === undefined ? now : value); }
    static now() { return now; }
  }
  const shortcuts = new Map<string, () => void>();
  const menus: { items: { label: string; click: () => void }[]; closePopup(): void; select(label: string): void }[] = [];
  class FakeMenu {
    private onClose: (() => void) | null = null;
    constructor(readonly items: { label: string; click: () => void }[]) {}
    popup(options: { window: FakeWindow; callback: () => void }) { this.onClose = options.callback; menus.push(this); }
    closePopup() { const callback = this.onClose; this.onClose = null; callback?.(); }
    select(label: string) { const item = this.items.find(item => item.label === label); assert.ok(item); item.click(); this.closePopup(); }
  }
  const electron = {
    app: { getPath: () => directory, quit() {} },
    BrowserWindow: FakeWindow,
    Menu: { buildFromTemplate: (items: { label: string; click: () => void }[]) => new FakeMenu(items) },
    screen,
    globalShortcut: { register: (key: string, callback: () => void) => { shortcuts.set(key, callback); return true; }, isRegistered: (key: string) => shortcuts.has(key), unregister: (key: string) => { shortcuts.delete(key); }, unregisterAll() { shortcuts.clear(); } },
    ipcMain: {
      on: (channel: string, handler: Handler) => events.set(channel, handler),
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    },
  };
  const module = { exports: {} as { DesktopController: new (options?: { agentProvider?: AgentProvider }) => {
    widget: FakeWindow; panel: FakeWindow; chat: FakeWindow; onResume(): void; dispose(): void;
  } } };
  runInNewContext(controllerSource, {
    module, exports: module.exports,
    require: (name: string) => name === 'electron' ? electron : require(name),
    __dirname: join(project, 'src/main/desktop'), Date: ClockDate, Buffer, console, process, AbortController, setTimeout, clearTimeout,
    setInterval: (callback: () => void) => { intervals.add(callback); return callback; },
    clearInterval: (callback: () => void) => intervals.delete(callback),
  });
  const controller = new module.exports.DesktopController({ agentProvider });
  const filename = join(directory, 'memos.json');
  const event = (surface: Surface, subframe = false): IpcEvent => {
    const sender = controller[surface].webContents;
    return { sender, senderFrame: subframe ? {} : sender.mainFrame };
  };
  const invokeFrom = <T = CommandResult>(channel: string, value: unknown, source: IpcEvent): T => {
    const callback = handlers.get(`companion:${channel}`);
    assert.ok(callback, `IPC handle is registered: ${channel}`);
    return callback(source, value) as T;
  };
  const invoke = <T = CommandResult>(channel: string, value?: unknown, surface: Surface = (channel === 'agent-check' || ['chat-ask', 'chat-cancel', 'chat-new', 'chat-shortcut'].includes(channel)) ? 'chat' : 'panel'): T =>
    invokeFrom<T>(channel, value, event(surface));
  return {
    controller, screen, filename, event, invoke, invokeFrom, shortcuts, menus,
    state: (): CompanionState => JSON.parse(JSON.stringify(invoke<CompanionState>('state', undefined, 'widget'))),
    disk: (): { version: number; memos: StoredMemo[] } => JSON.parse(readFileSync(filename, 'utf8')),
    sendFrom(channel: string, value: unknown, source: IpcEvent) {
      const callback = events.get(`companion:${channel}`);
      assert.ok(callback, `IPC listener is registered: ${channel}`);
      callback(source, value);
    },
    send(channel: string, value?: unknown, surface: Surface = 'widget') {
      const callback = events.get(`companion:${channel}`);
      assert.ok(callback, `IPC listener is registered: ${channel}`);
      callback(event(surface), value);
    },
    now: () => now,
    hasListener: (channel: string) => events.has("companion:" + channel),
    hasHandler: (channel: string) => handlers.has("companion:" + channel),
    setNow(value: number) { now = value; },
    tick(milliseconds = 1000) { now += milliseconds; for (const callback of intervals) callback(); },
    dispose() { controller.dispose(); assert.equal(intervals.size, 0); },
  };
}

type Harness = ReturnType<typeof harness>;

function fixture(memos: StoredMemo[], run: (h: Harness, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'companion-desktop-reminders-'));
  writeFileSync(join(directory, 'memos.json'), JSON.stringify({ version: 3, memos }));
  const h = harness(directory, localTime(10, 0, 20));
  try { run(h, directory); }
  finally { h.dispose(); rmSync(directory, { recursive: true, force: true }); }
}

function reminder(h: Harness) {
  const bubble = h.state().bubble;
  assert.ok(bubble && bubble.kind === 'reminder', 'a real memo reminder is displayed');
  return bubble;
}

function showAlarm(h: Harness) {
  assert.equal(h.invoke('memo-add', { text: '조작 중 유지할 실제 예약 알림', reminderTime: null,
    schedule: { kind: 'once', dueAt: h.now() } }).ok, true);
  return reminder(h);
}

function close(h: Harness, id: string): CommandResult {
  return h.invoke('bubble-dismiss', id, 'widget');
}

test('native controller delivers due reminders in order, rejects a stale close, and persists acknowledgements', () => {
  const later = memo('두 번째', '09:59', localTime(9, 59));
  const earlier = memo('첫 번째', '09:58', localTime(9, 58));
  fixture([later, earlier], (h, directory) => {
    h.tick();
    const first = reminder(h);
    assert.equal(first.memoId, earlier.id);
    const unacknowledgedRestart = harness(directory, localTime(10, 5));
    try {
      unacknowledgedRestart.tick();
      assert.equal(reminder(unacknowledgedRestart).memoId, earlier.id);
      assert.equal(reminder(unacknowledgedRestart).dueAt, first.dueAt);
      assert.equal(unacknowledgedRestart.disk().memos.find(item => item.id === earlier.id)!.reminder!.acknowledged, false);
    } finally { unacknowledgedRestart.dispose(); }
    assert.equal(close(h, first.id).ok, true);
    const second = reminder(h);
    assert.equal(second.memoId, later.id);
    assert.notEqual(second.id, first.id);
    assert.equal(close(h, first.id).ok, true);
    assert.equal(reminder(h).id, second.id);
    assert.equal(h.disk().memos.find(item => item.id === later.id)!.reminder!.acknowledged, false);
    assert.equal(close(h, second.id).ok, true);
    assert.equal(h.state().bubble, null);
    assert.ok(h.disk().memos.every(item => item.reminder!.acknowledged));
    const restarted = harness(directory, localTime(11, 0));
    try { restarted.tick(); assert.equal(restarted.state().bubble, null); }
    finally { restarted.dispose(); }
  });
});

test('completing and reopening in the current minute cannot reuse the previous bubble identity', () => {
  const item = memo('현재 분', '10:00', localTime(10, 0));
  fixture([item], h => {
    h.tick();
    const previous = reminder(h);
    assert.equal(h.invoke('memo-complete', { id: item.id, completed: true }).ok, true);
    assert.equal(h.state().bubble, null);
    assert.equal(h.invoke('memo-complete', { id: item.id, completed: false }).ok, true);
    const current = reminder(h);
    assert.equal(current.dueAt, previous.dueAt);
    assert.notEqual(current.id, previous.id);
    close(h, previous.id);
    assert.equal(reminder(h).id, current.id);
    assert.equal(h.disk().memos[0].reminder!.acknowledged, false);
  });
});

test('hidden characters remain temporarily visible through the queue and return to hidden after the final close', () => {
  fixture([memo('첫 번째', '09:58', localTime(9, 58)), memo('두 번째', '09:59', localTime(9, 59))], h => {
    h.send('visibility');
    assert.equal(h.state().visible, false);
    assert.equal(h.controller.widget.shown, false);
    h.tick();
    assert.equal(h.state().userHidden, true);
    assert.equal(h.state().visible, true);
    assert.equal(h.controller.widget.shown, true);
    close(h, reminder(h).id);
    assert.equal(h.state().visible, true);
    assert.equal(h.state().userHidden, true);
    close(h, reminder(h).id);
    assert.equal(h.state().bubble, null);
    assert.equal(h.state().visible, false);
    assert.equal(h.controller.widget.shown, false);
  });
});

test('removed notification preview and briefing IPC are absent and inherited settings never schedule a notice', () => {
  fixture([memo('저장된 작업', '20:00', localTime(20, 0))], (h, directory) => {
    const file = join(directory, 'briefing.json');
    const original = JSON.stringify({ version: 1, settings: { enabled: true, beforeMinutes: 30 } });
    writeFileSync(file, original);
    const restarted = harness(directory, localTime(17, 30));
    try {
      assert.equal(restarted.hasHandler('briefing-settings'), false);
      assert.equal(restarted.hasListener('preview-notification'), false);
      restarted.invoke('work-schedule', { date: '2026-10-20', startTime: '09:00', endTime: '18:00' });
      restarted.tick();
      assert.equal(restarted.state().bubble, null);
      assert.equal(readFileSync(file, 'utf8'), original);
    } finally { restarted.dispose(); }
    writeFileSync(file, '{unreadable legacy feature settings');
    const corrupt = harness(directory, localTime(17, 30));
    try {
      corrupt.tick(); assert.equal(corrupt.state().bubble, null);
      assert.equal(readFileSync(file, 'utf8'), '{unreadable legacy feature settings');
    } finally { corrupt.dispose(); }
  });
});

test('a new alarm waits through a pointer gesture and dropping before native presentation', () => {
  fixture([memo('드래그 이후', '10:01', localTime(10, 1))], h => {
    h.send('pointer-begin', { x: 1300, y: 500 });
    h.tick(40_000);
    assert.equal(h.state().bubble, null);
    h.send('pointer-move', { x: 1400, y: 550 });
    assert.equal(h.state().motion, 'dragged');
    h.send('pointer-end', { x: 1400, y: 550 });
    assert.equal(h.state().motion, 'dropping');
    h.tick(100);
    assert.equal(h.state().bubble, null);
    h.tick(300);
    assert.equal(h.state().bubble, null);
    h.tick(1000);
    assert.equal(reminder(h).text, '10:01 · 드래그 이후');
    assert.equal(h.state().motion, 'notify');
  });
});

test('resume immediately catches up missed alarms and panel or display operations keep the notify pose', () => {
  fixture([memo('잠자기 중 알림', '10:01', localTime(10, 1))], h => {
    h.send('visibility');
    h.setNow(localTime(10, 5));
    h.controller.onResume();
    const active = reminder(h);
    assert.equal(h.state().motion, 'notify');
    assert.equal(h.state().visible, true);
    h.send('panel-open');
    assert.equal(h.state().panelOpen, true);
    assert.equal(h.state().motion, 'notify');
    h.screen.emit('display-metrics-changed');
    assert.equal(reminder(h).id, active.id);
    assert.equal(h.state().motion, 'notify');
    h.controller.onResume();
    assert.equal(reminder(h).id, active.id);
    assert.equal(h.state().motion, 'notify');
  });
});

test('acknowledgement write failure keeps the source bytes and bubble until a successful retry', () => {
  fixture([memo('확인 저장', '09:59', localTime(9, 59))], h => {
    h.tick();
    const active = reminder(h);
    const original = readFileSync(h.filename);
    const saved = `${h.filename}.saved`;
    renameSync(h.filename, saved);
    mkdirSync(h.filename); // A directory at the destination makes atomic rename fail.
    const failed = close(h, active.id);
    assert.equal(failed.ok, false);
    assert.equal(reminder(h).id, active.id);
    assert.match(h.state().reminderError!, /저장하지 못/);
    assert.deepEqual(readFileSync(saved), original);
    h.tick();
    assert.equal(reminder(h).id, active.id);
    assert.match(h.state().reminderError!, /저장하지 못/);
    rmSync(h.filename, { recursive: true });
    renameSync(saved, h.filename);
    assert.equal(close(h, active.id).ok, true);
    assert.equal(h.state().bubble, null);
    assert.equal(h.state().reminderError, null);
    assert.equal(h.disk().memos[0].reminder!.acknowledged, true);
  });
});

test('active text edits preserve the reservation while rescheduling, completing and deleting cancel the active bubble', () => {
  const item = memo('원본', '10:00', localTime(10, 0));
  fixture([item], h => {
    h.tick();
    const active = reminder(h);
    assert.equal(h.invoke('memo-update', { id: item.id, draft: { text: '수정한 본문', reminderTime: '10:00' } }).ok, true);
    assert.equal(reminder(h).id, active.id);
    assert.equal(reminder(h).text, '10:00 · 수정한 본문');
    assert.equal(h.disk().memos[0].reminder!.dueAt, active.dueAt);
    assert.equal(h.invoke('memo-update', { id: item.id, draft: { text: '내일이 아닌 미래', reminderTime: '11:00' } }).ok, true);
    assert.equal(h.state().bubble, null);
    assert.equal(h.disk().memos[0].reminder!.dueAt, localTime(11, 0));
    assert.equal(h.invoke('memo-update', { id: item.id, draft: { text: '다시 현재 분', reminderTime: '10:00' } }).ok, true);
    reminder(h);
    assert.equal(h.invoke('memo-complete', { id: item.id, completed: true }).ok, true);
    assert.equal(h.state().bubble, null);
    assert.equal(h.disk().memos[0].reminder, null);
    assert.equal(h.invoke('memo-complete', { id: item.id, completed: false }).ok, true);
    reminder(h);
    assert.equal(h.invoke('memo-delete', item.id).ok, true);
    assert.equal(h.state().bubble, null);
    assert.equal(h.disk().memos.length, 0);
  });
});

test('only the trusted widget main frame can acknowledge the current bubble through IPC', () => {
  fixture([memo('IPC 확인', '09:59', localTime(9, 59))], h => {
    h.tick();
    const active = reminder(h);
    assert.equal(h.invoke('bubble-dismiss', active.id, 'panel').ok, false);
    assert.equal(h.invokeFrom('bubble-dismiss', active.id, h.event('widget', true)).ok, false);
    const foreign = new FakeContents();
    assert.equal(h.invokeFrom('bubble-dismiss', active.id, { sender: foreign, senderFrame: foreign.mainFrame }).ok, false);
    assert.equal(h.invoke('bubble-dismiss', null, 'widget').ok, false);
    assert.equal(close(h, 'stale-bubble').ok, true);
    assert.equal(reminder(h).id, active.id);
    assert.equal(h.disk().memos[0].reminder!.acknowledged, false);
    assert.equal(close(h, active.id).ok, true);
    assert.equal(h.state().bubble, null);
    assert.equal(h.disk().memos[0].reminder!.acknowledged, true);
  });
});


const chatSettled = () => new Promise<void>(resolve => setImmediate(resolve));
async function chatFixture(run: (h: Harness, reply: (text: string) => void, signals: AbortSignal[]) => Promise<void>, memos: StoredMemo[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-desktop-chat-'));
  writeFileSync(join(directory, 'memos.json'), JSON.stringify({ version: 3, memos }));
  let reply!: (text: string) => void;
  const signals: AbortSignal[] = [];
  const provider: AgentProvider = { id: 'fixture', label: '테스트 AI',
    checkConnection: async () => ({ status: 'ready', message: '연결됨' }),
    ask: ({ signal }) => { signals.push(signal); return new Promise<string>(resolve => { reply = resolve; }); },
  };
  const h = harness(directory, localTime(10, 0, 20), provider);
  try {
    assert.equal((await h.invoke<Promise<CommandResult>>('agent-check')).ok, true);
    await run(h, text => reply(text), signals);
  } finally { h.dispose(); rmSync(directory, { recursive: true, force: true }); }
}

test('trusted dedicated chat requests publish an answer in the conversation and a dismissible character bubble', async () => {
  await chatFixture(async (h, reply) => {
    h.send('chat-open', undefined, 'chat');
    assert.equal(h.invoke('chat-ask', '질문').ok, true);
    assert.equal(h.state().chat.status, 'thinking');
    reply('짧은 답변');
    await chatSettled();
    assert.equal(h.state().chat.answer, '짧은 답변');
    assert.equal(h.state().bubble?.kind, 'chat');
    assert.equal(h.state().bubble?.text, '짧은 답변');
    assert.equal(h.state().chatOpen, true, 'answer presentation keeps the chat window open');
    assert.equal(close(h, h.state().bubble!.id).ok, true);
    assert.equal(h.state().bubble, null);
    assert.equal(h.state().chat.answer, '짧은 답변', 'closing the bubble preserves the panel answer');
  });
});

test('an unacknowledged memo keeps priority while a completed AI answer waits', async () => {
  const item = memo('먼저 확인할 메모', '09:59', localTime(9, 59));
  await chatFixture(async (h, reply) => {
    h.tick();
    const active = reminder(h);
    h.invoke('chat-ask', '질문');
    reply('기다리는 AI 답변');
    await chatSettled();
    assert.equal(reminder(h).id, active.id);
    assert.equal(h.state().chat.answer, '기다리는 AI 답변');
    assert.equal(h.disk().memos[0].reminder!.acknowledged, false);
    close(h, active.id);
    assert.equal(h.disk().memos[0].reminder!.acknowledged, true);
    assert.equal(h.state().bubble?.kind, 'chat');
    assert.equal(h.state().bubble?.text, '기다리는 AI 답변');
  }, [item]);
});

test('a newly due memo interrupts the AI bubble and the answer returns after acknowledgement', async () => {
  const item = memo('곧 알림', '10:01', localTime(10, 1));
  await chatFixture(async (h, reply) => {
    h.invoke('chat-ask', '질문'); reply('다시 보여줄 답변'); await chatSettled();
    const chatId = h.state().bubble!.id;
    h.tick(40_000);
    const active = reminder(h);
    close(h, chatId);
    assert.equal(reminder(h).id, active.id, 'stale answer close cannot acknowledge a memo');
    close(h, active.id);
    assert.equal(h.state().bubble?.kind, 'chat');
    assert.equal(h.state().bubble?.text, '다시 보여줄 답변');
  }, [item]);
});

test('AI bubble waits until pointer interaction settles and temporarily reveals a hidden character', async () => {
  await chatFixture(async (h, reply) => {
    h.invoke('chat-ask', '질문');
    h.send('pointer-begin', { x: 1300, y: 500 });
    h.send('pointer-move', { x: 1400, y: 550 });
    reply('놓기 후 답변'); await chatSettled();
    assert.equal(h.state().bubble?.kind, 'chat-loading');
    assert.equal(h.state().motion, 'dragged');
    h.send('pointer-end', { x: 1400, y: 550 });
    h.tick(1500);
    assert.equal(h.state().bubble?.kind, 'chat-loading');
    h.tick(1000);
    assert.equal(h.state().bubble?.kind, 'chat');
    close(h, h.state().bubble!.id);
    h.invoke('chat-ask', '다음 질문');
    h.send('visibility');
    assert.equal(h.state().visible, false);
    reply('숨김 중 답변'); await chatSettled();
    assert.equal(h.state().userHidden, true);
    assert.equal(h.state().visible, true);
    close(h, h.state().bubble!.id);
    assert.equal(h.state().visible, false);
  });
});

test('only trusted chat main frames may ask or reset, while widgets may cancel the current request', async () => {
  await chatFixture(async (h, _reply, signals) => {
    const foreign = new FakeContents();
    for (const channel of ['agent-check', 'chat-ask', 'chat-new']) {
      assert.equal(h.invoke(channel, '질문', 'widget').ok, false);
      assert.equal(h.invoke(channel, '질문', 'panel').ok, false);
      assert.equal(h.invokeFrom(channel, '질문', h.event('chat', true)).ok, false);
      assert.equal(h.invokeFrom(channel, '질문', { sender: foreign, senderFrame: foreign.mainFrame }).ok, false);
    }
    assert.equal(h.invoke('chat-ask', {}).ok, false);
    assert.equal(h.invoke('chat-ask', '정상 질문').ok, true);
    assert.equal(signals.length, 1);
    assert.equal(h.invoke('chat-cancel', h.state().chat.requestId, 'panel').ok, false);
    assert.equal(h.invokeFrom('chat-cancel', h.state().chat.requestId, h.event('widget', true)).ok, false);
    assert.equal(h.invoke('chat-cancel', h.state().chat.requestId, 'widget').ok, true);
    assert.equal(signals[0].aborted, true);
    assert.equal(h.state().chat.status, 'cancelled');
  });
});

test('cancelling and beginning another question drops a pending older answer without touching memo state', async () => {
  const item = memo('메모 유지', '09:59', localTime(9, 59));
  await chatFixture(async (h, reply) => {
    h.tick();
    const alarm = reminder(h);
    h.invoke('chat-ask', '첫 질문'); reply('대기 중 이전 답변'); await chatSettled();
    h.invoke('chat-ask', '다음 질문');
    const requestId = h.state().chat.requestId!;
    assert.equal(h.invoke('chat-cancel', requestId).ok, true);
    reply('취소 뒤 늦은 답변'); await chatSettled();
    assert.equal(h.state().chat.status, 'cancelled');
    close(h, alarm.id);
    assert.equal(h.state().bubble, null, 'neither old pending nor cancelled replies appear');
    assert.equal(h.disk().memos.length, 1);
    assert.equal(h.disk().memos[0].text, '메모 유지');
  }, [item]);
});

test('loading bubble is immediate and quiet, can be folded without cancelling, and becomes a completed answer', async () => {
  await chatFixture(async (h, reply, signals) => {
    h.invoke('chat-ask', '로딩 확인');
    const loading = h.state().bubble!;
    assert.equal(loading.kind, 'chat-loading');
    assert.equal(h.state().motion, 'idle', 'waiting does not repeatedly jump');
    h.tick(1);
    assert.equal(h.state().bubble!.id, loading.id);
    close(h, loading.id);
    h.tick(2000);
    assert.equal(h.state().bubble, null, 'folded loading must not reappear on each timer tick');
    assert.equal(signals[0].aborted, false, 'folding the indicator is different from cancellation');
    reply('생성 완료'); await chatSettled();
    assert.equal(h.state().bubble?.kind, 'chat');
    assert.equal(h.state().bubble?.text, '생성 완료');
    close(h, loading.id);
    assert.equal(h.state().bubble?.kind, 'chat', 'stale loading close cannot dismiss the completed answer');
  });
});

test('memo alarms suppress loading and restore the latest pending answer rather than stale loading', async () => {
  await chatFixture(async (h, reply) => {
    h.invoke('chat-ask', '생성 중');
    assert.equal(h.state().bubble?.kind, 'chat-loading');
    h.tick(40_000);
    const alarm = reminder(h);
    reply('로딩 대신 답변'); await chatSettled();
    assert.equal(reminder(h).id, alarm.id);
    close(h, alarm.id);
    assert.equal(h.state().bubble?.kind, 'chat');
    assert.equal(h.state().bubble?.text, '로딩 대신 답변');
  }, [memo('우선 알림', '10:01', localTime(10, 1))]);
});

test('closing the dedicated chat window keeps its active request and conversation for reopening', async () => {
  await chatFixture(async (h, reply, signals) => {
    h.send('chat-open');
    assert.equal(h.state().chatOpen, true);
    assert.equal(h.controller.chat.shown, true);
    h.invoke('chat-ask', '창 닫기');
    const conversation = h.state().chat.conversationId;
    h.send('chat-close', undefined, 'chat');
    assert.equal(h.state().chatOpen, false);
    assert.equal(signals[0].aborted, false);
    reply('닫아도 완료'); await chatSettled();
    assert.equal(h.state().chat.messages.length, 2);
    h.send('chat-open');
    assert.equal(h.state().chat.conversationId, conversation);
    assert.equal(h.state().chat.answer, '닫아도 완료');
    assert.ok(h.controller.chat.webContents.messages.some(message => message.channel === 'companion:chat-focus'));
    assert.equal(h.invoke('memo-add', { text: '거절', reminderTime: null }, 'chat').ok, false, 'chat cannot change work data');
    assert.equal(h.invoke('work-schedule', { date: '2026-10-20', startTime: '09:00', endTime: '18:00' }, 'chat').ok, false);
  });
});

test('new conversation removes loading, pending answers and visible history while preserving memos', async () => {
  await chatFixture(async (h, reply, signals) => {
    h.invoke('chat-ask', '첫 질문');
    assert.equal(h.state().bubble?.kind, 'chat-loading');
    const old = h.state().chat.conversationId;
    assert.equal(h.invoke('chat-new').ok, true);
    assert.equal(signals[0].aborted, true);
    assert.equal(h.state().bubble, null);
    reply('초기화 후 늦은 답변'); await chatSettled(); h.tick();
    assert.deepEqual(h.state().chat.messages, []);
    assert.notEqual(h.state().chat.conversationId, old);
    assert.equal(h.state().bubble, null);
    assert.equal(h.disk().memos.length, 1);
    h.invoke('chat-ask', '새 질문'); reply('새 답변'); await chatSettled();
    assert.equal(h.state().bubble?.kind, 'chat');
    h.invoke('chat-new');
    assert.equal(h.state().bubble, null);
    assert.deepEqual(h.state().chat.messages, []);
  }, [memo('보존 메모', '11:00', localTime(11, 0))]);
});

test('chat shortcut has an independent callback and cannot replace the visibility shortcut', async () => {
  await chatFixture(async (h) => {
    const initial = h.state();
    assert.equal(initial.chatShortcutRegistered, true);
    assert.equal(h.invoke('chat-shortcut', initial.shortcut).ok, false);
    assert.equal(h.state().chatShortcut, initial.chatShortcut);
    assert.equal(h.invoke('shortcut', initial.chatShortcut).ok, false);
    h.shortcuts.get(initial.chatShortcut)!();
    assert.equal(h.state().chatOpen, true);
    assert.equal(h.invoke('chat-shortcut', 'Command+Alt+J').ok, true);
    assert.equal(h.shortcuts.has(initial.chatShortcut), false);
    assert.equal(h.shortcuts.has(initial.shortcut), true);
    h.shortcuts.get(initial.shortcut)!();
    assert.equal(h.state().chatOpen, false);
    assert.equal(h.state().visible, false);
    h.shortcuts.get('Command+Alt+J')!();
    assert.equal(h.state().chatOpen, true);
  });
});


test('a character click opens the existing conversation while a real drag only moves the character', () => {
  fixture([], h => {
    h.send('pointer-begin', { x: 1300, y: 500 });
    h.send('pointer-end', { x: 1302, y: 502 });
    assert.equal(h.state().chatOpen, true);
    assert.equal(h.state().panelOpen, false);
    const conversationId = h.state().chat.conversationId;
    h.send('chat-close', undefined, 'chat');
    h.send('pointer-begin', { x: 1300, y: 500 });
    h.send('pointer-end', { x: 1400, y: 550 });
    assert.equal(h.state().chatOpen, false);
    assert.equal(h.state().motion, 'dropping');
    assert.equal(h.state().chat.conversationId, conversationId);
  });
});

test('native context menu is widget-only, pauses movement and targets each requested panel even on repeated selection', () => {
  fixture([], h => {
    h.send('context-menu', undefined, 'panel');
    h.send('context-menu', undefined, 'chat');
    h.sendFrom('context-menu', undefined, h.event('widget', true));
    assert.equal(h.menus.length, 0);
    h.send('context-menu');
    const menu = h.menus[0];
    assert.deepEqual(Array.from(menu.items, item => item.label), ['대화하기', '근무시간', '메모', '캐릭터 설정', '설정']);
    const origin = h.controller.widget.getBounds();
    h.tick(3000);
    assert.deepEqual(h.controller.widget.getBounds(), origin);
    h.send('context-menu');
    assert.equal(h.menus.length, 1);
    h.send('pointer-begin', { x: 1300, y: 500 });
    h.send('pointer-end', { x: 1300, y: 500 });
    assert.equal(h.state().chatOpen, false);
    menu.select('메모');
    assert.equal(h.state().panelOpen, true);
    assert.equal(h.state().panelNavigation?.tab, 'memos');
    const firstSequence = h.state().panelNavigation!.sequence;
    h.send('context-menu'); h.menus.at(-1)!.select('근무시간');
    assert.equal(h.state().panelNavigation?.tab, 'work');
    h.send('context-menu'); h.menus.at(-1)!.select('메모');
    assert.ok(h.state().panelNavigation!.sequence > firstSequence);
    h.send('context-menu'); h.menus.at(-1)!.select('대화하기');
    assert.equal(h.state().chatOpen, true);
    h.send('panel-close'); h.send('chat-close', undefined, 'chat');
    h.tick(2500);
    assert.notDeepEqual(h.controller.widget.getBounds(), origin);
  });
});

test('cancelling a menu resumes movement and a due reminder waits until menu dismissal', () => {
  fixture([memo('선택 이후', '10:01', localTime(10, 1))], h => {
    h.send('context-menu');
    const menu = h.menus[0];
    h.tick(40000);
    assert.equal(h.state().bubble, null);
    menu.closePopup();
    assert.equal(reminder(h).text.includes('선택 이후'), true);
    assert.equal(h.state().panelOpen, false);
    assert.equal(h.state().chatOpen, false);
    close(h, reminder(h).id);
    const origin = h.controller.widget.getBounds();
    h.tick(2500);
    assert.notDeepEqual(h.controller.widget.getBounds(), origin);
  });
});

test('memo bubble navigation preserves the alarm and never acknowledges or completes it', () => {
  fixture([memo('확인 유지', '10:00', localTime(10, 0))], h => {
    h.tick();
    const bubble = reminder(h);
    h.send('bubble-activate', bubble.id, 'panel');
    h.sendFrom('bubble-activate', bubble.id, h.event('widget', true));
    h.send('bubble-activate', 'obsolete-id');
    assert.equal(h.state().panelOpen, false);
    h.send('bubble-activate', bubble.id);
    assert.equal(h.state().panelNavigation?.tab, 'memos');
    assert.equal(reminder(h).id, bubble.id);
    assert.equal(h.disk().memos[0].reminder!.acknowledged, false);
    assert.equal(h.disk().memos[0].completed, false);
    const sequence = h.state().panelNavigation!.sequence;
    h.send('bubble-activate', bubble.id);
    assert.equal(h.state().panelNavigation!.sequence, sequence + 1);
  });
});

test('AI bubble navigation preserves the active request and history and stale bubbles do nothing', async () => {
  await chatFixture(async (h, reply) => {
    h.send('bubble-activate', 'obsolete-bubble');
    assert.equal(h.state().chatOpen, false);
    h.invoke('chat-ask', '기억할 질문');
    const loading = h.state().bubble!;
    assert.equal(loading.kind, 'chat-loading');
    h.send('bubble-activate', loading.id);
    assert.equal(h.state().chatOpen, true);
    assert.equal(h.state().chat.status, 'thinking');
    assert.equal(h.state().chat.messages.length, 1);
    h.send('chat-close', undefined, 'chat');
    reply('기억할 답변'); await chatSettled();
    const answer = h.state().bubble!;
    assert.equal(answer.kind, 'chat');
    h.send('bubble-activate', loading.id);
    assert.equal(h.state().chatOpen, false);
    h.send('bubble-activate', answer.id);
    assert.equal(h.state().chatOpen, true);
    assert.equal(h.state().bubble!.id, answer.id);
    assert.equal(h.state().chat.messages.length, 2);
  });
});

test('only the chat main frame can change the conversation shortcut', () => {
  fixture([], h => {
    const before = h.state().chatShortcut;
    assert.equal(h.invoke('chat-shortcut', 'Command+Alt+K', 'panel').ok, false);
    assert.equal(h.invoke('chat-shortcut', 'Command+Alt+K', 'widget').ok, false);
    assert.equal(h.invokeFrom<CommandResult>('chat-shortcut', 'Command+Alt+K', h.event('chat', true)).ok, false);
    assert.equal(h.state().chatShortcut, before);
    assert.equal(h.invoke('chat-shortcut', 'Command+Alt+K', 'chat').ok, true);
    assert.equal(h.state().chatShortcut, 'Command+Alt+K');
  });
});


test('a reminder becoming due inside a menu cannot hide the selected panel regardless of native callback ordering', () => {
  for (const callbackFirst of [true, false]) {
    for (const tab of ['work', 'memos'] as const) {
      fixture([memo('선택 유지', '10:01', localTime(10, 1))], h => {
        h.send('context-menu'); const menu = h.menus[0];
        h.tick(40000); assert.equal(h.state().bubble, null);
        if (callbackFirst) menu.closePopup();
        menu.select(tab === 'work' ? '근무시간' : '메모');
        assert.equal(h.state().panelOpen, true);
        assert.equal(h.state().panelNavigation?.tab, tab);
        assert.equal(reminder(h).text.includes('선택 유지'), true);
        assert.equal(h.disk().memos[0].reminder!.acknowledged, false);
      });
    }
  }
});

test('AI command planning reaches the real memo service and stores only the verified result in conversation history', async () => {
  await chatFixture(async (h, reply) => {
    h.invoke('chat-ask', '30분 뒤 회의 알려줘');
    reply(JSON.stringify({ kind: 'command', command: { name: 'memo.add', text: 'AI로 추가한 회의', reminder: { kind: 'after', minutes: 30 } } }));
    await chatSettled();
    assert.equal(h.disk().memos.length, 1);
    assert.equal(h.disk().version, 5);
    assert.equal(h.disk().memos[0].text, 'AI로 추가한 회의');
    assert.match(h.state().chat.answer!, /메모를 추가했어요/);
    assert.doesNotMatch(h.state().chat.messages.at(-1)!.text, /"kind"|"command"/);
    assert.equal(h.invoke('memo-add', { text: '직접 IPC는 거절', reminderTime: null }, 'chat').ok, false);
    h.invoke('chat-ask', '남은 메모를 보여줘');
    reply(JSON.stringify({ kind: 'command', command: { name: 'memo.list', completed: false } })); await chatSettled();
    assert.match(h.state().chat.answer!, /AI로 추가한 회의/);
  });
});

test('cancelled or reset AI command replies cannot mutate real memo storage', async () => {
  await chatFixture(async (h, reply) => {
    h.invoke('chat-ask', '추가를 취소할 질문');
    h.invoke('chat-cancel', h.state().chat.requestId);
    reply(JSON.stringify({ kind: 'command', command: { name: 'memo.add', text: '늦은 명령' } })); await chatSettled();
    assert.equal(h.disk().memos.length, 0);
    h.invoke('chat-ask', '새 대화 전에 보낸 질문'); h.invoke('chat-new');
    reply(JSON.stringify({ kind: 'command', command: { name: 'memo.add', text: '초기화 뒤 명령' } })); await chatSettled();
    assert.equal(h.disk().memos.length, 0); assert.deepEqual(h.state().chat.messages, []);
  });
});

test('appearance changes resize a real controller window, preserve feet and notices, and survive restart', () => fixture([], (h, directory) => {
  showAlarm(h); const bubble = h.state().bubble;
  const before = h.controller.widget.getBounds();
  assert.equal(h.invoke('appearance', { scale: 1.5, characterId: 'rock' }).ok, true);
  const after = h.controller.widget.getBounds();
  assert.equal(after.width, 420); assert.equal(after.height, 450);
  assert.equal(before.x + before.width / 2, after.x + after.width / 2);
  assert.equal(before.y + before.height - 34, after.y + after.height - 51);
  assert.deepEqual(h.state().bubble, bubble);
  const restarted = harness(directory, localTime(10, 5));
  try { assert.equal(restarted.state().appearance.scale, 1.5); assert.equal(restarted.controller.widget.getBounds().width, 420); }
  finally { restarted.dispose(); }
}));

test('appearance IPC accepts only validated values from the panel main frame', () => fixture([], (h, directory) => {
  const before = h.controller.widget.getBounds();
  for (const surface of ['widget', 'chat'] as const) assert.equal(h.invoke('appearance', { scale: 1.5, characterId: 'rock' }, surface).ok, false);
  assert.equal(h.invokeFrom<CommandResult>('appearance', { scale: 1.5, characterId: 'rock' }, h.event('panel', true)).ok, false);
  for (const value of [{ scale: NaN, characterId: 'rock' }, { scale: 9, characterId: 'rock' }, { scale: '1.5', characterId: 'rock' }, { scale: 1.5, characterId: 'rock', executable: 'anything' }]) assert.equal(h.invoke('appearance', value).ok, false);
  assert.deepEqual(h.controller.widget.getBounds(), before);
  assert.equal(h.state().appearance.scale, 1);
  h.send('context-menu'); h.menus.at(-1)!.select('캐릭터 설정');
  assert.equal(h.state().panelNavigation?.tab, 'appearance');
}));

test('appearance size is retained after drag, display changes and constrained displays', () => fixture([], h => {
  h.invoke('appearance', { scale: 1.5, characterId: 'rock' });
  h.send('pointer-begin', { x: 300, y: 300 }); h.send('pointer-end', { x: 400, y: 400 });
  assert.equal(h.controller.widget.getBounds().width, 420);
  const display = h.screen.getPrimaryDisplay();
  display.workArea = { x: -500, y: -300, width: 210, height: 220 };
  h.screen.emit('display-metrics-changed');
  const small = h.controller.widget.getBounds();
  assert.equal(small.width, 210); assert.equal(small.height, 220); assert.equal(h.state().appearance.scale, 1.5);
  display.workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  h.screen.emit('display-metrics-changed');
  assert.equal(h.controller.widget.getBounds().width, 420); assert.equal(h.controller.widget.getBounds().height, 450);
}));

test('failed appearance storage cannot resize the widget or claim success and retry remains possible', () => fixture([], (h, directory) => {
  h.invoke('appearance', { scale: 1.25, characterId: 'rock' }); const bounds = h.controller.widget.getBounds();
  const file = join(directory, 'appearance.json'), backup = file + '.preserved';
  const original = readFileSync(file, 'utf8'); renameSync(file, backup); mkdirSync(file);
  try {
    assert.equal(h.invoke('appearance', { scale: 1.5, characterId: 'rock' }).ok, false);
    assert.equal(h.state().appearance.scale, 1.25); assert.deepEqual(h.controller.widget.getBounds(), bounds);
    assert.equal(readFileSync(backup, 'utf8'), original);
  } finally { rmSync(file, { recursive: true }); renameSync(backup, file); }
  assert.equal(h.invoke('appearance', { scale: 1.5, characterId: 'rock' }).ok, true);
}));

test('corrupt appearance preferences preserve their bytes and do not prevent ordinary memo operations', () => fixture([], (h, directory) => {
  const file = join(directory, 'appearance.json'); writeFileSync(file, '{invalid original');
  const restarted = harness(directory, localTime(10, 5));
  try {
    assert.ok(restarted.state().appearanceError); assert.equal(restarted.state().appearance.scale, 1);
    assert.equal(restarted.invoke('appearance', { scale: 1.5, characterId: 'rock' }).ok, false);
    assert.equal(readFileSync(file, 'utf8'), '{invalid original');
    assert.equal(restarted.invoke('memo-add', { text: '계속 사용 가능한 메모', reminderTime: null }).ok, true);
  } finally { restarted.dispose(); }
}));


test('choosing the already active appearance does not discard a stationary click region', () => fixture([], h => {
  h.send('walking', false, 'panel'); const bounds = h.controller.widget.getBounds();
  h.screen.getCursorScreenPoint = () => ({ x: bounds.x + 100, y: bounds.y + 200 });
  h.send('hit-regions', [{ type: 'rect', rect: { x: 90, y: 190, width: 30, height: 30 } }]); h.tick();
  assert.equal(h.controller.widget.ignored, false);
  assert.equal(h.invoke('appearance', { scale: 1, characterId: 'rock' }).ok, true); h.tick();
  assert.equal(h.controller.widget.ignored, false);
}));


test('switching characters at the same scale preserves notices and history and restores the selected character', () => fixture([], (h, directory) => {
  h.invoke('appearance', { scale: 1.25, characterId: 'rock' }); showAlarm(h);
  const bubble = h.state().bubble, bounds = h.controller.widget.getBounds(), chat = h.state().chat;
  assert.equal(h.invoke('appearance', { scale: 1.25, characterId: 'cat' }).ok, true);
  assert.deepEqual(h.state().appearance, { scale: 1.25, characterId: 'cat' });
  assert.deepEqual(h.state().bubble, bubble); assert.deepEqual(h.state().chat, chat); assert.deepEqual(h.controller.widget.getBounds(), bounds);
  assert.equal(h.invoke('appearance', { scale: 1.25, characterId: 'unknown' }).ok, false);
  const restarted = harness(directory, localTime(10, 5));
  try { assert.deepEqual(restarted.state().appearance, { scale: 1.25, characterId: 'cat' }); }
  finally { restarted.dispose(); }
}));


test('Chelsea selection survives restart without changing existing memo and work files', () => fixture([memo('existing task', '11:00', localTime(11, 0))], (h, directory) => {
  assert.equal(h.invoke('work-schedule', { date: '2026-10-20', startTime: '09:00', endTime: '18:00' }).ok, true);
  showAlarm(h); const bubble = h.state().bubble;
  const memoFile = readFileSync(h.filename, 'utf8');
  const workFile = readFileSync(join(directory, 'worktime.json'), 'utf8');
  assert.equal(h.invoke('appearance', { scale: 1.25, characterId: 'chelsea' }).ok, true);
  assert.deepEqual(h.state().appearance, { scale: 1.25, characterId: 'chelsea' });
  assert.deepEqual(h.state().bubble, bubble);
  assert.equal(readFileSync(h.filename, 'utf8'), memoFile);
  assert.equal(readFileSync(join(directory, 'worktime.json'), 'utf8'), workFile);
  const restarted = harness(directory, localTime(10, 5));
  try { assert.deepEqual(restarted.state().appearance, { scale: 1.25, characterId: 'chelsea' }); }
  finally { restarted.dispose(); }
}));

function walkPet(h: Harness) {
  let sawTurn = false;
  for (let i = 0; i < 300; i += 1) {
    h.tick(50);
    if (h.state().pet?.activity === 'turn') sawTurn = true;
    if (h.state().pet?.activity === 'walk') {
      assert.ok(sawTurn, 'a pet turns before it starts translating');
      h.tick(250);
      return;
    }
  }
  assert.fail(h.state().appearance.characterId + ' did not begin walking');
}

for (const characterId of ['chelsea', 'chuchu'] as const) {
  test(characterId + ' pauses for chat, menus, panels and reminders, then resumes from the same position', () => fixture([], h => {
    assert.equal(h.invoke('appearance', { scale: 1, characterId }).ok, true);
    walkPet(h);
    h.send('chat-open');
    const chatPosition = h.controller.widget.getBounds();
    for (let i = 0; i < 100; i += 1) h.tick(50);
    assert.deepEqual(h.controller.widget.getBounds(), chatPosition);
    assert.equal(h.state().motion, 'idle');
    assert.equal(h.state().pet?.activity, 'idle');
    assert.equal(h.state().pet?.speed, 0);
    h.send('chat-close', undefined, 'chat');
    h.tick(50);
    assert.deepEqual(h.controller.widget.getBounds(), chatPosition);
    walkPet(h);
    h.send('context-menu');
    const menuPosition = h.controller.widget.getBounds();
    for (let i = 0; i < 100; i += 1) h.tick(50);
    assert.deepEqual(h.controller.widget.getBounds(), menuPosition);
    assert.equal(h.state().pet?.activity, 'idle');
    h.menus.at(-1)!.closePopup();
    h.tick(50);
    assert.deepEqual(h.controller.widget.getBounds(), menuPosition);
    walkPet(h);
    h.send('panel-open', 'memos');
    const panelPosition = h.controller.widget.getBounds();
    for (let i = 0; i < 100; i += 1) h.tick(50);
    assert.deepEqual(h.controller.widget.getBounds(), panelPosition);
    assert.equal(h.state().pet?.activity, 'idle');
    h.send('panel-close');
    walkPet(h);
    showAlarm(h);
    const alertPosition = h.controller.widget.getBounds();
    for (let i = 0; i < 100; i += 1) h.tick(50);
    assert.deepEqual(h.controller.widget.getBounds(), alertPosition);
    assert.equal(h.state().motion, 'notify');
    assert.equal(h.state().pet?.speed, 0);
    close(h, h.state().bubble!.id);
    h.tick(50);
    assert.deepEqual(h.controller.widget.getBounds(), alertPosition);
  }));

  test(characterId + ' keeps the drop height, stops actual travel when disabled, and leaves legacy motion unchanged', () => fixture([], h => {
    h.invoke('appearance', { scale: 1.25, characterId });
    walkPet(h);
    h.send('pointer-begin', { x: 1_300, y: 500 });
    h.send('pointer-end', { x: 1_400, y: 400 });
    const dropped = h.controller.widget.getBounds();
    assert.equal(h.state().motion, 'dropping');
    for (let i = 0; i < 20; i += 1) h.tick(50);
    assert.deepEqual(h.controller.widget.getBounds(), dropped);
    assert.ok(dropped.y < 1_080 - dropped.height, 'there is no snap back to the display floor');
    h.send('walking', false, 'panel');
    const stationary = h.controller.widget.getBounds();
    const activities = new Set<string>();
    for (let i = 0; i < 1_500; i += 1) { h.tick(50); activities.add(h.state().pet!.activity); }
    assert.deepEqual(h.controller.widget.getBounds(), stationary);
    assert.ok(activities.has('groom') && activities.has('stretch') && activities.has('sleep'));
    h.invoke('appearance', { scale: 1.25, characterId: 'rock' });
    assert.equal(h.state().pet, undefined);
    h.send('walking', true, 'panel');
    const beforeLegacy = h.controller.widget.getBounds();
    h.tick(2_500);
    assert.equal(h.state().motion, 'walking');
    assert.notDeepEqual(h.controller.widget.getBounds(), beforeLegacy);
  }));

  test(characterId + ' snapshots publish gait updates at a bounded rate and survive a suspended clock without jumping', () => fixture([], h => {
    h.invoke('appearance', { scale: 1, characterId });
    walkPet(h);
    const sent = h.controller.widget.webContents.messages.length;
    let distance = h.state().pet!.distance;
    for (let i = 0; i < 30; i += 1) {
      h.tick(1_000 / 30);
      const pet = h.state().pet!;
      assert.ok(pet.distance >= distance);
      distance = pet.distance;
    }
    assert.ok(h.controller.widget.webContents.messages.length - sent <= 11, 'walking does not send full app state at every render frame');
    const beforeSuspend = h.controller.widget.getBounds();
    h.tick(60_000);
    assert.deepEqual(h.controller.widget.getBounds(), beforeSuspend);
    assert.equal(h.state().pet?.activity, 'idle');
    assert.equal(h.state().pet?.distance, 0);
    assert.equal(h.state().pet?.speed, 0);
  }));

}

test('Chuchu selection survives restart while preserving existing work, memos, notices and chat', () => fixture([memo('existing task', '11:00', localTime(11, 0))], (h, directory) => {
  h.invoke('work-schedule', { date: '2026-10-20', startTime: '09:00', endTime: '18:00' });
  h.invoke('appearance', { scale: 0.75, characterId: 'chelsea' });
  showAlarm(h);
  const before = { bubble: h.state().bubble, chat: h.state().chat,
    memos: readFileSync(h.filename, 'utf8'), work: readFileSync(join(directory, 'worktime.json'), 'utf8') };
  assert.equal(h.invoke('appearance', { scale: 0.75, characterId: 'chuchu' }).ok, true);
  assert.deepEqual(h.state().appearance, { scale: 0.75, characterId: 'chuchu' });
  assert.deepEqual(h.state().bubble, before.bubble);
  assert.deepEqual(h.state().chat, before.chat);
  assert.equal(h.state().pet?.activity, 'idle');
  assert.equal(readFileSync(h.filename, 'utf8'), before.memos);
  assert.equal(readFileSync(join(directory, 'worktime.json'), 'utf8'), before.work);
  const restarted = harness(directory, localTime(10, 5));
  try {
    assert.deepEqual(restarted.state().appearance, { scale: 0.75, characterId: 'chuchu' });
    assert.equal(restarted.state().pet?.activity, 'idle');
    assert.equal(readFileSync(h.filename, 'utf8'), before.memos);
    assert.equal(readFileSync(join(directory, 'worktime.json'), 'utf8'), before.work);
  } finally { restarted.dispose(); }
}));

test('switching from a walking Chelsea to Chuchu discards the prior destination at the current position', () => fixture([], h => {
  h.invoke('appearance', { scale: 1.25, characterId: 'chelsea' });
  walkPet(h);
  const position = h.controller.widget.getBounds();
  assert.equal(h.invoke('appearance', { scale: 1.25, characterId: 'chuchu' }).ok, true);
  assert.deepEqual(h.controller.widget.getBounds(), position);
  assert.equal(h.state().pet?.activity, 'idle');
  assert.equal(h.state().pet?.speed, 0);
  assert.equal(h.state().pet?.distance, 0);
  h.tick(50);
  assert.deepEqual(h.controller.widget.getBounds(), position);
  walkPet(h);
  assert.equal(h.state().pet?.activity, 'walk');
}));


test('settings routes directly from IPC and context menus while work ticks preserve the memo navigation date', () => fixture([], h => {
  h.send('panel-open', 'settings'); assert.equal(h.state().panelNavigation?.tab, 'settings');
  h.send('context-menu'); h.menus.at(-1)!.select('설정');
  assert.equal(h.state().panelNavigation?.tab, 'settings');
  h.send('panel-open', 'memos');
  assert.equal(h.state().panelNavigation?.memoDate, '2026-10-20');
  const navigation = h.state().panelNavigation;
  h.tick(1000); assert.deepEqual(h.state().panelNavigation, navigation);
  h.setNow(new Date(2026, 9, 21, 0, 0).getTime());
  h.send('panel-open', 'memos');
  assert.equal(h.state().panelNavigation?.memoDate, '2026-10-21');
}));

test('an archived memo alarm navigates to its original date without acknowledging or moving the item', () => {
  const item = { ...memo('어제 작성한 예약', '10:00', localTime(10, 0)), date: '2026-10-19' };
  const directory = mkdtempSync(join(tmpdir(), 'companion-dated-alarm-'));
  writeFileSync(join(directory, 'memos.json'), JSON.stringify({ version: 5, memos: [item] }));
  const h = harness(directory, localTime(10, 0, 20));
  try {
    h.tick(); const bubble = reminder(h);
    h.send('bubble-activate', bubble.id);
    assert.equal(h.state().panelNavigation?.tab, 'memos');
    assert.equal(h.state().panelNavigation?.memoDate, item.date);
    assert.equal(reminder(h).id, bubble.id);
    assert.equal(h.disk().memos[0].date, item.date);
    assert.equal(h.disk().memos[0].reminder!.acknowledged, false);
  } finally { h.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
