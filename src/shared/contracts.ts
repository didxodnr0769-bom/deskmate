import type { ChatState } from './chat';
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
export interface MemoDraft { text: string; reminderTime: string | null }
export interface Memo extends MemoDraft {
  id: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}
export type NotificationBubble = { id: string; text: string; kind: 'preview' }
  | { id: string; text: string; kind: 'reminder'; memoId: string; dueAt: number }
  | { id: string; text: string; kind: 'chat'; requestId: string };
export interface CompanionState {
  chat: ChatState;
  motion: Motion;
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
  askQuestion(question: string): Promise<CommandResult>;
  cancelQuestion(requestId: string): Promise<CommandResult>;
  onState(listener: (state: CompanionState) => void): () => void;
  setHitRegions(regions: HitRegion[]): void;
  beginPointer(point: Point): void;
  movePointer(point: Point): void;
  endPointer(point: Point): void;
  cancelPointer(): void;
  openPanel(): void;
  closePanel(): void;
  toggleVisibility(): void;
  setWalking(value: boolean): void;
  setWorkSchedule(schedule: WorkSchedule): Promise<CommandResult>;
  addMemo(draft: MemoDraft): Promise<CommandResult>;
  updateMemo(id: string, draft: MemoDraft): Promise<CommandResult>;
  setMemoCompleted(id: string, completed: boolean): Promise<CommandResult>;
  deleteMemo(id: string): Promise<CommandResult>;
  previewNotification(): void;
  dismissBubble(id: string): Promise<CommandResult>;
  setShortcut(shortcut: string): Promise<{ ok: boolean; error?: string }>;
  quit(): void;
}
export const WIDGET_SIZE = { width: 280, height: 300 } as const;
export const PANEL_SIZE = { width: 360, height: 510 } as const;
export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space';
