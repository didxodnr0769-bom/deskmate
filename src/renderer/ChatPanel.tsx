import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_CHAT_QUESTION_LENGTH, type ChatState } from '../shared/chat';
import type { CompanionApi } from '../shared/contracts';

export function ChatPanel({ chat, companion, active }: { chat: ChatState; companion: CompanionApi; active: boolean }) {
  const [draft, setDraft] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const checkInFlight = useRef(false);
  const sendInFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const checkedOnOpen = useRef(false);
  const thinking = chat.status === 'thinking';
  const busy = thinking || sending;
  const checkingConnection = checking || chat.connection.status === 'checking';
  const ready = chat.connection.status === 'ready';

  const checkConnection = useCallback(async () => {
    if (checkInFlight.current) return;
    checkInFlight.current = true;
    setChecking(true);
    setActionError(null);
    try {
      // Connection details are published through the shared state; no local paths or keys are needed here.
      await companion.checkAgentConnection();
    } catch {
      setActionError('연결을 확인하지 못했어요. 다시 시도해 주세요.');
    } finally {
      checkInFlight.current = false;
      setChecking(false);
    }
  }, [companion]);

  useEffect(() => {
    if (!active || checkedOnOpen.current) return;
    checkedOnOpen.current = true;
    if (chat.connection.status === 'unchecked') void checkConnection();
  }, [active, chat.connection.status, checkConnection]);

  async function sendQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendInFlight.current || busy || !ready || checkingConnection) return;
    const question = draft.trim();
    if (!question) { setActionError('질문을 입력해 주세요.'); return; }
    if (question.length > MAX_CHAT_QUESTION_LENGTH) { setActionError(`질문은 ${MAX_CHAT_QUESTION_LENGTH.toLocaleString()}자까지 입력할 수 있어요.`); return; }
    sendInFlight.current = true;
    setSending(true);
    setActionError(null);
    try {
      const result = await companion.askQuestion(question);
      if (!result.ok) setActionError(result.error || '질문을 보내지 못했어요. 다시 시도해 주세요.');
      else setDraft((current) => current.trim() === question ? '' : current);
    } catch {
      setActionError('질문을 보내지 못했어요. 다시 시도해 주세요.');
    } finally {
      sendInFlight.current = false;
      setSending(false);
    }
  }

  async function cancelQuestion() {
    if (!thinking || !chat.requestId || cancelInFlight.current) return;
    const requestId = chat.requestId;
    cancelInFlight.current = true;
    setCancelling(true);
    setActionError(null);
    try {
      const result = await companion.cancelQuestion(requestId);
      if (!result.ok) setActionError(result.error || '답변 요청을 취소하지 못했어요. 다시 시도해 주세요.');
    } catch {
      setActionError('답변 요청을 취소하지 못했어요. 다시 시도해 주세요.');
    } finally {
      cancelInFlight.current = false;
      setCancelling(false);
    }
  }

  const error = actionError || chat.error;
  const statusText = thinking ? '답변을 기다리고 있어요…'
    : chat.status === 'cancelled' ? '답변 요청을 취소했어요.'
    : chat.status === 'answered' ? '답변이 도착했어요.'
    : chat.status === 'error' ? '답변을 받지 못했어요.' : '궁금한 내용을 물어보세요.';
  const needsSetup = chat.connection.status === 'not-installed' || chat.connection.status === 'unauthenticated';

  return <section className="chat-panel" aria-label="AI 대화" data-testid="chat-panel">
    <div className="chat-connection" data-status={chat.connection.status}>
      <div className="chat-connection-info">
        <span className="chat-provider">{chat.providerLabel}</span>
        <p role="status" data-testid="chat-connection-status">{chat.connection.message}</p>
      </div>
      <button type="button" className="text-button chat-check-button" disabled={checkingConnection || busy} data-testid="check-agent-connection" onClick={() => void checkConnection()}>{checkingConnection ? '확인 중…' : chat.connection.status === 'unchecked' ? '연결 확인' : '다시 확인'}</button>
    </div>
    {needsSetup && <p className="chat-setup-hint" data-testid="chat-setup-hint">{chat.provider === 'codex' ? <>{chat.connection.status === 'not-installed' ? 'Codex CLI를 설치한 뒤 터미널에서 ' : '터미널에서 '}<code>codex login</code>으로 로그인하고 다시 확인해 주세요.</> : <>{chat.providerLabel} 연결 도구의 설치와 로그인을 확인한 뒤 다시 확인해 주세요.</>}</p>}
    <p className="chat-context-hint" id="chat-context-hint">질문마다 새로 답하며, 이전 대화·메모·근무시간은 자동으로 보내지 않아요.</p>
    <form className="chat-question-form" onSubmit={sendQuestion}>
      <div className="chat-editor-heading"><label className="field-label" htmlFor="chat-question">질문</label><span className="chat-character-count">{draft.length.toLocaleString()} / {MAX_CHAT_QUESTION_LENGTH.toLocaleString()}</span></div>
      <textarea id="chat-question" value={draft} maxLength={MAX_CHAT_QUESTION_LENGTH} disabled={busy} rows={2} placeholder="무엇이 궁금한가요?" aria-describedby="chat-context-hint" data-testid="chat-question" onChange={(event) => { setDraft(event.target.value); setActionError(null); }} />
      <div className="chat-question-actions">
        <span className="chat-request-status" role="status" data-testid="chat-request-status">{statusText}</span>
        {thinking && chat.requestId ? <button type="button" className="text-button chat-cancel-button" disabled={cancelling} data-testid="cancel-chat-question" onClick={() => void cancelQuestion()}>{cancelling ? '취소 중…' : '취소'}</button> : <button type="submit" className="apply-button" disabled={busy || checkingConnection || !ready || !draft.trim()} data-testid="send-chat-question">{sending ? '보내는 중' : '보내기'}</button>}
      </div>
    </form>
    {error && <p className="inline-error chat-error" role="alert" data-testid="chat-error">{error}</p>}
    {chat.question && <div className="chat-current-question"><span className="field-label">보낸 질문</span><p data-testid="chat-current-question">{chat.question}</p></div>}
    <section className="chat-answer" aria-labelledby="chat-answer-label" aria-busy={thinking}>
      <h2 id="chat-answer-label">답변</h2>
      <div className={`chat-answer-body${chat.answer ? '' : ' chat-answer-empty'}`} tabIndex={0} role="region" aria-label="AI 답변 내용" data-testid="chat-answer">{chat.answer || (thinking ? '답변을 준비하고 있어요…' : chat.status === 'cancelled' ? '새 질문을 보내면 다시 답해 드려요.' : '답변이 여기에 표시돼요.')}</div>
    </section>
  </section>;
}
