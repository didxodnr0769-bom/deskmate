import React, { useCallback, useRef, useState } from 'react';
import type { CommandResult, CompanionApi, Memo, MemoDraft } from '../shared/contracts';

const MEMO_LIMIT = 1000;

function validateDraft(text: string, reminderTime: string, badInput: boolean): { draft: MemoDraft } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { error: '메모 내용을 입력해 주세요.' };
  if (trimmed.length > MEMO_LIMIT) return { error: `메모는 ${MEMO_LIMIT}자까지 입력할 수 있어요.` };
  if (badInput) return { error: '알림 시간을 올바르게 입력해 주세요.' };
  if (!reminderTime) return { draft: { text: trimmed, reminderTime: null } };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reminderTime)) return { error: '알림 시간을 HH:mm 형식으로 입력해 주세요.' };
  return { draft: { text: trimmed, reminderTime } };
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
  const [reminder, setReminder] = useState(initialMemo?.reminderTime || '');
  const [error, setError] = useState<string | null>(null);
  const reminderInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const textId = `${scope}-text`;
  const reminderId = `${scope}-reminder`;
  const errorId = `${scope}-error`;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || submitting.current) return;
    const result = validateDraft(text, reminder, Boolean(reminderInput.current?.validity.badInput));
    if ('error' in result) { setError(result.error); return; }
    setError(null);
    submitting.current = true;
    try {
      const saved = await onSubmit(result.draft);
      if (!saved.ok) { setError(saved.error || '메모를 저장하지 못했어요. 다시 시도해 주세요.'); return; }
      if (onSaved) onSaved();
      else { setText(''); setReminder(''); }
    } finally { submitting.current = false; }
  }

  return <form className={`memo-editor ${initialMemo ? 'memo-edit-form' : 'memo-add-form'}`} noValidate onSubmit={submit} aria-busy={busy} data-testid={`${scope}-form`}>
    <div className="memo-editor-heading"><label className="field-label" htmlFor={textId}>{initialMemo ? '메모 수정' : '새 메모'}</label><span className="memo-count" id={`${scope}-count`}>{text.length}/{MEMO_LIMIT}</span></div>
    <textarea id={textId} value={text} maxLength={MEMO_LIMIT} rows={3} disabled={disabled} aria-describedby={`${scope}-count${error ? ` ${errorId}` : ''}`} aria-invalid={Boolean(error)} data-testid={textId} placeholder="해야 할 일을 적어 주세요." onChange={(event) => { setText(event.target.value); setError(null); }} />
    <label className="field-label" htmlFor={reminderId}>알림 시간 <span className="optional-label">선택</span></label>
    <div className="memo-reminder-row"><input ref={reminderInput} id={reminderId} type="time" step="60" value={reminder} disabled={disabled} aria-describedby={error ? errorId : undefined} data-testid={reminderId} onChange={(event) => { setReminder(event.target.value); setError(null); }} /><button className="text-button" type="button" disabled={disabled} data-testid={`${scope}-clear-reminder`} onClick={() => { if (reminderInput.current) reminderInput.current.value = ''; setReminder(''); setError(null); }}>해제</button></div>
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
      {memo.reminderTime && <p className="memo-reminder" data-testid={`memo-reminder-${memo.id}`}>{memo.reminderTime}</p>}
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
    <p className="memo-feature-hint">선택한 시간에 한 번 알려드려요. 지난 시간이면 내일, 현재 분이면 바로 알려드려요.</p>
    {reminderError && <p className="inline-error" role="alert" data-testid="memo-reminder-error">{reminderError}</p>}
    {!memos.length && !memoError && <p className="memo-empty" data-testid="memo-empty">메모가 없어요.</p>}
    {pending.length > 0 && <section className="memo-group" aria-label="할 일"><h2>할 일 <span>{pending.length}</span></h2><ul>{pending.map((memo) => <MemoItem key={memo.id} memo={memo} companion={companion} disabled={disabled} busyKey={busyKey} mutate={mutate} />)}</ul></section>}
    {completed.length > 0 && <section className="memo-group completed-group" aria-label="완료한 메모"><h2>완료 <span>{completed.length}</span></h2><ul>{completed.map((memo) => <MemoItem key={memo.id} memo={memo} companion={companion} disabled={disabled} busyKey={busyKey} mutate={mutate} />)}</ul></section>}
  </section>;
}
