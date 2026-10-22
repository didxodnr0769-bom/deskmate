import type { CommandResult, Memo, MemoDraft, MemoSchedule, PanelTab, WorkSchedule } from '../../shared/contracts';
import { defaultEndTime, getWorkProgress, localDateKey, validateWorkSchedule } from '../domain/worktime';
import { isMemoDate, localMemoDate } from '../../shared/memo-date';

export interface AppCommandPorts {
  memos(): Memo[];
  addMemo(draft: MemoDraft): CommandResult;
  updateMemo(id: string, draft: MemoDraft): CommandResult;
  completeMemo(id: string, completed: boolean): CommandResult;
  workSchedule(): WorkSchedule | null;
  saveWorkSchedule(schedule: WorkSchedule): CommandResult;
  setWalking(enabled: boolean): void;
  open(target: PanelTab | 'chat'): void;
}
type Command = Record<string, unknown> & { name: string };
type Pending = { command: Command; date: string; implicitDate: boolean; candidates: { id: string; revision: string; text: string }[] };
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
const allowed: Record<string, string[]> = {
  'memo.list': ['query', 'completed', 'date'], 'memo.add': ['text', 'reminder', 'date'],
  'memo.update': ['target', 'text', 'reminder', 'date'], 'memo.complete': ['target', 'completed', 'date'],
  'work.get': [], 'work.update': ['date', 'startTime', 'endTime'],
  'character.walk': ['enabled'], 'ui.open': ['target'], 'summary.get': [],
};
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, maximum = 1000): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum; }
function clock(value: unknown): value is string { return typeof value === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value); }
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/\s+/g, ' ').trim();
const revision = (memo: Memo) => JSON.stringify([memo.date, memo.text, memo.updatedAt, memo.completed, memo.reminderTime, memo.schedule]);
const excerpt = (value: string, maximum = 250) => value.length > maximum ? value.slice(0, maximum) + '…' : value;
function done(result: CommandResult) { if (!result.ok) throw new Error(result.error || '변경을 저장하지 못했어요. 다시 시도해 주세요.'); }

/** The model proposes one whitelisted command. Only this main-process service executes it. */
export class AppCommandService {
  private pending: Pending | null = null;
  constructor(private readonly ports: AppCommandPorts, private readonly now: () => number = Date.now) {}
  reset() { this.pending = null; }

