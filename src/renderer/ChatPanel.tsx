import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_CHAT_QUESTION_LENGTH, type ChatState } from '../shared/chat';
import type { CompanionApi } from '../shared/contracts';
import { displayShortcut, shortcutFromEvent } from './shortcut';

function ThinkingDots() {
  return <span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span>;
}

export function ChatPanel({ chat, companion, active, shortcut, shortcutRegistered, shortcutError, characterName = '돌멩이' }: {
  characterName?: string;
  chat: ChatState;
  companion: CompanionApi;
  active: boolean;
  shortcut: string;
  shortcutRegistered: boolean;
  shortcutError: string | null;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [localShortcutError, setLocalShortcutError] = useState<string | null>(null);
  const [savingShortcut, setSavingShortcut] = useState(false);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [shortcutSaved, setShortcutSaved] = useState(false);
  const shortcutInFlight = useRef(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const chatKeyError = localShortcutError || shortcutError;
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
  }, [chat.messages, thinking, chat.conversationId, settingsOpen]);

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

  async function captureShortcut(event: React.KeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) { event.currentTarget.blur(); return; }
    if (event.repeat || shortcutInFlight.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    const value = shortcutFromEvent(event);
    if (!value) {
      if (!['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) setLocalShortcutError('⌘, ⌃, ⌥ 중 하나와 함께 눌러 주세요.');
      return;
    }
    shortcutInFlight.current = true;
    setSavingShortcut(true);
    setLocalShortcutError(null);
    setShortcutSaved(false);
    try {
      const result = await companion.setChatShortcut(value);
      if (!result.ok) setLocalShortcutError(result.error || '이 단축키는 사용할 수 없어요. 다른 조합을 눌러 주세요.');
      else { setShortcutSaved(true); setCapturingShortcut(false); }
    } catch { setLocalShortcutError('대화 단축키를 저장하지 못했어요. 다시 눌러 주세요.'); }
    finally { shortcutInFlight.current = false; setSavingShortcut(false); }
  }

  const error = actionError || chat.error;
  const statusText = thinking ? '응답 생성 중…'
    : chat.status === 'cancelled' ? '요청을 취소했어요. 다음 질문을 이어가세요.'
    : chat.status === 'answered' ? '답변이 도착했어요.'
    : chat.status === 'error' ? '답변을 받지 못했어요.' : '궁금한 내용을 물어보세요.';
  const needsSetup = chat.connection.status === 'not-installed' || chat.connection.status === 'unauthenticated';
  const hasPendingAssistant = chat.messages.some((message) => message.role === 'assistant' && message.status === 'pending');

  return <section className="chat-panel" aria-label="AI 대화" data-testid="chat-panel" onKeyDown={(event) => {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    event.stopPropagation();
    if (settingsOpen) { setSettingsOpen(false); settingsButtonRef.current?.focus(); }
    else companion.closeChat();
  }}>
    <header className="panel-header chat-header">
      <div className="brand"><span className="brand-stone" aria-hidden="true">• •</span><span>{characterName}와 대화</span></div>
      <div className="chat-header-actions">
        <button ref={settingsButtonRef} type="button" className="icon-button chat-settings-toggle" aria-label="대화 설정" title="대화 설정" aria-expanded={settingsOpen} aria-controls="chat-settings" data-testid="chat-settings-toggle" onClick={() => setSettingsOpen((value) => !value)}><svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="6" cy="4" r="1.5" fill="#f8f8f2" stroke="currentColor" strokeWidth="1.2" /><circle cx="10" cy="8" r="1.5" fill="#f8f8f2" stroke="currentColor" strokeWidth="1.2" /><circle cx="6" cy="12" r="1.5" fill="#f8f8f2" stroke="currentColor" strokeWidth="1.2" /></svg></button>
        <button type="button" className="text-button" data-testid="new-conversation" disabled={resetting} title="현재 대화를 지우고 새 대화 시작" onClick={() => void newConversation()}>{resetting ? '시작 중…' : '새 대화'}</button>
        <button type="button" className="icon-button" aria-label="대화 창 닫기" title="닫아도 대화는 이어져요" data-testid="close-chat" onClick={() => companion.closeChat()}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg></button>
      </div>
    </header>
    <section id="chat-settings" className="chat-settings" aria-label="대화 설정" hidden={!settingsOpen} data-testid="chat-settings">
      <div className="shortcut-label"><label className="field-label" htmlFor="chat-shortcut-input">대화 창 열기 단축키</label>{shortcutSaved && <span className="saved-indicator" role="status">저장됨</span>}</div>
      <input id="chat-shortcut-input" className={`shortcut-input ${capturingShortcut ? 'capturing' : ''}`} aria-label="대화 단축키 변경" aria-describedby="chat-shortcut-hint" type="text" readOnly value={capturingShortcut ? '새 조합 키를 눌러 주세요' : displayShortcut(shortcut)} onFocus={() => { setCapturingShortcut(true); setShortcutSaved(false); }} onBlur={() => setCapturingShortcut(false)} onKeyDown={captureShortcut} aria-busy={savingShortcut} data-testid="chat-shortcut-input" />
      <p id="chat-shortcut-hint" className="field-hint">입력칸을 선택하고 새 조합 키를 눌러 주세요. 숨기기와 다른 조합을 사용하세요. 앱 종료 시 초기화돼요.</p>
      {!shortcutRegistered && !chatKeyError && <p className="inline-error" role="alert">대화 단축키를 등록하지 못했어요. 다른 조합으로 바꿔 주세요.</p>}
      {chatKeyError && <p className="inline-error" role="alert" data-testid="chat-shortcut-error">{chatKeyError}</p>}
    </section>
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
      {chat.messages.length === 0 && <div className="chat-empty"><span className="chat-empty-stone" aria-hidden="true">• •</span><h1>무슨 이야기를 해볼까요?</h1><p>질문과 답변이 여기에 쌓여요.<br />‘새 대화’를 누르기 전까지 이어서 기억해요.</p><div className="chat-examples" aria-label="이렇게 물어보세요">{['남은 할 일 보여줘', '10분 뒤 물 마시기 추가해줘', '물 마시기 완료해줘', '오늘 퇴근시간을 19시로 바꿔줘', '이동 멈춰줘'].map(example => <button type="button" className="text-button" key={example} onClick={() => { setDraft(example); textareaRef.current?.focus(); }}>{example}</button>)}</div><p className="chat-memory-hint">일반 대화에는 앱 데이터를 자동으로 보내지 않아요.<br />요청한 조회 결과는 대화 이력에 남아요.<br />대화는 앱을 종료하면 사라져요.</p></div>}
      {chat.messages.map((message) => <article className={`chat-message chat-message-${message.role}`} key={message.id} data-testid={`chat-message-${message.role}`} data-status={message.status}>
        <span className="chat-message-label">{message.role === 'user' ? '나' : characterName}</span>
        <div className="chat-message-body">{message.status === 'pending' && message.role === 'assistant' ? <span className="chat-thinking"><ThinkingDots />응답 생성 중…</span> : message.text}</div>
        {message.role === 'user' && (message.status === 'cancelled' || message.status === 'error') && <span className="chat-message-status">{message.status === 'cancelled' ? '답변 요청 취소됨' : '답변을 받지 못했어요'}</span>}
      </article>)}
      {thinking && !hasPendingAssistant && <article className="chat-message chat-message-assistant" data-testid="chat-thinking"><span className="chat-message-label">{characterName}</span><div className="chat-message-body chat-thinking"><ThinkingDots />응답 생성 중…</div></article>}
    </div>
    <form className="chat-question-form" onSubmit={sendQuestion}>
      <p className="chat-context-hint" id="chat-context-hint">새 대화 전까지 기억해요 · 앱 종료 시 초기화<br />앱 정보는 요청할 때만 조회하며 결과는 이력에 남아요.</p>
      <div className="chat-editor-heading"><label className="field-label" htmlFor="chat-question">질문</label><span className="chat-character-count">{draft.length.toLocaleString()} / {MAX_CHAT_QUESTION_LENGTH.toLocaleString()}</span></div>
      <textarea ref={textareaRef} id="chat-question" value={draft} maxLength={MAX_CHAT_QUESTION_LENGTH} disabled={resetting} rows={2} placeholder="무엇이 궁금한가요?" aria-describedby="chat-context-hint" data-testid="chat-question" onChange={(event) => { setDraft(event.target.value); setActionError(null); }} onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
      }} />
      <div className="chat-question-actions">
        <span className="chat-request-status" role="status" data-testid="chat-request-status">{statusText}</span>
        {thinking && chat.requestId ? <button type="button" className="text-button chat-cancel-button" disabled={cancelling || resetting} data-testid="cancel-chat-question" onClick={() => void cancelQuestion()}>{cancelling ? '취소 중…' : '취소'}</button> : <button type="submit" className="apply-button" disabled={busy || checkingConnection || !ready || !draft.trim()} data-testid="send-chat-question">{sending ? '보내는 중' : '보내기'}</button>}
      </div>
      {error && <p className="inline-error chat-error" role="alert" data-testid="chat-error">{error}</p>}
      <span className="chat-input-hint">Enter 보내기 · Shift+Enter 줄바꿈</span>
    </form>
  </section>;
}
