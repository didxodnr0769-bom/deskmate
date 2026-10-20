import React, { useCallback, useRef, useState } from 'react';
import type { CommandResult, CompanionApi, Memo, MemoDraft, MemoSchedule } from '../shared/contracts';

const MEMO_LIMIT = 1000;

type ReminderMode = 'none' | 'time' | 'relative' | 'daily' | 'weekly';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const isTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

function initialMode(memo?: Memo): ReminderMode {
  if (memo?.schedule?.kind === 'once') return 'relative';
  if (memo?.schedule?.kind === 'daily') return 'daily';
  if (memo?.schedule?.kind === 'weekly') return 'weekly';
  return memo?.reminderTime ? 'time' : 'none';
}

function formatDueAt(dueAt: number): string {
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(dueAt));
}

function reminderLabel(memo: Memo): string | null {
  const schedule = memo.schedule;
  if (schedule?.kind === 'once') return `한 번 · ${formatDueAt(schedule.dueAt)}`;
  if (schedule?.kind === 'daily') return `매일 · ${schedule.time}`;
  if (schedule?.kind === 'weekly') return `매주 ${[...schedule.weekdays].sort((a, b) => a - b).map(day => WEEKDAYS[day]).join('·')} · ${schedule.time}`;
  return memo.reminderTime ? `시각 한 번 · ${memo.reminderTime}` : null;
}

interface MemoEditorProps {
  scope: string;
  initialMemo?: Memo;
  disabled: boolean;
  busy: boolean;
  onSubmit(draft: MemoDraft): Promise<CommandResult>;
  onSaved?(): void;
  onCancel?(): void;
}

