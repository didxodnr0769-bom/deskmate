import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Memo, MemoDraft } from '../../shared/contracts';
import { nextReminderAt } from '../domain/reminders';

interface Reminder { dueAt: number; acknowledged: boolean }
interface StoredMemo extends Memo { reminder: Reminder | null }
export interface DueReminder { memoId: string; dueAt: number; text: string; time: string }

const MAX_MEMOS = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validLegacyReminder(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length !== 24 || !ISO_TIME.test(value)) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}

function validReminderTime(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length === 5 && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value));
}

function legacyReminderTime(value: unknown): string | null {
  if (!validLegacyReminder(value)) throw new Error('메모 시각을 올바르게 입력해 주세요.');
  if (value === null) return null;
  const time = new Date(value);
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
}

function parseDraft(value: unknown): MemoDraft {
  if (!isRecord(value) || typeof value.text !== 'string') throw new Error('메모 내용을 입력해 주세요.');
  const text = value.text.trim();
  if (text.length < 1 || text.length > 1000) throw new Error('메모 내용은 1자부터 1000자까지 입력해 주세요.');
  if (!validReminderTime(value.reminderTime)) throw new Error('메모 시각을 올바르게 입력해 주세요.');
  return { text, reminderTime: value.reminderTime };
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    && Number.isFinite(new Date(value).getTime());
}

function parseStoredMemo(value: unknown, version: 1 | 2 | 3, now: number): StoredMemo {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length !== 36 || !UUID.test(value.id)
    || typeof value.completed !== 'boolean' || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt)) {
    throw new Error('잘못된 메모 형식입니다.');
  }
  const draft = parseDraft(version === 1
    ? { text: value.text, reminderTime: legacyReminderTime(value.reminderAt) }
    : value);
  if (value.text !== draft.text) throw new Error('잘못된 메모 내용입니다.');
  let reminder: Reminder | null = null;
  if (version === 3) {
    if (value.completed || draft.reminderTime === null) {
      if (value.reminder !== null) throw new Error('잘못된 알림 형식입니다.');
    } else {
      if (!isRecord(value.reminder) || !validTimestamp(value.reminder.dueAt) || typeof value.reminder.acknowledged !== 'boolean') {
        throw new Error('잘못된 알림 형식입니다.');
      }
      reminder = { dueAt: value.reminder.dueAt, acknowledged: value.reminder.acknowledged };
    }
  } else if (!value.completed && draft.reminderTime !== null) {
    // Older versions never scheduled alarms. Arm once from the upgrade's local time.
    reminder = { dueAt: nextReminderAt(draft.reminderTime, now), acknowledged: false };
  }
  return { id: value.id, ...draft, completed: value.completed, createdAt: value.createdAt, updatedAt: value.updatedAt, reminder };
}

/** Owns memo data and durable one-shot reminders; native presentation stays outside. */
export class MemoService {
  private memos: StoredMemo[];
  private legacySource: { version: 1 | 2; content: Buffer } | null = null;

  constructor(private readonly filename: string, private readonly now: () => number = Date.now) {
    this.memos = this.load();
  }

  list(): Memo[] {
    return this.memos.map(({ reminder: _reminder, ...memo }) => ({ ...memo }));
  }

  private schedule(time: string | null, completed: boolean, now: number): Reminder | null {
    return time !== null && !completed ? { dueAt: nextReminderAt(time, now), acknowledged: false } : null;
  }

  getDueReminders(now = this.now()): DueReminder[] {
    if (!validTimestamp(now)) throw new Error('현재 시각을 확인해 주세요.');
    // Persist the upgrade's due times before delivery, including future alarms.
    if (this.legacySource !== null) this.commit(this.memos);
    return this.memos.filter(memo => memo.reminder && !memo.reminder.acknowledged && memo.reminder.dueAt <= now)
      .map(memo => ({ memoId: memo.id, dueAt: memo.reminder!.dueAt, text: memo.text, time: memo.reminderTime! }))
      .sort((a, b) => a.dueAt - b.dueAt || a.memoId.localeCompare(b.memoId));
  }

  getPendingReminder(id: string, dueAt: number): DueReminder | null {
    const memo = this.memos.find(item => item.id === id && item.reminder?.dueAt === dueAt && !item.reminder.acknowledged);
    return memo ? { memoId: memo.id, dueAt, text: memo.text, time: memo.reminderTime! } : null;
  }

