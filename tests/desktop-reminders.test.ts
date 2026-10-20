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
type Surface = 'widget' | 'panel';

class FakeContents extends EventEmitter {
  readonly mainFrame = {};
  readonly messages: { channel: string; value: unknown }[] = [];
  setWindowOpenHandler(_handler: unknown) {}
  isLoadingMainFrame() { return false; }
  send(channel: string, value: unknown) {
    this.messages.push({ channel, value: JSON.parse(JSON.stringify(value)) });
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
  return { id: randomUUID(), text, reminderTime, completed: false,
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
  const electron = {
    app: { getPath: () => directory, quit() {} },
    BrowserWindow: FakeWindow,
    screen,
    globalShortcut: { register: () => true, unregister() {}, unregisterAll() {} },
    ipcMain: {
      on: (channel: string, handler: Handler) => events.set(channel, handler),
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    },
  };
  const module = { exports: {} as { DesktopController: new (options?: { agentProvider?: AgentProvider }) => {
    widget: FakeWindow; panel: FakeWindow; onResume(): void; dispose(): void;
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
  const invoke = <T = CommandResult>(channel: string, value?: unknown, surface: Surface = 'panel'): T =>
    invokeFrom<T>(channel, value, event(surface));
  return {
    controller, screen, filename, event, invoke, invokeFrom,
    state: (): CompanionState => JSON.parse(JSON.stringify(invoke<CompanionState>('state', undefined, 'widget'))),
    disk: (): { version: number; memos: StoredMemo[] } => JSON.parse(readFileSync(filename, 'utf8')),
    send(channel: string, value?: unknown, surface: Surface = 'widget') {
      const callback = events.get(`companion:${channel}`);
      assert.ok(callback, `IPC listener is registered: ${channel}`);
      callback(event(surface), value);
    },
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

test('scheduled alarms take priority over a preview and an active alarm cannot be replaced by another preview', () => {
  const item = memo('예약', '10:01', localTime(10, 1));
  fixture([item], h => {
    h.send('preview-notification');
    assert.equal(h.state().bubble?.kind, 'preview');
    const previewId = h.state().bubble!.id;
    h.tick(40_000);
    const active = reminder(h);
    assert.equal(active.memoId, item.id);
    h.send('preview-notification');
    assert.equal(reminder(h).id, active.id);
    close(h, previewId);
    assert.equal(reminder(h).id, active.id);
    close(h, active.id);
    assert.equal(h.state().bubble, null);
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

test('trusted panel chat requests publish an answer in both panel state and a dismissible character bubble', async () => {
  await chatFixture(async (h, reply) => {
    h.send('panel-open');
    assert.equal(h.invoke('chat-ask', '질문').ok, true);
    assert.equal(h.state().chat.status, 'thinking');
    reply('짧은 답변');
    await chatSettled();
    assert.equal(h.state().chat.answer, '짧은 답변');
    assert.equal(h.state().bubble?.kind, 'chat');
    assert.equal(h.state().bubble?.text, '짧은 답변');
    assert.equal(h.state().panelOpen, true, 'answer presentation keeps the question panel open');
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
    h.send('preview-notification');
    assert.equal(h.state().bubble!.id, chatId, 'preview cannot replace a real answer');
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
    assert.equal(h.state().bubble, null);
    assert.equal(h.state().motion, 'dragged');
    h.send('pointer-end', { x: 1400, y: 550 });
    h.tick(1500);
    assert.equal(h.state().bubble, null);
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

test('only the trusted panel main frame may check, ask or cancel an AI request', async () => {
  await chatFixture(async (h, _reply, signals) => {
    const foreign = new FakeContents();
    for (const channel of ['agent-check', 'chat-ask', 'chat-cancel']) {
      assert.equal(h.invoke(channel, '질문', 'widget').ok, false);
      assert.equal(h.invokeFrom(channel, '질문', h.event('panel', true)).ok, false);
      assert.equal(h.invokeFrom(channel, '질문', { sender: foreign, senderFrame: foreign.mainFrame }).ok, false);
    }
    assert.equal(h.invoke('chat-ask', {}).ok, false);
    assert.equal(h.invoke('chat-ask', '정상 질문').ok, true);
    assert.equal(signals.length, 1);
    assert.equal(h.invoke('chat-cancel', h.state().chat.requestId).ok, true);
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
