import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_CHAT_QUESTION_LENGTH, type ChatState } from '../shared/chat';
import type { CompanionApi } from '../shared/contracts';

function ThinkingDots() {
  return <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>;
}

export function ChatPanel({ chat, companion, active, characterName = '돌멩이' }: {
  characterName?: string;
  chat: ChatState;
  companion: CompanionApi;
  active: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [resetting, setResetting] = useState(false);
  const checkInFlight = useRef(false);
  const sendInFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const resetInFlight = useRef(false);
  const checkedOnOpen = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const conversationRef = useRef(chat.conversationId);
  conversationRef.current = chat.conversationId;
  const thinking = chat.status === 'thinking';
  const busy = thinking || sending || resetting;
  const checkingConnection = checking || chat.connection.status === 'checking';
  const ready = chat.connection.status === 'ready';

  const checkConnection = useCallback(async () => {
    if (checkInFlight.current) return;
    checkInFlight.current = true;
    setChecking(true);
    setActionError(null);
    try { await companion.checkAgentConnection(); }
    catch { setActionError('연결을 확인하지 못했어요. 다시 시도해 주세요.'); }
    finally { checkInFlight.current = false; setChecking(false); }
  }, [companion]);

  useEffect(() => {
    if (!active || checkedOnOpen.current) return;
    checkedOnOpen.current = true;
    if (chat.connection.status === 'unchecked') void checkConnection();
  }, [active, chat.connection.status, checkConnection]);

  useEffect(() => companion.onChatFocus(() => textareaRef.current?.focus()), [companion]);
  useEffect(() => { if (active) textareaRef.current?.focus(); }, [active]);
  useEffect(() => {
    setDraft('');
    setActionError(null);
    nearBottom.current = true;
    if (active) textareaRef.current?.focus();
  }, [chat.conversationId]);
  useEffect(() => {
    if (!historyRef.current) return;
    if (chat.messages.length === 0) { historyRef.current.scrollTop = 0; return; }
    if (nearBottom.current) historyRef.current.scrollTop = historyRef.current.scrollHeight;
  }, [chat.messages, thinking, chat.conversationId]);

  async function sendQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sendInFlight.current || busy || !ready || checkingConnection) return;
    const question = draft.trim();
    if (!question) { setActionError('질문을 입력해 주세요.'); return; }
    if (question.length > MAX_CHAT_QUESTION_LENGTH) { setActionError(`질문은 ${MAX_CHAT_QUESTION_LENGTH.toLocaleString()}자까지 입력할 수 있어요.`); return; }
    const conversationId = chat.conversationId;
    sendInFlight.current = true;
    nearBottom.current = true;
    setSending(true);
    setActionError(null);
    try {
      const result = await companion.askQuestion(question);
      if (conversationRef.current !== conversationId) return;
      if (!result.ok) setActionError(result.error || '질문을 보내지 못했어요. 다시 시도해 주세요.');
      else setDraft((current) => current.trim() === question ? '' : current);
    } catch {
      if (conversationRef.current === conversationId) setActionError('질문을 보내지 못했어요. 다시 시도해 주세요.');
    } finally { sendInFlight.current = false; setSending(false); }
  }

  async function cancelQuestion() {
    if (!thinking || !chat.requestId || cancelInFlight.current) return;
    const requestId = chat.requestId;
    const conversationId = chat.conversationId;
    cancelInFlight.current = true;
    setCancelling(true);
    setActionError(null);
    try {
      const result = await companion.cancelQuestion(requestId);
      if (conversationRef.current === conversationId && !result.ok) setActionError(result.error || '답변 요청을 취소하지 못했어요. 다시 시도해 주세요.');
    } catch {
      if (conversationRef.current === conversationId) setActionError('답변 요청을 취소하지 못했어요. 다시 시도해 주세요.');
    } finally { cancelInFlight.current = false; setCancelling(false); }
  }

  async function newConversation() {
    if (resetInFlight.current) return;
    resetInFlight.current = true;
    setResetting(true);
    setActionError(null);
    try {
      const result = await companion.newConversation();
      if (!result.ok) setActionError(result.error || '새 대화를 시작하지 못했어요. 다시 시도해 주세요.');
      else { setDraft(''); nearBottom.current = true; textareaRef.current?.focus(); }
    } catch { setActionError('새 대화를 시작하지 못했어요. 다시 시도해 주세요.'); }
    finally {
      resetInFlight.current = false;
      setResetting(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  const error = actionError || chat.error;
  const statusText = thinking ? '응답 생성 중…'
    : chat.status === 'cancelled' ? '요청을 취소했어요. 다음 질문을 이어가세요.'
    : chat.status === 'answered' ? '답변이 도착했어요.'
    : chat.status === 'error' ? '답변을 받지 못했어요.' : '';
  const needsSetup = chat.connection.status === 'not-installed' || chat.connection.status === 'unauthenticated';
  const hasPendingAssistant = chat.messages.some((message) => message.role === 'assistant' && message.status === 'pending');

  return <section className="chat-panel" aria-label="AI 대화" data-testid="chat-panel" onKeyDown={(event) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    companion.closeChat();
  }}>
    <header className="panel-header chat-header">
      <div className="brand"><span className="brand-stone" aria-hidden="true">• •</span><span>{characterName}와 대화</span></div>
      <div className="chat-header-actions">
        <button type="button" className="text-button" data-testid="new-conversation" disabled={resetting} title="현재 대화를 지우고 새 대화 시작" onClick={() => void newConversation()}>{resetting ? '시작 중…' : '새 대화'}</button>
        <button type="button" className="icon-button" aria-label="대화 창 닫기" title="닫아도 대화는 이어져요" data-testid="close-chat" onClick={() => companion.closeChat()}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button>
      </div>
    </header>
    <div className="chat-connection-area">
      <div className="chat-connection" data-status={chat.connection.status}>
        <div className="chat-connection-info"><span className="chat-provider">{chat.providerLabel}</span><p role="status" data-testid="chat-connection-status">{chat.connection.message}</p></div>
        <button type="button" className="text-button chat-check-button" disabled={checkingConnection || busy} data-testid="check-agent-connection" onClick={() => void checkConnection()}>{checkingConnection ? '확인 중…' : chat.connection.status === 'unchecked' ? '연결 확인' : '다시 확인'}</button>
      </div>
      {needsSetup && <p className="chat-setup-hint" data-testid="chat-setup-hint">{chat.provider === 'codex' ? <>{chat.connection.status === 'not-installed' ? 'Codex CLI를 설치한 뒤 터미널에서 ' : '터미널에서 '}<code>codex login</code>으로 로그인하고 다시 확인해 주세요.</> : <>{chat.providerLabel} 연결 도구의 설치와 로그인을 확인한 뒤 다시 확인해 주세요.</>}</p>}
    </div>
    <div className="chat-history" ref={historyRef} role="log" aria-label="대화 이력" aria-live="polite" aria-relevant="additions text" tabIndex={0} data-testid="chat-history" onScroll={(event) => {
      const element = event.currentTarget;
      nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    }}>
      {chat.messages.length === 0 && <div className="chat-empty"><span className="chat-empty-stone" aria-hidden="true">• •</span><h1>무슨 이야기를 해볼까요?</h1><div className="chat-examples" aria-label="이렇게 물어보세요">{['남은 할 일 보여줘', '10분 뒤 물 마시기 추가해줘', '물 마시기 완료해줘', '오늘 퇴근시간을 19시로 바꿔줘', '이동 멈춰줘'].map(example => <button type="button" className="text-button" key={example} onClick={() => { setDraft(example); textareaRef.current?.focus(); }}>{example}</button>)}</div></div>}
      {chat.messages.map((message) => <article className={`chat-message chat-message-${message.role}`} key={message.id} data-testid={`chat-message-${message.role}`} data-status={message.status}>
        <span className="chat-message-label">{message.role === 'user' ? '나' : characterName}</span>
        <div className="chat-message-body">{message.status === 'pending' && message.role === 'assistant' ? <span className="chat-thinking"><ThinkingDots />응답 생성 중…</span> : message.text}</div>
        {message.role === 'user' && (message.status === 'cancelled' || message.status === 'error') && <span className="chat-message-status">{message.status === 'cancelled' ? '답변 요청 취소됨' : '답변을 받지 못했어요'}</span>}
      </article>)}
      {thinking && !hasPendingAssistant && <article className="chat-message chat-message-assistant" data-testid="chat-thinking"><span className="chat-message-label">{characterName}</span><div className="chat-message-body chat-thinking"><ThinkingDots />응답 생성 중…</div></article>}
    </div>
    <form className="chat-question-form" onSubmit={sendQuestion}>
      <div className="chat-editor-heading"><label className="field-label" htmlFor="chat-question">질문</label><span className="chat-character-count">{draft.length.toLocaleString()} / {MAX_CHAT_QUESTION_LENGTH.toLocaleString()}</span></div>
      <textarea ref={textareaRef} id="chat-question" value={draft} maxLength={MAX_CHAT_QUESTION_LENGTH} disabled={resetting} rows={2} placeholder="무엇이 궁금한가요?" data-testid="chat-question" onChange={(event) => { setDraft(event.target.value); setActionError(null); }} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
      }} />
      <div className="chat-question-actions">
        {statusText && <span className="chat-request-status" role="status" data-testid="chat-request-status">{statusText}</span>}
        {thinking && chat.requestId ? <button type="button" className="text-button chat-cancel-button" disabled={cancelling || resetting} data-testid="cancel-chat-question" onClick={() => void cancelQuestion()}>{cancelling ? '취소 중…' : '취소'}</button> : <button type="submit" className="apply-button" disabled={busy || checkingConnection || !ready || !draft.trim()} data-testid="send-chat-question">{sending ? '보내는 중' : '보내기'}</button>}
      </div>
      {error && <p className="inline-error chat-error" role="alert" data-testid="chat-error">{error}</p>}
      <span className="chat-input-hint">Enter 보내기 · Shift+Enter 줄바꿈</span>
    </form>
  </section>;
}