  process(reply: string, question: string): string {
    try {
      const selected = this.selectedPending(question);
      if (selected !== null) return selected;
      this.pending = null;
      let parsed: unknown;
      const source = reply.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, '$1');
      try { parsed = JSON.parse(source); }
      catch {
        // Older custom providers may still return ordinary conversation text.
        if (!source.startsWith('{') && !source.startsWith('[')) return source;
        return '앱 명령을 읽지 못했어요. 요청을 한 가지씩 다시 말씀해 주세요.';
      }
      if (!record(parsed)) return '앱 명령 형식을 확인하지 못했어요. 다시 말씀해 주세요.';
      if (parsed.kind === 'reply' && text(parsed.text, 16000)) return parsed.text.trim();
      if (parsed.kind !== 'command' || !record(parsed.command)) return '앱 명령 형식을 확인하지 못했어요. 다시 말씀해 주세요.';
      const command = parsed.command;
      if (typeof command.name !== 'string' || !Object.hasOwn(allowed, command.name)
        || Object.keys(command).some(key => key !== 'name' && !allowed[command.name as string].includes(key))) {
        return '지원하지 않는 앱 명령이에요. 메모·근무·캐릭터 기능을 요청해 주세요.';
      }
      return this.execute(command as Command);
    } catch {
      return '요청을 저장하거나 처리하지 못했어요. 입력과 앱의 오류 안내를 확인한 뒤 다시 시도해 주세요.';
    }
  }

  private execute(command: Command, selected?: Memo): string {
    const date = command.date === undefined ? localMemoDate(this.now()) : command.date;
    if (command.name.startsWith('memo.') && !isMemoDate(date)) return '메모 날짜를 YYYY-MM-DD 형식의 올바른 날짜로 알려 주세요.';
    switch (command.name) {
      case 'memo.list': {
        if (command.query !== undefined && !text(command.query)) return '찾을 메모 내용을 입력해 주세요.';
        if (command.completed !== undefined && typeof command.completed !== 'boolean') return '완료 여부를 확인해 주세요.';
        const query = command.query === undefined ? '' : normalize(command.query as string);
        const items = this.ports.memos().filter(memo => memo.date === date && (!query || normalize(memo.text).includes(query))
          && (command.completed === undefined || memo.completed === command.completed));
        return String(date) + ' 메모\n' + this.memoList(items, '조건에 맞는 메모가 없어요.');
      }
      case 'memo.add': {
        if (!text(command.text)) return '메모 내용은 1~1,000자로 입력해 주세요.';
        const reminder = this.reminder(command.reminder);
        done(this.ports.addMemo({ text: command.text.trim(), date: date as string, ...reminder }));
        return `${date} 메모를 추가했어요: ${command.text.trim()}${this.reminderDescription(reminder)}`;
      }
      case 'memo.update':
      case 'memo.complete': {
        if (!text(command.target)) return '변경할 메모 내용을 알려 주세요.';
        if (command.name === 'memo.complete' && typeof command.completed !== 'boolean') return '완료할지 완료를 취소할지 알려 주세요.';
        if (command.name === 'memo.update' && command.text === undefined && !Object.hasOwn(command, 'reminder')) return '메모 내용이나 알림 시간을 어떻게 바꿀지 알려 주세요.';
        if (command.text !== undefined && !text(command.text)) return '메모 내용은 1~1,000자로 입력해 주세요.';
        // Validate all changes before asking which target to use or touching storage.
        const reminder = Object.hasOwn(command, 'reminder') ? this.reminder(command.reminder) : null;
        const target = selected ?? this.findTarget(command, date as string);
        if (typeof target === 'string') return target;
        if (command.name === 'memo.complete') {
          done(this.ports.completeMemo(target.id, command.completed as boolean));
          return `${target.date} “${target.text}” 메모의 ${command.completed ? '완료를 기록했어요.' : '완료를 취소했어요.'}`;
        }
        const draft: MemoDraft = { date: target.date, text: command.text === undefined ? target.text : (command.text as string).trim(),
          reminderTime: target.reminderTime, ...(target.schedule ? { schedule: target.schedule } : {}), ...reminder };
        done(this.ports.updateMemo(target.id, draft));
        return `${target.date} 메모를 수정했어요: ${draft.text}${this.reminderDescription(draft)}`;
      }
      case 'work.get': return this.workStatus();
      case 'work.update': return this.updateWork(command);
      case 'character.walk':
        if (typeof command.enabled !== 'boolean') return '자유 이동을 켤지 끌지 알려 주세요.';
        this.ports.setWalking(command.enabled);
        return command.enabled ? '자유 이동을 켰어요. 말풍선을 닫으면 다시 움직여요.' : '자유 이동을 멈췄어요.';
      case 'ui.open':
        if (!['chat', 'work', 'memos', 'appearance', 'settings'].includes(command.target as string)) return '대화·근무·메모·캐릭터·설정 중 열 화면을 알려 주세요.';
        this.ports.open(command.target as PanelTab | 'chat');
        return `${{ chat: '대화', work: '근무', memos: '메모', appearance: '캐릭터', settings: '설정' }[command.target as PanelTab | 'chat']} 화면을 열었어요.`;
      case 'summary.get': {
        const pending = this.ports.memos().filter(memo => memo.date === localMemoDate(this.now()) && !memo.completed);
        return `${this.workStatus()}\n\n오늘 남은 할 일 ${pending.length}개\n${this.memoList(pending, '모든 할 일을 완료했어요.')}`;
      }
      default: return '지원하지 않는 앱 명령이에요.';
    }
  }

  private reminder(value: unknown): Pick<MemoDraft, 'reminderTime' | 'schedule'> {
    if (value === undefined || value === null) return { reminderTime: null, schedule: null };
    if (!record(value) || typeof value.kind !== 'string') throw new Error();
    const keys = value.kind === 'after' ? ['kind', 'minutes'] : value.kind === 'weekly' ? ['kind', 'time', 'weekdays'] : ['kind', 'time'];
    if (Object.keys(value).some(key => !keys.includes(key))) throw new Error();
    if (value.kind === 'after') {
      if (!Number.isSafeInteger(value.minutes) || Number(value.minutes) < 1 || Number(value.minutes) > 525600) throw new Error();
      const dueAt = this.now() + Number(value.minutes) * 60000;
      if (!Number.isSafeInteger(dueAt) || !Number.isFinite(new Date(dueAt).getTime())) throw new Error();
      return { reminderTime: null, schedule: { kind: 'once', dueAt } };
    }
    if (!clock(value.time)) throw new Error();
    if (value.kind === 'clock') return { reminderTime: value.time, schedule: undefined };
    if (value.kind === 'daily') return { reminderTime: value.time, schedule: { kind: 'daily', time: value.time } };
    if (value.kind === 'weekly' && Array.isArray(value.weekdays) && value.weekdays.length >= 1 && value.weekdays.length <= 7
      && value.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6) && new Set(value.weekdays).size === value.weekdays.length) {
      return { reminderTime: value.time, schedule: { kind: 'weekly', time: value.time, weekdays: [...value.weekdays].sort() } };
    }
    throw new Error();
  }

  private findTarget(command: Command, date: string): Memo | string {
    const query = normalize(command.target as string);
    const candidates = this.ports.memos().filter(memo => memo.date === date && normalize(memo.text).includes(query));
    if (!candidates.length) return '해당 메모를 찾지 못했어요. 메모 목록이나 정확한 내용을 알려 주세요.';
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 20) return `해당하는 메모가 ${candidates.length}개예요. 검색어를 더 구체적으로 알려 주세요.`;
    this.pending = { command, date, implicitDate: command.date === undefined, candidates: candidates.map(memo => ({ id: memo.id, revision: revision(memo), text: memo.text })) };
    return `어느 메모를 바꿀까요? 번호나 전체 메모 내용을 알려 주세요.\n${candidates.map((memo, index) => `${index + 1}. [${memo.date}] ${excerpt(memo.text)}`).join('\n')}`;
  }

  private selectedPending(question: string): string | null {
    const pending = this.pending;
    if (!pending) return null;
    const input = normalize(question).replace(/[.!?。]$/, '');
    if (/^(취소|그만|아니|하지 마|하지마)$/.test(input)) { this.pending = null; return '메모 변경을 취소했어요.'; }
    let index = -1;
    const numeric = input.match(/^(?:메모\s*)?([1-9]|1[0-9]|20)\s*(?:번|번째)?(?:\s*(?:메모|거|것|으로|요|로|해줘|해 주세요))*$/);
    const ordinalMatch = input.replace(/\s/g, '').match(/^(첫|두|세|네|다섯)번째(?:메모|거|것)?(?:로|으로)?(?:해줘|해주세요|요)?$/);
    const ordinal = ordinalMatch ? ['첫', '두', '세', '네', '다섯'].indexOf(ordinalMatch[1]) : -1;
    if (numeric) index = Number(numeric[1]) - 1;
    else if (ordinal >= 0) index = ordinal;
    else {
      const exact = pending.candidates.flatMap((memo, candidateIndex) => normalize(memo.text) === input ? [candidateIndex] : []);
      if (exact.length > 1) return '같은 내용의 메모가 여러 개예요. 위 목록의 번호로 골라 주세요.';
      index = exact[0] ?? -1;
    }
    if (index < 0 || index >= pending.candidates.length) return null;
    if (pending.implicitDate && pending.date !== localMemoDate(this.now())) {
      this.pending = null;
      return '날짜가 바뀌었어요. 변경할 날짜와 메모를 다시 알려 주세요.';
    }
    this.pending = null;
    const previous = pending.candidates[index];
    const current = this.ports.memos().find(memo => memo.id === previous.id);
    if (!current || current.date !== pending.date || revision(current) !== previous.revision) return '그 메모가 변경되었어요. 현재 메모 내용을 기준으로 다시 요청해 주세요.';
    return this.execute(pending.command, current);
  }

  private updateWork(command: Command): string {
    const existing = this.ports.workSchedule();
    const date = command.date === undefined ? existing?.date ?? localDateKey(new Date(this.now())) : command.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '근무 날짜를 YYYY-MM-DD 형식으로 알려 주세요.';
    const sameDate = existing?.date === date ? existing : null;
    const startTime = command.startTime === undefined ? sameDate?.startTime : command.startTime;
    const endTime = command.endTime === undefined ? (command.startTime !== undefined && clock(startTime) ? defaultEndTime(startTime) : sameDate?.endTime) : command.endTime;
    const schedule = { date, startTime, endTime };
    if (!validateWorkSchedule(schedule)) return '근무 날짜와 출근·퇴근 시간을 알려 주세요. 출근과 퇴근은 서로 다른 시각이어야 해요.';
    done(this.ports.saveWorkSchedule(schedule));
    return `${schedule.date} 근무 시간을 ${schedule.startTime}~${schedule.endTime}로 저장했어요.`;
  }

  private workStatus(): string {
    const schedule = this.ports.workSchedule();
    if (!schedule) return '등록된 근무 시간이 없어요. 출근·퇴근 시간을 알려 주세요.';
    const progress = getWorkProgress(schedule, new Date(this.now()));
    const remaining = progress.remainingMinutes ?? 0;
    return `등록된 근무: ${schedule.date} ${schedule.startTime}~${progress.isOvernight ? '다음날 ' : ''}${schedule.endTime}\n퇴근 HP ${progress.hp}% · ${progress.phase === 'finished' ? '퇴근 완료' : `퇴근까지 ${Math.floor(remaining / 60)}시간 ${remaining % 60}분`}`;
  }

  private memoList(items: Memo[], empty: string): string {
    if (!items.length) return empty;
    const shown = items.slice(0, 20);
    return `${shown.map((memo, index) => `${index + 1}. [${memo.date}] ${memo.completed ? '[완료] ' : ''}${excerpt(memo.text)}${this.reminderDescription(memo)}`).join('\n')}${items.length > shown.length ? `\n총 ${items.length}개 중 ${shown.length}개를 표시했어요. 검색어로 범위를 좁혀 주세요.` : ''}`;
  }
  private reminderDescription(draft: Pick<MemoDraft, 'reminderTime' | 'schedule'>): string {
    const schedule: MemoSchedule | null | undefined = draft.schedule;
    if (schedule?.kind === 'once') return ` (${new Date(schedule.dueAt).toLocaleString('ko-KR')} 알림)`;
    if (schedule?.kind === 'daily') return ` (매일 ${schedule.time} 알림)`;
    if (schedule?.kind === 'weekly') return ` (매주 ${schedule.weekdays.map(day => weekdays[day]).join('·')} ${schedule.time} 알림)`;
    return draft.reminderTime ? ` (${draft.reminderTime} 알림)` : '';
  }
}
