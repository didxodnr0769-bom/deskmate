import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SHORTCUT, DEFAULT_CHAT_SHORTCUT, CHAT_SIZE, PANEL_SIZE, type BriefingSettings, type CommandResult, type CompanionState, type HitRegion, type Motion, type NotificationBubble, type PanelTab, type Point, type Rect } from '../../shared/contracts';
import { DEFAULT_APPEARANCE, resizedWidgetBounds, validAppearanceSettings, widgetSize } from '../../shared/appearance';
import { AppearanceService } from '../features/appearance';
import { advanceRoam, clampBounds, hitTest, nativePosition, panelBounds, sanitizeHitRegions } from '../domain/geometry';
import { getWorkProgress, validateWorkSchedule } from '../domain/worktime';
import { loadWorkSchedule, saveWorkSchedule } from '../domain/worktime-store';
import { MemoService } from '../features/memos';
import { ChatService } from '../features/chat';
import { AppCommandService } from '../features/app-commands';
import { DEFAULT_BRIEFING, validBriefingSettings, WorkBriefingService } from '../features/briefing';
import { CodexProvider } from '../ai/codex';
import type { AgentProvider } from '../ai/provider';
import type { ChatState } from '../../shared/chat';

type Gesture = { start: Point; origin: Rect; dragging: boolean };
const isPoint = (v: unknown): v is Point => !!v && typeof v === 'object' &&
  ['x', 'y'].every(k => typeof (v as Record<string, unknown>)[k] === 'number' && Number.isFinite((v as Record<string, number>)[k]) && Math.abs((v as Record<string, number>)[k]) < 1e6);

/** Owns native windows. Character rendering and app features stay outside this class. */
export class DesktopController {
  readonly widget: BrowserWindow;
  readonly panel: BrowserWindow;
  readonly chat: BrowserWindow;
  private regions: HitRegion[] = [];
  private gesture: Gesture | null = null;
  private releaseAt: number | null = null;
  private ignored = true;
  private temporaryAlert = false;
  private position: Point = { x: 0, y: 0 };
  private velocity: Point = { x: 30, y: 18 };
  private readonly worktimeFile = join(app.getPath('userData'), 'worktime.json');
  private memoService: MemoService | null = null;
  private briefingService: WorkBriefingService | null = null;
  private appearanceService: AppearanceService | null = null;
  private lastWorkRefresh = 0;
  private lastReminderRefresh = 0;
  private lastTick = Date.now();
  private cycleStartedAt = Date.now();
  private timer: ReturnType<typeof setInterval>;
  private state: CompanionState;
  private disposed = false;
  private contextMenu: Menu | null = null;
  private readonly chatService: ChatService;
  private pendingChatBubble: Extract<NotificationBubble, { kind: 'chat' | 'chat-loading' }> | null = null;
  private dismissedLoadingRequestId: string | null = null;