function MemoEditor({ scope, initialMemo, disabled, busy, onSubmit, onSaved, onCancel }: MemoEditorProps) {
  // These are deliberately initialized once. Clock ticks and parent state updates
  // must never replace an in-progress addition or edit.
  const [text, setText] = useState(initialMemo?.text || '');
  const [mode, setMode] = useState<ReminderMode>(() => initialMode(initialMemo));
  const [reminder, setReminder] = useState(() => initialMemo?.schedule?.kind === 'daily' || initialMemo?.schedule?.kind === 'weekly' ? initialMemo.schedule.time : initialMemo?.reminderTime || '');
  const [minutes, setMinutes] = useState('10');
  const [weekdays, setWeekdays] = useState<number[]>(() => initialMemo?.schedule?.kind === 'weekly' ? [...initialMemo.schedule.weekdays] : []);
  const [keepOriginalOnce, setKeepOriginalOnce] = useState(initialMemo?.schedule?.kind === 'once');
  const originalOnce = useRef(initialMemo?.schedule?.kind === 'once' ? { ...initialMemo.schedule } : null);
  const [error, setError] = useState<string | null>(null);
  const reminderInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const textId = `${scope}-text`;
  const reminderId = `${scope}-reminder`;
  const errorId = `${scope}-error`;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submitting.current) return;
    const trimmed = text.trim();
    if (!trimmed) { setError('메모 내용을 입력해 주세요.'); return; }
    if (trimmed.length > MEMO_LIMIT) { setError(`메모는 ${MEMO_LIMIT}자까지 입력할 수 있어요.`); return; }
    let schedule: MemoSchedule | null | undefined;
    let reminderTime: string | null = null;
    if (mode === 'none') schedule = null;
    else if (mode === 'relative') {
      if (keepOriginalOnce && originalOnce.current) schedule = { ...originalOnce.current };
      else {
        const value = Number(minutes);
        const dueAt = Date.now() + value * 60_000;
        if (!minutes.trim() || !Number.isSafeInteger(value) || value < 1 || !Number.isFinite(new Date(dueAt).getTime())) { setError('몇 분 뒤에 알릴지 1 이상의 정수로 입력해 주세요.'); return; }
        schedule = { kind: 'once', dueAt };
      }
    } else {
      if (reminderInput.current?.validity.badInput || !isTime(reminder)) { setError('알림 시간을 HH:mm 형식으로 입력해 주세요.'); return; }
      if (mode === 'time') reminderTime = reminder;
      else if (mode === 'daily') schedule = { kind: 'daily', time: reminder };
      else {
        if (!weekdays.length) { setError('반복할 요일을 하나 이상 선택해 주세요.'); return; }
        schedule = { kind: 'weekly', time: reminder, weekdays: [...weekdays].sort((a, b) => a - b) };
      }
    }
    const draft: MemoDraft = { text: trimmed, reminderTime, ...(schedule !== undefined ? { schedule } : {}) };
    setError(null);
    submitting.current = true;
    try {
      const saved = await onSubmit(draft);
      if (!saved.ok) { setError(saved.error || '메모를 저장하지 못했어요. 다시 시도해 주세요.'); return; }
      if (onSaved) onSaved();
      else { setText(''); setMode('none'); setReminder(''); setMinutes('10'); setWeekdays([]); setKeepOriginalOnce(false); }
    } catch { setError('메모를 저장하지 못했어요. 다시 시도해 주세요.'); }
    finally { submitting.current = false; }
  }

  return <form className={`memo-editor ${initialMemo ? 'memo-edit-form' : 'memo-add-form'}`} noValidate onSubmit={submit} aria-busy={busy} data-testid={`${scope}-form`}>
    <div className="memo-editor-heading"><label className="field-label" htmlFor={textId}>{initialMemo ? '메모 수정' : '새 메모'}</label><span className="memo-count" id={`${scope}-count`}>{text.length}/{MEMO_LIMIT}</span></div>
    <textarea id={textId} value={text} maxLength={MEMO_LIMIT} rows={3} disabled={disabled} aria-describedby={`${scope}-count${error ? ` ${errorId}` : ''}`} aria-invalid={Boolean(error)} data-testid={textId} placeholder="해야 할 일을 적어 주세요." onChange={(event) => { setText(event.target.value); setError(null); }} />
    <div className="memo-schedule-heading"><label className="field-label" htmlFor={`${scope}-reminder-mode`}>알림 방식</label>{mode !== 'none' && <button className="text-button" type="button" disabled={disabled} data-testid={`${scope}-clear-reminder`} onClick={() => { setMode('none'); setReminder(''); setMinutes('10'); setWeekdays([]); setKeepOriginalOnce(false); setError(null); }}>해제</button>}</div>
    <select id={`${scope}-reminder-mode`} className="memo-reminder-mode" value={mode} disabled={disabled} data-testid={`${scope}-reminder-mode`} onChange={(event) => { setMode(event.target.value as ReminderMode); setKeepOriginalOnce(false); setError(null); }}>
      <option value="none">알림 없음</option><option value="time">시각 한 번</option><option value="relative">몇 분 뒤</option><option value="daily">매일</option><option value="weekly">요일 반복</option>
    </select>
    {mode === 'relative' && (keepOriginalOnce && originalOnce.current ? <div className="memo-existing-reservation"><p data-testid={`${scope}-existing-reservation`}>예약: {formatDueAt(originalOnce.current.dueAt)}</p><button type="button" className="text-button" disabled={disabled} data-testid={`${scope}-reschedule`} onClick={() => { setKeepOriginalOnce(false); setError(null); }}>다시 예약</button><span>내용만 수정하면 기존 예약 시각을 유지해요.</span></div> : <><label className="field-label" htmlFor={`${scope}-minutes`}>몇 분 뒤에 알릴까요?</label><div className="memo-relative-row"><input id={`${scope}-minutes`} type="number" inputMode="numeric" min="1" step="1" value={minutes} disabled={disabled} data-testid={`${scope}-minutes`} onChange={(event) => { setMinutes(event.target.value); setError(null); }} /><span>분 뒤 한 번</span></div><p className="memo-schedule-hint">저장하는 순간부터 시간을 계산해요.</p></>)}
    {(mode === 'time' || mode === 'daily' || mode === 'weekly') && <><label className="field-label" htmlFor={reminderId}>알림 시간</label><div className="memo-reminder-row"><input ref={reminderInput} id={reminderId} type="time" step="60" value={reminder} disabled={disabled} aria-describedby={error ? errorId : undefined} data-testid={reminderId} onChange={(event) => { setReminder(event.target.value); setError(null); }} /></div>{mode === 'time' && <p className="memo-schedule-hint">지난 시간이면 내일, 현재 분이면 바로 한 번 알려드려요.</p>}</>}
    {mode === 'weekly' && <fieldset className="memo-weekdays" disabled={disabled}><legend className="field-label">반복 요일</legend>{WEEKDAYS.map((label, day) => <label key={day}><input type="checkbox" checked={weekdays.includes(day)} data-testid={`${scope}-weekday-${day}`} onChange={(event) => { setWeekdays((current) => event.target.checked ? [...current, day] : current.filter(value => value !== day)); setError(null); }} /><span>{label}</span></label>)}</fieldset>}
    {error && <p className="inline-error" id={errorId} role="alert" data-testid={errorId}>{error}</p>}
    <div className="memo-editor-actions">{onCancel && <button className="text-button" type="button" disabled={busy} data-testid={`${scope}-cancel`} onClick={onCancel}>취소</button>}<button className="apply-button" type="submit" disabled={disabled} data-testid={`${scope}-submit`}>{busy ? '저장 중' : initialMemo ? '저장' : '추가'}</button></div>
  </form>;
}

type Mutate = (key: string, action: () => Promise<CommandResult>) => Promise<CommandResult>;

