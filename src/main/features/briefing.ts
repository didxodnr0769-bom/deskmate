import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import type { BriefingSettings, Memo, WorkSchedule } from '../../shared/contracts';
import { validateWorkSchedule } from '../domain/worktime';

type Stored = { version: 1; settings: BriefingSettings; acknowledged: string[] };
export interface WorkBriefing { occurrence: string; dueAt: number; text: string }
export const DEFAULT_BRIEFING: BriefingSettings = { enabled: false, beforeMinutes: 30 };
export function validBriefingSettings(value: unknown): value is BriefingSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { enabled, beforeMinutes } = value as Record<string, unknown>;
  return typeof enabled === 'boolean' && Number.isInteger(beforeMinutes) && Number(beforeMinutes) >= 5 && Number(beforeMinutes) <= 120;
}

export class WorkBriefingService {
  private value: Stored = { version: 1, settings: { ...DEFAULT_BRIEFING }, acknowledged: [] };
  constructor(private readonly filename: string) {
    let parsed: unknown;
    try {
      if (statSync(filename).size > 32768) throw new Error();
      parsed = JSON.parse(readFileSync(filename, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('퇴근 전 알림 설정을 읽지 못했어요. 원본 파일은 유지합니다.');
    }
    const data = parsed as Stored | null;
    if (!data || data.version !== 1 || !validBriefingSettings(data.settings) || !Array.isArray(data.acknowledged)
      || data.acknowledged.length > 400 || data.acknowledged.some(key => typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}\/[0-9]{2}:[0-9]{2}\/[0-9]{2}:[0-9]{2}$/.test(key))
      || new Set(data.acknowledged).size !== data.acknowledged.length) throw new Error('퇴근 전 알림 설정이 올바르지 않아요. 원본 파일은 유지합니다.');
    this.value = { version: 1, settings: { enabled: data.settings.enabled, beforeMinutes: data.settings.beforeMinutes }, acknowledged: [...data.acknowledged] };
  }
  get settings(): BriefingSettings { return { ...this.value.settings }; }
  configure(settings: unknown) {
    if (!validBriefingSettings(settings)) throw new Error('퇴근 전 알림은 5~120분 전으로 설정해 주세요.');
    this.commit({ ...this.value, settings: { enabled: settings.enabled, beforeMinutes: settings.beforeMinutes } });
  }
  due(schedule: WorkSchedule | null, memos: readonly Memo[], now: number): WorkBriefing | null {
    if (!this.value.settings.enabled || !validateWorkSchedule(schedule) || !Number.isFinite(new Date(now).getTime())) return null;
    const { start, end } = workInterval(schedule);
    const dueAt = end - this.value.settings.beforeMinutes * 60000;
    if (now < Math.max(start, dueAt) || now >= end) return null;
    const occurrence = `${schedule.date}/${schedule.startTime}/${schedule.endTime}`;
    if (this.value.acknowledged.includes(occurrence)) return null;
    const pending = memos.filter(memo => !memo.completed);
    if (!pending.length) return null;
    const titles = pending.slice(0, 5).map((memo, index) => `${index + 1}. ${memo.text.length > 80 ? memo.text.slice(0, 80) + '…' : memo.text}`);
    const remaining = Math.ceil((end - now) / 60000);
    return { occurrence, dueAt, text: `퇴근까지 ${remaining}분 · 남은 할 일 ${pending.length}개\n${titles.join('\n')}${pending.length > titles.length ? `\n외 ${pending.length - titles.length}개 · 메모 목록에서 확인하세요.` : ''}` };
  }
  acknowledge(occurrence: string) {
    if (this.value.acknowledged.includes(occurrence)) return;
    if (!/^\d{4}-\d{2}-\d{2}\/[0-9]{2}:[0-9]{2}\/[0-9]{2}:[0-9]{2}$/.test(occurrence)) throw new Error('알림 대상을 확인하지 못했어요.');
    this.commit({ ...this.value, acknowledged: [...this.value.acknowledged, occurrence].slice(-400) });
  }
  private commit(next: Stored) {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.filename);
    } catch { throw new Error('퇴근 전 알림 설정을 저장하지 못했어요. 다시 시도해 주세요.'); }
    finally { try { unlinkSync(temporary); } catch { /* Preserve the original save result during best-effort cleanup. */ } }
    this.value = next;
  }
}

function workInterval(schedule: WorkSchedule): { start: number; end: number } {
  const [year, month, day] = schedule.date.split('-').map(Number);
  const at = (time: string, nextDay: boolean) => {
    const date = new Date(0); date.setHours(0, 0, 0, 0);
    date.setFullYear(year, month - 1, day + Number(nextDay));
    date.setHours(Number(time.slice(0, 2)), Number(time.slice(3)), 0, 0);
    return date.getTime();
  };
  return { start: at(schedule.startTime, false), end: at(schedule.endTime, schedule.endTime < schedule.startTime) };
}