  constructor(options: { agentProvider?: AgentProvider } = {}) {
    const commands = new AppCommandService({
      memos: () => { if (!this.memoService) throw new Error(); return this.memoService.list(); },
      addMemo: draft => this.mutateMemos(service => service.add(draft)),
      updateMemo: (id, draft) => this.mutateMemos(service => service.update(id, draft)),
      completeMemo: (id, completed) => this.mutateMemos(service => service.setCompleted(id, completed)),
      workSchedule: () => this.state.workSchedule,
      saveWorkSchedule: schedule => this.applyWorkSchedule(schedule),
      setWalking: enabled => this.setWalking(enabled),
      open: target => target === 'chat' ? this.openChat() : this.openPanel(target),
      briefingSettings: () => this.state.briefingSettings,
      configureBriefing: settings => this.configureBriefing(settings),
    });
    this.chatService = new ChatService(options.agentProvider ?? new CodexProvider(), next => this.onChatChange(next), commands);
    const display = screen.getPrimaryDisplay();
    let workSchedule = null;
    let storageError: string | null = null;
    try { workSchedule = loadWorkSchedule(this.worktimeFile); }
    catch (error) { storageError = (error as Error).message; }
    const workProgress = getWorkProgress(workSchedule, new Date());
    let memoError: string | null = null;
    try { this.memoService = new MemoService(join(app.getPath('userData'), 'memos.json')); }
    catch (error) { memoError = (error as Error).message; }
    let briefingError: string | null = null;
    try { this.briefingService = new WorkBriefingService(join(app.getPath('userData'), 'briefing.json')); }
    catch { briefingError = '퇴근 전 알림 설정을 읽지 못했어요. 원본 파일은 유지합니다.'; }
    let appearanceError: string | null = null;
    try { this.appearanceService = new AppearanceService(join(app.getPath('userData'), 'appearance.json')); }
    catch { appearanceError = '캐릭터 설정을 읽지 못했어요. 원본 파일은 유지합니다.'; }
    this.state = {
      appearance: this.appearanceService?.settings ?? { ...DEFAULT_APPEARANCE }, appearanceError,
      briefingSettings: this.briefingService?.settings ?? { ...DEFAULT_BRIEFING }, briefingError,
      chat: this.chatService.state, chatOpen: false, chatShortcut: DEFAULT_CHAT_SHORTCUT, chatShortcutRegistered: false, chatShortcutError: null, motion: 'idle', direction: 1, hp: workProgress.hp, workSchedule, workProgress, walking: true, visible: true,
      memos: this.memoService?.list() ?? [], memoError, reminderError: null,
      userHidden: false, panelOpen: false, panelNavigation: null, motionStartedAt: Date.now(), bubble: null,
      displayId: display.id, displays: [], shortcut: DEFAULT_SHORTCUT,
      shortcutRegistered: false, error: storageError,
    };
    const webPreferences = { preload: join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false };
    const initial = clampBounds({ x: display.workArea.x + Math.round(display.workArea.width * 0.65), y: display.workArea.y + Math.round(display.workArea.height * 0.4), ...widgetSize(this.state.appearance.scale) }, display.workArea);
    this.widget = new BrowserWindow({
      ...initial, title: 'Desktop Companion · 캐릭터', frame: false, transparent: true,
      backgroundColor: '#00000000', hasShadow: false, resizable: false,
      fullscreenable: false, minimizable: false, maximizable: false,
      focusable: false, show: false, skipTaskbar: true, type: 'panel', webPreferences,
    });
    this.panel = new BrowserWindow({
      ...panelBounds(initial, display.workArea, PANEL_SIZE), title: 'Desktop Companion · 패널',
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: true,
      resizable: false, fullscreenable: false, minimizable: false, maximizable: false,
      show: false, skipTaskbar: true, webPreferences,
    });
    this.chat = new BrowserWindow({
      ...panelBounds(initial, display.workArea, CHAT_SIZE), title: 'DeskMate · 대화',
      frame: false, backgroundColor: '#f8f8f2', hasShadow: true,
      resizable: false, fullscreenable: false, minimizable: false, maximizable: false,
      show: false, skipTaskbar: true, webPreferences,
    });
    this.position = { x: initial.x, y: initial.y };
    for (const win of [this.widget, this.panel, this.chat]) {
      win.setAlwaysOnTop(true, 'floating');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.webContents.on('did-finish-load', () => this.publish());
      win.webContents.on('render-process-gone', (_event, details) => console.error('Renderer exited:', details.reason));
    }
    this.widget.setIgnoreMouseEvents(true, { forward: true });
    this.widget.on('ready-to-show', () => { if (this.state.visible) this.widget.showInactive(); });
    this.panel.on('close', event => { if (!this.disposed) { event.preventDefault(); this.closePanel(); } });
    this.chat.on('close', event => { if (!this.disposed) { event.preventDefault(); this.closeChat(); } });
    this.registerIpc();
    this.registerShortcut(DEFAULT_SHORTCUT);
    this.registerChatShortcut(DEFAULT_CHAT_SHORTCUT);
    this.state.error = storageError;
    this.refreshDisplays();
    void this.widget.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'widget' });
    void this.panel.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'panel' });
    void this.chat.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'chat' });
    this.timer = setInterval(() => this.tick(), 1000 / 30);
    screen.on('display-added', this.handleDisplays);
    screen.on('display-removed', this.handleDisplays);
    screen.on('display-metrics-changed', this.handleDisplays);
  }

  private trusted(event: IpcMainEvent | IpcMainInvokeEvent, only?: 'widget' | 'panel' | 'chat') {
    if (event.senderFrame !== event.sender.mainFrame) return false;
    const windows = { widget: this.widget, panel: this.panel, chat: this.chat };
    return only ? event.sender === windows[only].webContents : Object.values(windows).some(win => event.sender === win.webContents);
  }

  private registerIpc() {
    const listen = (name: string, handler: (value: unknown) => void, only?: 'widget' | 'panel' | 'chat') => {
      ipcMain.on(`companion:${name}`, (event, value) => { if (this.trusted(event, only)) handler(value); });
    };
    ipcMain.handle('companion:state', event => this.trusted(event) ? this.state : null);
    ipcMain.handle('companion:agent-check', event => this.trusted(event, 'chat')
      ? this.chatService.checkConnection() : { ok: false, error: '허용되지 않은 요청입니다.' });
    ipcMain.handle('companion:chat-ask', (event, question: unknown) => this.trusted(event, 'chat')
      ? this.chatService.ask(question) : { ok: false, error: '허용되지 않은 요청입니다.' });
    ipcMain.handle('companion:chat-cancel', (event, requestId: unknown) => (this.trusted(event, 'chat') || this.trusted(event, 'widget'))
      ? this.chatService.cancel(requestId) : { ok: false, error: '허용되지 않은 요청입니다.' });
    ipcMain.handle('companion:chat-new', event => this.trusted(event, 'chat')
      ? this.chatService.newConversation() : { ok: false, error: '허용되지 않은 요청입니다.' });
    ipcMain.handle('companion:chat-shortcut', (event, value: unknown) => this.trusted(event, 'chat')
      ? this.registerChatShortcut(value) : { ok: false, error: '허용되지 않은 요청입니다.' });
    ipcMain.handle('companion:shortcut', (event, value) => this.trusted(event, 'panel') ? this.registerShortcut(value) : { ok: false, error: '허용되지 않은 요청입니다.' });
    ipcMain.handle('companion:work-schedule', (event, value: unknown) => this.trusted(event, 'panel')
      ? this.applyWorkSchedule(value) : { ok: false, error: '허용되지 않은 요청입니다.' });
    ipcMain.handle('companion:appearance', (event, value: unknown) => this.trusted(event, 'panel')
      ? this.configureAppearance(value) : { ok: false, error: '허용되지 않은 요청입니다.' });
    ipcMain.handle('companion:briefing-settings', (event, value: unknown) => this.trusted(event, 'panel')
      ? this.configureBriefing(value) : { ok: false, error: '허용되지 않은 요청입니다.' });
    const memoCommand = (event: IpcMainInvokeEvent, action: (service: MemoService) => void) => this.trusted(event, 'panel')
      ? this.mutateMemos(action) : { ok: false, error: '허용되지 않은 요청입니다.' };
    const payload = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
    ipcMain.handle('companion:memo-add', (event, value: unknown) => memoCommand(event, service => service.add(value)));
    ipcMain.handle('companion:memo-update', (event, value: unknown) => memoCommand(event, service => { const data = payload(value); service.update(data.id, data.draft); }));
    ipcMain.handle('companion:memo-complete', (event, value: unknown) => memoCommand(event, service => { const data = payload(value); service.setCompleted(data.id, data.completed); }));
    ipcMain.handle('companion:memo-delete', (event, value: unknown) => memoCommand(event, service => service.delete(value)));
    listen('hit-regions', v => { this.regions = sanitizeHitRegions(v); }, 'widget');
    listen('pointer-begin', v => { if (isPoint(v)) this.beginPointer(v); }, 'widget');
    listen('pointer-move', v => { if (isPoint(v)) this.movePointer(v); }, 'widget');
    listen('pointer-end', v => { if (isPoint(v)) this.endPointer(v); }, 'widget');
    listen('pointer-cancel', () => this.cancelPointer(), 'widget');
    listen('panel-open', value => { if (value === undefined || value === 'work' || value === 'memos' || value === 'appearance') this.openPanel(value); });
    listen('context-menu', () => this.showContextMenu(), 'widget');
    listen('bubble-activate', id => { if (typeof id === 'string') this.activateBubble(id); }, 'widget');
    listen('panel-close', () => this.closePanel());
    listen('chat-open', () => this.openChat());
    listen('chat-close', () => this.closeChat(), 'chat');
    listen('visibility', () => this.toggleVisibility());
    listen('walking', v => { if (typeof v === 'boolean') this.setWalking(v); }, 'panel');
    listen('preview-notification', () => this.previewNotification());
    ipcMain.handle('companion:bubble-dismiss', (event, id: unknown) => this.trusted(event, 'widget') && typeof id === 'string'
      ? this.dismissBubble(id) : { ok: false, error: '허용되지 않은 요청입니다.' });
    listen('quit', () => app.quit(), 'panel');
  }

  private applyWorkSchedule(value: unknown): CommandResult {
    if (!validateWorkSchedule(value)) return { ok: false, error: '날짜와 출근·퇴근 시간을 확인해 주세요. 출근과 퇴근은 다른 시각이어야 합니다.' };
    const { date, startTime, endTime } = value;
    const schedule = { date, startTime, endTime };
    try { saveWorkSchedule(this.worktimeFile, schedule); }
    catch { return { ok: false, error: '근무 시간을 저장하지 못했습니다. 다시 시도해 주세요.' }; }
    this.state.workSchedule = schedule;
    this.state.error = null;
    this.refreshWorkProgress();
    this.refreshReminders();
    this.publish();
    return { ok: true };
  }

  private mutateMemos(action: (service: MemoService) => void): CommandResult {
    if (!this.memoService) return { ok: false, error: this.state.memoError || '메모를 불러오지 못했습니다.' };
    try {
      action(this.memoService);
      this.state.memos = this.memoService.list();
      this.refreshReminders();
      this.publish();
      return { ok: true };
    } catch { return { ok: false, error: '메모를 저장하지 못했어요. 내용과 알림 설정을 확인한 뒤 다시 시도해 주세요.' }; }
  }

  private setWalking(enabled: boolean) {
    this.state.walking = enabled;
    this.setMotion(this.restingMotion());
    this.cycleStartedAt = Date.now();
    this.publish();
  }

  private configureBriefing(value: unknown): CommandResult {
    if (!validBriefingSettings(value)) return { ok: false, error: '퇴근 전 알림은 5~120분 전으로 설정해 주세요.' };
    if (!this.briefingService) return { ok: false, error: this.state.briefingError || '퇴근 전 알림 설정을 읽지 못했어요.' };
    try { this.briefingService.configure(value); }
    catch { return { ok: false, error: '퇴근 전 알림 설정을 저장하지 못했어요. 다시 시도해 주세요.' }; }
    this.state.briefingSettings = this.briefingService.settings;
    this.state.briefingError = null;
    this.refreshReminders();
    this.publish();
    return { ok: true };
  }

  private configureAppearance(value: unknown): CommandResult {
    if (!validAppearanceSettings(value)) return { ok: false, error: '캐릭터 종류와 크기를 확인해 주세요.' };
    if (!this.appearanceService) return { ok: false, error: this.state.appearanceError || '캐릭터 설정을 불러오지 못했어요.' };
    if (value.scale === this.state.appearance.scale && value.characterId === this.state.appearance.characterId) return { ok: true };
    try { this.appearanceService.configure(value); }
    catch { return { ok: false, error: '캐릭터 설정을 저장하지 못했어요. 다시 시도해 주세요.' }; }
    this.closeContextMenu();
    this.cancelPointer();
    const oldScale = this.state.appearance.scale;
    this.state.appearance = this.appearanceService.settings;
    const bounds = resizedWidgetBounds(this.widget.getBounds(), oldScale, this.state.appearance.scale, this.currentDisplay().workArea);
    this.widget.setBounds(bounds);
    this.position = { x: bounds.x, y: bounds.y };
    // Never use an old silhouette while the renderer applies a different scale.
    this.regions = [];
    this.setIgnored(true);
    this.positionPanel();
    this.publish();
    return { ok: true };
  }

  private publish() {
    for (const win of [this.widget, this.panel, this.chat]) {
      if (!win.isDestroyed() && !win.webContents.isLoadingMainFrame()) win.webContents.send('companion:state', this.state);
    }
  }

  private setMotion(motion: Motion) {
    if (this.state.motion === motion) return;
    this.state.motion = motion;
    this.state.motionStartedAt = Date.now();
    this.publish();
  }

  private restingMotion(): Motion { return this.state.bubble && this.state.bubble.kind !== 'chat-loading' ? 'notify' : 'idle'; }

  private currentDisplay() { return screen.getAllDisplays().find(d => d.id === this.state.displayId) ?? screen.getPrimaryDisplay(); }
  private refreshDisplays() {
    this.state.displays = screen.getAllDisplays().map((d, i) => ({ id: d.id, label: d.label || `모니터 ${i + 1}`, workArea: d.workArea, scaleFactor: d.scaleFactor }));
    if (!this.state.displays.some(d => d.id === this.state.displayId)) this.state.displayId = screen.getPrimaryDisplay().id;
    this.publish();
  }
  private handleDisplays = () => {
    this.closeContextMenu();
    this.gesture = null;
    this.releaseAt = null;
    this.refreshDisplays();
    const bounds = resizedWidgetBounds(this.widget.getBounds(), this.state.appearance.scale, this.state.appearance.scale, this.currentDisplay().workArea);
    this.widget.setBounds(bounds);
    this.position = { x: bounds.x, y: bounds.y };
    this.positionPanel();
    const chatBounds = this.chat.getBounds();
    this.chat.setBounds(clampBounds(chatBounds, screen.getDisplayMatching(chatBounds).workArea));
    this.setMotion(this.restingMotion());
  };

  private positionPanel() {
    this.panel.setBounds(panelBounds(this.widget.getBounds(), this.currentDisplay().workArea, PANEL_SIZE));
  }

  openPanel(tab?: PanelTab) {
    this.closeContextMenu(true);
    this.cancelPointer();
    if (tab) this.state.panelNavigation = { tab, sequence: (this.state.panelNavigation?.sequence ?? 0) + 1 };
    this.state.userHidden = false;
    this.temporaryAlert = false;
    this.syncVisibility();
    this.state.panelOpen = true;
    this.setMotion(this.restingMotion());
    this.positionPanel();
    this.panel.show();
    this.panel.focus();
    this.publish();
  }

  closePanel() { this.panel.hide(); this.state.panelOpen = false; this.cycleStartedAt = Date.now(); this.publish(); }

  openChat() {
    this.closeContextMenu(true);
    this.cancelPointer();
    if (!this.state.chatOpen) {
      const cursor = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cursor);
      const anchor = display.id === this.state.displayId ? this.widget.getBounds() : { ...cursor, width: 0, height: 0 };
      this.chat.setBounds(panelBounds(anchor, display.workArea, CHAT_SIZE));
    }
    this.state.chatOpen = true;
    this.chat.show();
    this.chat.focus();
    this.publish();
    if (!this.chat.webContents.isLoadingMainFrame()) this.chat.webContents.send('companion:chat-focus');
  }

  closeChat() { this.chat.hide(); this.state.chatOpen = false; this.publish(); }

  toggleVisibility() {
    this.closeContextMenu();
    this.state.userHidden = this.state.visible;
    this.temporaryAlert = false;
    this.cancelPointer();
    this.closePanel();
    this.closeChat();
    this.syncVisibility();
  }

  private showContextMenu() {
    if (this.disposed || !this.state.visible || this.contextMenu) return;
    this.cancelPointer();
    const menu = Menu.buildFromTemplate([
      { label: '대화하기', click: () => this.openChat() },
      { label: '근무시간', click: () => this.openPanel('work') },
      { label: '메모', click: () => this.openPanel('memos') },
      { label: '캐릭터 설정', click: () => this.openPanel('appearance') },
    ]);
    this.contextMenu = menu;
    this.setMotion(this.restingMotion());
    try {
      menu.popup({ window: this.widget, callback: () => {
        if (this.contextMenu !== menu) return;
        this.contextMenu = null;
        this.cycleStartedAt = Date.now();
        if (!this.disposed) this.refreshReminders();
      } });
    } catch {
      if (this.contextMenu === menu) this.contextMenu = null;
      this.cycleStartedAt = Date.now();
    }
  }

  private closeContextMenu(refreshPending = false) {
    const menu = this.contextMenu;
    if (!menu) return;
    this.contextMenu = null;
    this.cycleStartedAt = Date.now();
    menu.closePopup(this.widget);
    if (refreshPending && !this.disposed) this.refreshReminders();
  }

  private activateBubble(id: string) {
    const bubble = this.state.bubble;
    if (!bubble || bubble.id !== id) return;
    if (bubble.kind === 'chat' || bubble.kind === 'chat-loading') this.openChat();
    else if (bubble.kind === 'reminder' || bubble.kind === 'briefing') this.openPanel('memos');
  }

  private syncVisibility() {
    this.state.visible = !this.state.userHidden || this.temporaryAlert;
    if (this.state.visible) this.widget.showInactive();
    else { this.widget.hide(); this.setMotion(this.restingMotion()); }
    this.publish();
  }

  previewNotification() {
    // A manual preview must never replace an unacknowledged memo alarm.
    if (this.state.bubble && this.state.bubble.kind !== 'preview') return;
    this.showBubble({ id: randomUUID(), kind: 'preview', text: '알림 미리보기예요. 소리 없이 이렇게 알려드릴게요.' });
  }

  private showBubble(bubble: NotificationBubble) {
    this.cancelPointer();
    if (bubble.kind === 'preview' || bubble.kind === 'reminder' || bubble.kind === 'briefing') this.closePanel();
    this.state.bubble = bubble;
    this.temporaryAlert = this.state.userHidden;
    this.syncVisibility();
    this.state.motionStartedAt = Date.now();
    this.state.motion = bubble.kind === 'chat-loading' ? 'idle' : 'notify';
    this.publish();
  }

  dismissBubble(id: string): CommandResult {
    const bubble = this.state.bubble;
    // A repeated close for the previous bubble cannot dismiss the next queued one.
    if (!bubble || bubble.id !== id) return { ok: true };
    if (bubble.kind === 'reminder') {
      try {
        if (!this.memoService) throw new Error();
        this.memoService.acknowledgeReminder(bubble.memoId, bubble.dueAt);
        this.state.reminderError = null;
      } catch {
        this.state.reminderError = '알림 확인을 저장하지 못했어요. 다시 닫아 주세요.';
        this.publish();
        return { ok: false, error: this.state.reminderError };
      }
    }
    if (bubble.kind === 'briefing') {
      try {
        if (!this.briefingService) throw new Error();
        this.briefingService.acknowledge(bubble.occurrence);
        this.state.briefingError = null;
      } catch {
        this.state.briefingError = '퇴근 전 알림 확인을 저장하지 못했어요. 다시 닫아 주세요.';
        this.publish();
        return { ok: false, error: this.state.briefingError };
      }
    }
    if (bubble.kind === 'chat-loading') {
      this.dismissedLoadingRequestId = bubble.requestId;
      if (this.pendingChatBubble?.kind === 'chat-loading' && this.pendingChatBubble.requestId === bubble.requestId) this.pendingChatBubble = null;
    }
    this.state.bubble = null;
    this.refreshReminders();
    if (!this.state.bubble) {
      this.temporaryAlert = false;
      this.setMotion('idle');
      this.syncVisibility();
    }
    return { ok: true };
  }

  private refreshReminders(now = Date.now()) {
    this.lastReminderRefresh = now;
    if (!this.memoService) { this.presentPendingChat(); return; }
    try {
      const due = this.memoService.getDueReminders(now);
      // Keep an active alarm in place while edits update its text, even if an
      // earlier alarm becomes due after a system-clock change.
      const active = this.state.bubble;
      if (active?.kind === 'reminder') {
        const current = this.memoService.getPendingReminder(active.memoId, active.dueAt);
        if (current) {
          const text = `${current.time} · ${current.text}`;
          if (active.text !== text) { this.state.bubble = { ...active, text }; this.publish(); }
          return;
        }
        this.state.bubble = null;
      }
      if (this.state.reminderError) { this.state.reminderError = null; this.publish(); }
      if (due[0] && !this.contextMenu && !this.gesture && this.releaseAt === null) {
        const next = due[0];
        if ((this.state.bubble?.kind === 'chat' || this.state.bubble?.kind === 'chat-loading') && !this.pendingChatBubble) this.pendingChatBubble = this.state.bubble;
        this.showBubble({ id: randomUUID(), kind: 'reminder', memoId: next.memoId, dueAt: next.dueAt, text: `${next.time} · ${next.text}` });
      } else if (active?.kind === 'reminder') {
        this.temporaryAlert = false;
        this.setMotion(this.restingMotion());
        this.syncVisibility();
      }
      this.presentBriefing(now);
      this.presentPendingChat();
    } catch {
      const error = '알림 예약을 저장하지 못했어요. 메모 파일을 확인해 주세요.';
      if (this.state.reminderError !== error) { this.state.reminderError = error; this.publish(); }
    }
  }

  private presentBriefing(now: number) {
    if (!this.briefingService || !this.memoService) return;
    const due = this.briefingService.due(this.state.workSchedule, this.state.memos, now);
    const active = this.state.bubble;
    if (active?.kind === 'briefing') {
      if (due?.occurrence === active.occurrence) {
        if (active.text !== due.text) { this.state.bubble = { ...active, text: due.text }; this.publish(); }
        return;
      }
      this.state.bubble = null;
      this.temporaryAlert = false;
      this.setMotion(this.restingMotion());
      this.syncVisibility();
    }
    if (!due || this.state.bubble?.kind === 'reminder' || this.contextMenu || this.gesture || this.releaseAt !== null) return;
    if ((this.state.bubble?.kind === 'chat' || this.state.bubble?.kind === 'chat-loading') && !this.pendingChatBubble) this.pendingChatBubble = this.state.bubble;
    this.showBubble({ id: randomUUID(), kind: 'briefing', occurrence: due.occurrence, text: due.text });
  }

  private clearChatBubbles() {
    this.pendingChatBubble = null;
    this.dismissedLoadingRequestId = null;
    if (this.state.bubble?.kind === 'chat' || this.state.bubble?.kind === 'chat-loading') {
      this.state.bubble = null;
      this.temporaryAlert = false;
      this.setMotion(this.restingMotion());
      this.syncVisibility();
    }
  }

  private onChatChange(next: ChatState) {
    const previous = this.state.chat;
    this.state.chat = next;
    if (next.conversationId !== previous.conversationId || next.status === 'cancelled' || next.status === 'error') this.clearChatBubbles();
    if (next.status === 'thinking' && next.requestId !== previous.requestId && next.requestId) {
      this.clearChatBubbles();
      this.pendingChatBubble = { id: randomUUID(), kind: 'chat-loading', requestId: next.requestId, text: '응답 생성 중…' };
      this.refreshReminders();
    }
    if (next.status === 'answered' && next.requestId && next.answer
        && (previous.status !== 'answered' || previous.requestId !== next.requestId)) {
      this.pendingChatBubble = { id: randomUUID(), kind: 'chat', requestId: next.requestId, text: next.answer };
      this.refreshReminders();
    }
    this.publish();
  }

  private presentPendingChat() {
    if (!this.pendingChatBubble || this.contextMenu || (this.state.bubble?.kind === 'reminder' || this.state.bubble?.kind === 'briefing') || this.gesture || this.releaseAt !== null) return;
    const bubble = this.pendingChatBubble;
    this.pendingChatBubble = null;
    if (bubble.requestId !== this.state.chat.requestId) return;
    if (bubble.kind === 'chat-loading' && (this.state.chat.status !== 'thinking' || this.dismissedLoadingRequestId === bubble.requestId)) return;
    this.showBubble(bubble);
  }

  private beginPointer(point: Point) {
    if (this.contextMenu) return;
    this.releaseAt = null;
    this.gesture = { start: point, origin: this.widget.getBounds(), dragging: false };
    this.setMotion(this.restingMotion());
    this.setIgnored(false);
  }

  private movePointer(point: Point) {
    if (!this.gesture) return;
    const g = this.gesture;
    const dx = point.x - g.start.x, dy = point.y - g.start.y;
    if (!g.dragging && Math.hypot(dx, dy) < 6) return;
    if (!g.dragging) { g.dragging = true; this.closePanel(); this.setMotion('dragged'); }
    this.moveWidget({ x: g.origin.x + dx, y: g.origin.y + dy });
  }

  private endPointer(point: Point) {
    if (!this.gesture) return;
    this.movePointer(point);
    const dragged = this.gesture.dragging;
    this.gesture = null;
    if (!dragged) { this.openChat(); return; }
    const d = screen.getDisplayNearestPoint(point);
    this.state.displayId = d.id;
    const from = this.widget.getBounds();
    const placed = resizedWidgetBounds(from, this.state.appearance.scale, this.state.appearance.scale, d.workArea);
    this.widget.setBounds(placed);
    this.position = { x: placed.x, y: placed.y };
    // Only the character pose settles. The native window stays where it was released.
    this.releaseAt = Date.now() + 280;
    this.setMotion('dropping');
    this.publish();
  }

  private cancelPointer() {
    if (!this.gesture && this.releaseAt === null) return;
    const from = this.widget.getBounds();
    const d = screen.getDisplayMatching(from);
    this.state.displayId = d.id;
    this.gesture = null;
    this.releaseAt = null;
    const placed = resizedWidgetBounds(from, this.state.appearance.scale, this.state.appearance.scale, d.workArea);
    this.widget.setBounds(placed);
    this.position = { x: placed.x, y: placed.y };
    this.setMotion(this.restingMotion());
  }

  private setIgnored(ignore: boolean) {
    if (ignore === this.ignored) return;
    this.ignored = ignore;
    this.widget.setIgnoreMouseEvents(ignore, { forward: true });
  }

  private moveWidget(point: Point) {
    const native = nativePosition(point);
    if (!native || this.widget.isDestroyed()) return;
    this.widget.setPosition(native.x, native.y, false);
  }

  private tick() {
    const now = Date.now(), delta = Math.max(0, Math.min(0.1, (now - this.lastTick) / 1000));
    this.lastTick = now;
    if (now < this.lastWorkRefresh || now - this.lastWorkRefresh >= 1000) this.refreshWorkProgress();
    if (now < this.lastReminderRefresh || now - this.lastReminderRefresh >= 1000) this.refreshReminders(now);
    if (!this.state.visible) return;
    if (this.releaseAt !== null) {
      if (now >= this.releaseAt) { this.releaseAt = null; this.cycleStartedAt = now; this.setMotion(this.restingMotion()); }
    } else if (!this.contextMenu && !this.gesture && !this.state.panelOpen && !this.state.bubble && this.state.walking) {
      const active = (now - this.cycleStartedAt) % 11000 > 1800;
      this.setMotion(active ? 'walking' : 'idle');
      if (active) {
        const work = this.currentDisplay().workArea;
        const next = advanceRoam(this.position, this.velocity, delta, this.widget.getBounds(), work);
        this.position = next.position;
        // A cramped display may temporarily lock an axis. Retain its intended speed
        // so dragging to a larger display can resume movement on that axis.
        this.velocity = { x: next.velocity.x || this.velocity.x, y: next.velocity.y || this.velocity.y };
        this.moveWidget(next.position);
        const direction = this.velocity.x < 0 ? -1 : 1;
        if (direction !== this.state.direction) { this.state.direction = direction; this.publish(); }
      }
    }
    if (!this.gesture) {
      const cursor = screen.getCursorScreenPoint(), b = this.widget.getBounds();
      this.setIgnored(!hitTest({ x: cursor.x - b.x, y: cursor.y - b.y }, this.regions));
    }
  }

  private refreshWorkProgress() {
    this.lastWorkRefresh = Date.now();
    const next = getWorkProgress(this.state.workSchedule, new Date());
    const previous = this.state.workProgress;
    this.state.workProgress = next;
    this.state.hp = next.hp;
    if (next.hp !== previous.hp || next.phase !== previous.phase || next.remainingMinutes !== previous.remainingMinutes || next.isOvernight !== previous.isOvernight) this.publish();
  }

  registerShortcut(value: unknown): { ok: boolean; error?: string } {
    if (typeof value !== 'string' || value.length > 100 || !/(Command|Control|Alt|Option|Super)/.test(value)) return { ok: false, error: '보조 키와 함께 단축키를 지정해주세요.' };
    if (value === this.state.shortcut && this.state.shortcutRegistered) return { ok: true };
    if (value !== this.state.shortcut && globalShortcut.isRegistered(value)) return { ok: false, error: '이미 등록한 단축키와 겹칩니다. 다른 조합을 선택해 주세요.' };
    try {
      if (!globalShortcut.register(value, () => this.toggleVisibility())) return { ok: false, error: '이미 사용 중인 단축키입니다. 다른 조합을 선택해주세요.' };
    } catch { return { ok: false, error: '사용할 수 없는 단축키 조합입니다.' }; }
    if (this.state.shortcut !== value) globalShortcut.unregister(this.state.shortcut);
    this.state.shortcut = value;
    this.state.shortcutRegistered = true;
    this.state.error = null;
    this.publish();
    return { ok: true };
  }

  registerChatShortcut(value: unknown): CommandResult {
    const fail = (error: string) => { this.state.chatShortcutError = error; this.publish(); return { ok: false, error }; };
    if (typeof value !== 'string' || value.length > 100 || !/(Command|Control|Alt|Option|Super)/.test(value)) return fail('보조 키와 함께 단축키를 지정해 주세요.');
    if (value === this.state.chatShortcut && this.state.chatShortcutRegistered) return { ok: true };
    if (value !== this.state.chatShortcut && globalShortcut.isRegistered(value)) return fail('이미 등록한 단축키와 겹칩니다. 다른 조합을 선택해 주세요.');
    try {
      if (!globalShortcut.register(value, () => this.openChat())) return fail('이미 사용 중인 단축키입니다. 메뉴 막대에서 대화하기를 열거나 다른 조합을 선택해 주세요.');
    } catch { return fail('사용할 수 없는 단축키 조합입니다.'); }
    if (this.state.chatShortcutRegistered && this.state.chatShortcut !== value) globalShortcut.unregister(this.state.chatShortcut);
    this.state.chatShortcut = value;
    this.state.chatShortcutRegistered = true;
    this.state.chatShortcutError = null;
    this.publish();
    return { ok: true };
  }

  onResume() { this.lastTick = Date.now(); this.refreshWorkProgress(); this.handleDisplays(); this.refreshReminders(); }
  dispose() {
    this.disposed = true;
    this.closeContextMenu();
    this.chatService.dispose();
    this.pendingChatBubble = null;
    clearInterval(this.timer);
    globalShortcut.unregisterAll();
    screen.removeListener('display-added', this.handleDisplays);
    screen.removeListener('display-removed', this.handleDisplays);
    screen.removeListener('display-metrics-changed', this.handleDisplays);
  }
}
