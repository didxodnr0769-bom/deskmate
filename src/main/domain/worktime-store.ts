import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { WorkSchedule } from '../../shared/contracts';
import { validateWorkSchedule } from './worktime';

/** Only the committed work schedule is persisted; partial form edits stay in the panel. */
export function loadWorkSchedule(filename: string): WorkSchedule | null {
  let value: unknown;
  try {
    if (statSync(filename).size > 4096) throw new Error('근무 시간 파일이 너무 큽니다.');
    value = JSON.parse(readFileSync(filename, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('저장된 근무 시간을 읽지 못했습니다. 시간을 다시 입력해 주세요.');
  }
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== 1
    || !validateWorkSchedule((value as { schedule?: unknown }).schedule)) {
    throw new Error('저장된 근무 시간이 올바르지 않습니다. 시간을 다시 입력해 주세요.');
  }
  const { date, startTime, endTime } = (value as { schedule: WorkSchedule }).schedule;
  return { date, startTime, endTime };
}

export function saveWorkSchedule(filename: string, schedule: WorkSchedule): void {
  if (!validateWorkSchedule(schedule)) throw new Error('출근·퇴근 시간을 확인해 주세요.');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const { date, startTime, endTime } = schedule;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, schedule: { date, startTime, endTime } }), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, filename);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