  acknowledgeReminder(id: string, dueAt: number): void {
    const index = this.indexOf(id);
    const reminder = this.memos[index].reminder;
    if (!reminder || reminder.dueAt !== dueAt) throw new Error('알림이 변경되었습니다.');
    if (reminder.acknowledged) return;
    this.commit(this.memos.map((memo, i) => i === index ? { ...memo, reminder: { ...reminder, acknowledged: true } } : memo));
  }

  add(draft: unknown): void {
    if (this.memos.length >= MAX_MEMOS) throw new Error('메모는 최대 500개까지 저장할 수 있습니다.');
    const fields = parseDraft(draft);
    const now = this.now();
    const memo: StoredMemo = { id: randomUUID(), ...fields, completed: false, createdAt: now, updatedAt: now, reminder: this.schedule(fields.reminderTime, false, now) };
    this.commit([...this.memos, memo]);
  }

  update(id: unknown, draft: unknown): void {
    const index = this.indexOf(id);
    const fields = parseDraft(draft);
    const now = this.now();
    const next = this.memos.map((memo, i) => i === index ? {
      ...memo, ...fields, updatedAt: now,
      reminder: fields.reminderTime === memo.reminderTime ? memo.reminder : this.schedule(fields.reminderTime, memo.completed, now),
    } : memo);
    this.commit(next);
  }

  setCompleted(id: unknown, completed: unknown): void {
    const index = this.indexOf(id);
    if (typeof completed !== 'boolean') throw new Error('메모 완료 상태를 확인해 주세요.');
    const now = this.now();
    const next = this.memos.map((memo, i) => i === index ? {
      ...memo, completed, updatedAt: now,
      reminder: completed === memo.completed ? memo.reminder : this.schedule(memo.reminderTime, completed, now),
    } : memo);
    this.commit(next);
  }

  delete(id: unknown): void {
    const index = this.indexOf(id);
    this.commit(this.memos.filter((_memo, i) => i !== index));
  }

  private indexOf(id: unknown): number {
    if (typeof id !== 'string' || id.length === 0) throw new Error('메모를 선택해 주세요.');
    const index = this.memos.findIndex(memo => memo.id === id);
    if (index < 0) throw new Error('메모를 찾을 수 없습니다.');
    return index;
  }

  private load(): StoredMemo[] {
    let content: Buffer;
    try {
      const file = statSync(this.filename);
      if (!file.isFile() || file.size > MAX_FILE_BYTES) throw new Error('잘못된 파일입니다.');
      content = readFileSync(this.filename);
      if (content.length > MAX_FILE_BYTES) throw new Error('파일이 너무 큽니다.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('저장된 메모를 읽지 못했습니다. 원본 파일을 확인해 주세요.');
    }
    try {
      const value: unknown = JSON.parse(content.toString('utf8'));
      if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3) || !Array.isArray(value.memos) || value.memos.length > MAX_MEMOS) {
        throw new Error('잘못된 저장 형식입니다.');
      }
      const version = value.version;
      const now = this.now();
      const memos = value.memos.map(memo => parseStoredMemo(memo, version, now));
      if (new Set(memos.map(memo => memo.id.toLowerCase())).size !== memos.length) throw new Error('중복된 메모입니다.');
      if (version !== 3) this.legacySource = { version, content };
      return memos;
    } catch {
      throw new Error('저장된 메모가 올바르지 않습니다. 원본 파일을 확인해 주세요.');
    }
  }

  private backupLegacySource(): void {
    if (this.legacySource === null) return;
    const backup = `${this.filename.replace(/\.json$/, '')}.v${this.legacySource.version}.backup.json`;
    let descriptor: number;
    try {
      descriptor = openSync(backup, 'wx', 0o600);
    } catch (error) {
      // A pre-existing backup is retained byte-for-byte; other failures block migration.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && lstatSync(backup).isFile()) return;
      throw error;
    }
    try {
      writeFileSync(descriptor, this.legacySource.content);
    } catch (error) {
      try { closeSync(descriptor); } catch { /* Preserve the original write error. */ }
      try { unlinkSync(backup); } catch { /* A failed backup must not replace the live file. */ }
      throw error;
    }
    closeSync(descriptor);
  }

  private commit(next: StoredMemo[]): void {
    const content = JSON.stringify({ version: 3, memos: next });
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('메모 데이터가 너무 큽니다. 메모를 줄여 주세요.');
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.filename), { recursive: true });
      writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      this.backupLegacySource();
      renameSync(temporary, this.filename);
    } catch {
      throw new Error('메모를 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      // Cleanup must never turn an already committed write into an apparent failure.
      try { unlinkSync(temporary); } catch { /* Missing or inaccessible temporary file. */ }
    }
    this.memos = next;
    this.legacySource = null;
  }
}