function MemoItem({ memo, companion, disabled, busyKey, mutate }: { memo: Memo; companion: CompanionApi; disabled: boolean; busyKey: string | null; mutate: Mutate }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scope = `memo-edit-${memo.id}`;
  const busy = busyKey?.endsWith(`:${memo.id}`) || false;
  const reservation = reminderLabel(memo);

  async function setCompleted() {
    setError(null);
    const result = await mutate(`complete:${memo.id}`, () => companion.setMemoCompleted(memo.id, !memo.completed));
    if (!result.ok) setError(result.error || '완료 상태를 저장하지 못했어요.');
  }

  async function remove() {
    setError(null);
    const result = await mutate(`delete:${memo.id}`, () => companion.deleteMemo(memo.id));
    if (!result.ok) setError(result.error || '메모를 삭제하지 못했어요.');
  }

  return <li className={`memo-item ${memo.completed ? 'completed' : ''}`} data-testid={`memo-item-${memo.id}`} aria-busy={busy}>
    {editing ? <MemoEditor scope={scope} initialMemo={memo} disabled={disabled} busy={busyKey === `edit:${memo.id}`} onSubmit={(draft) => mutate(`edit:${memo.id}`, () => companion.updateMemo(memo.id, draft))} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} /> : <>
      <label className="memo-check"><input type="checkbox" checked={memo.completed} disabled={disabled} aria-label={memo.completed ? '메모 완료 취소' : '메모 완료'} aria-describedby={`memo-body-${memo.id}`} data-testid={`memo-complete-${memo.id}`} onChange={setCompleted} /><span className="memo-body" id={`memo-body-${memo.id}`}>{memo.text}</span></label>
      {reservation && <p className="memo-reminder" data-testid={`memo-reminder-${memo.id}`}>{reservation}</p>}
      {confirmDelete ? <div className="memo-delete-confirm" role="group" aria-label="메모 삭제 확인"><span>삭제할까요?</span><button className="text-button" type="button" disabled={busy} data-testid={`memo-delete-cancel-${memo.id}`} onClick={() => setConfirmDelete(false)}>취소</button><button className="text-button danger-button" type="button" disabled={disabled} data-testid={`memo-delete-confirm-${memo.id}`} onClick={remove}>삭제</button></div> : <div className="memo-item-actions"><button className="text-button" type="button" disabled={disabled} data-testid={`memo-edit-${memo.id}`} onClick={() => { setEditing(true); setConfirmDelete(false); setError(null); }}>수정</button><button className="text-button" type="button" disabled={disabled} data-testid={`memo-delete-${memo.id}`} onClick={() => { setConfirmDelete(true); setError(null); }}>삭제</button></div>}
      {error && <p className="inline-error" role="alert" data-testid={`memo-item-error-${memo.id}`}>{error}</p>}
    </>}
  </li>;
}

export function MemoPanel({ memos, memoError, reminderError, companion }: { memos: Memo[]; memoError: string | null; reminderError: string | null; companion: CompanionApi }) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mutate: Mutate = useCallback(async (key, action) => {
    if (memoError) return { ok: false, error: '메모를 불러오지 못해 변경할 수 없어요.' };
    if (busyRef.current) return { ok: false, error: '저장 중이에요. 잠시 후 다시 시도해 주세요.' };
    busyRef.current = true;
    setBusyKey(key);
    try {
      return await action();
    } catch {
      return { ok: false, error: '메모를 저장하지 못했어요. 다시 시도해 주세요.' };
    } finally { busyRef.current = false; setBusyKey(null); }
  }, [memoError]);
  const disabled = Boolean(memoError) || busyKey !== null;
  const pending = memos.filter((memo) => !memo.completed);
  const completed = memos.filter((memo) => memo.completed);

  return <section className="memo-panel" aria-label="메모 관리" data-testid="memo-panel">
    {memoError && <p className="memo-load-error" role="alert" data-testid="memo-load-error">메모를 불러오지 못해 변경할 수 없어요.<span>{memoError}</span></p>}
    <MemoEditor scope="memo-add" disabled={disabled} busy={busyKey === 'add'} onSubmit={(draft) => mutate('add', () => companion.addMemo(draft))} />
    <p className="memo-feature-hint">한 번 알림과 매일·요일 반복을 선택할 수 있어요. 완료한 메모는 알리지 않아요.</p>
    {reminderError && <p className="inline-error" role="alert" data-testid="memo-reminder-error">{reminderError}</p>}
    {!memos.length && !memoError && <p className="memo-empty" data-testid="memo-empty">메모가 없어요.</p>}
    {pending.length > 0 && <section className="memo-group" aria-label="할 일"><h2>할 일 <span>{pending.length}</span></h2><ul>{pending.map((memo) => <MemoItem key={memo.id} memo={memo} companion={companion} disabled={disabled} busyKey={busyKey} mutate={mutate} />)}</ul></section>}
    {completed.length > 0 && <section className="memo-group completed-group" aria-label="완료한 메모"><h2>완료 <span>{completed.length}</span></h2><ul>{completed.map((memo) => <MemoItem key={memo.id} memo={memo} companion={companion} disabled={disabled} busyKey={busyKey} mutate={mutate} />)}</ul></section>}
  </section>;
}
