import type { AppearanceSettings } from './appearance';
import type { PetAnimationState } from './pet-behavior';
import type { ChatState } from './chat';
export type PanelTab = 'work' | 'memos' | 'appearance' | 'settings';
export type Motion = 'idle' | 'walking' | 'dragged' | 'dropping' | 'notify';
export interface Point { x: number; y: number }
export interface Rect extends Point { width: number; height: number }
export type HitRegion = { type: 'rect'; rect: Rect } | { type: 'polygon'; points: Point[] };
export interface DisplayInfo { id: number; label: string; workArea: Rect; scaleFactor: number }
export interface WorkSchedule { date: string; startTime: string; endTime: string }
export interface WorkProgress {
  hp: number;
  remainingMinutes: number | null;
  phase: 'unset' | 'before' | 'working' | 'finished';
  isOvernight: boolean;
}
export interface CommandResult { ok: boolean; error?: string }
export type MemoSchedule = { kind: 'once'; dueAt: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; time: string; weekdays: number[] };
export interface MemoDraft { text: string; reminderTime: string | null; schedule?: MemoSchedule | null; date?: string }
export interface Memo extends MemoDraft {
  date: string;
  id: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}
export type NotificationBubble = { id: string; text: string; kind: 'reminder'; memoId: string; dueAt: number }
  | { id: string; text: string; kind: 'chat'; requestId: string }
  | { id: string; text: string; kind: 'chat-loading'; requestId: string }
  | { id: string; text: string; kind: 'casual'; expiresAt: number };
export interface CompanionState {
  appearance: AppearanceSettings;
  appearanceError: string | null;
  chat: ChatState;
  chatOpen: boolean;
  chatShortcut: string;
  chatShortcutRegistered: boolean;
  chatShortcutError: string | null;
  motion: Motion;
  pet?: PetAnimationState;
  direction: 1 | -1;
  hp: number;
  workSchedule: WorkSchedule | null;
  workProgress: WorkProgress;
  memos: Memo[];
  memoError: string | null;
  reminderError: string | null;
  walking: boolean;
  visible: boolean;
  userHidden: boolean;
  panelOpen: boolean;
  panelNavigation: { tab: PanelTab; sequence: number; memoDate?: string } | null;
  motionStartedAt: number;
  bubble: NotificationBubble | null;
  displayId: number;
  displays: DisplayInfo[];
  shortcut: string;
  shortcutRegistered: boolean;
  error: string | null;
}
export interface CompanionApi {
  getState(): Promise<CompanionState>;
  checkAgentConnection(): Promise<CommandResult>;
  newConversation(): Promise<CommandResult>;
  openChat(): void;
  closeChat(): void;
  onChatFocus(listener: () => void): () => void;
  askQuestion(question: string): Promise<CommandResult>;
  cancelQuestion(requestId: string): Promise<CommandResult>;
  onState(listener: (state: CompanionState) => void): () => void;
  setHitRegions(regions: HitRegion[]): void;
  beginPointer(point: Point): void;
  movePointer(point: Point): void;
  endPointer(point: Point): void;
  cancelPointer(): void;
  openPanel(tab?: PanelTab): void;
  showContextMenu(): void;
  activateBubble(id: string): void;
  closePanel(): void;
  toggleVisibility(): void;
  setWalking(value: boolean): void;
  setWorkSchedule(schedule: WorkSchedule): Promise<CommandResult>;
  setAppearance(settings: AppearanceSettings): Promise<CommandResult>;
  addMemo(draft: MemoDraft): Promise<CommandResult>;
  updateMemo(id: string, draft: MemoDraft): Promise<CommandResult>;
  setMemoCompleted(id: string, completed: boolean): Promise<CommandResult>;
  deleteMemo(id: string): Promise<CommandResult>;
  dismissBubble(id: string): Promise<CommandResult>;
  setShortcut(shortcut: string): Promise<{ ok: boolean; error?: string }>;
  quit(): void;
}
export const WIDGET_SIZE = { width: 280, height: 300 } as const;
export const PANEL_SIZE = { width: 360, height: 510 } as const;
export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space';

export const CHAT_SIZE = { width: 420, height: 600 } as const;
export const DEFAULT_CHAT_SHORTCUT = 'CommandOrControl+Shift+Return';
