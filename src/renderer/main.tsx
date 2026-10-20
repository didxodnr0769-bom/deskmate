import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CompanionApi, CompanionState, HitRegion } from '../shared/contracts';
import { renderCharacterScene, SCENE_SIZE } from './character-runtime';
import { rock } from './characters/rock';
import { MemoPanel } from './MemoPanel';
import { ChatPanel } from './ChatPanel';
import './styles.css';

const api = window.companion;
const isWidget = window.location.hash === '#widget';
document.documentElement.dataset.surface = isWidget ? 'widget' : 'panel';

function useCompanionState() {
  const [state, setState] = useState<CompanionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!api) {
      setError('데스크톱 앱에서 열어 주세요.');
      return;
    }
    let active = true;
    let receivedState = false;
    // Subscribe first: an IPC update received during getState must win over that snapshot.
    const unsubscribe = api.onState((next) => {
      receivedState = true;
      if (active) { setState(next); setError(null); }
    });
    api.getState().then((initial) => {
      if (active && !receivedState) setState(initial);
    }).catch(() => {
      if (active && !receivedState) setError('앱 상태를 불러오지 못했어요. 앱을 다시 실행해 주세요.');
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  return { state, error };
}

function CloseIcon() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

function Widget({ state }: { state: CompanionState }) {
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const dragging = useRef<number | null>(null);
  const captureTarget = useRef<HTMLElement | null>(null);
  stateRef.current = state;

  useEffect(() => { setDismissError(null); }, [state.bubble?.id]);

  async function dismiss() {
    if (!state.bubble || dismissing) return;
    setDismissing(true);
    setDismissError(null);
    try {
      const result = await api.dismissBubble(state.bubble.id);
      if (!result.ok) setDismissError(result.error || '알림을 닫지 못했어요. 다시 시도해 주세요.');
    } catch { setDismissError('알림을 닫지 못했어요. 다시 시도해 주세요.'); }
    finally { setDismissing(false); }
  }

  const finishGesture = useCallback((point: { x: number; y: number } | null) => {
    const pointerId = dragging.current;
    if (pointerId === null) return;
    const target = captureTarget.current;
    // Clear first: pointerup, its mouseup fallback and capture loss may arrive together.
    dragging.current = null;
    captureTarget.current = null;
    if (point) api.endPointer(point);
    else api.cancelPointer();
    if (target?.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
  }, []);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (dragging.current === event.pointerId) api.movePointer({ x: event.screenX, y: event.screenY });
    };
    const end = (event: PointerEvent) => {
      if (dragging.current === event.pointerId) finishGesture({ x: event.screenX, y: event.screenY });
    };
    const cancel = (event: PointerEvent) => {
      if (dragging.current === event.pointerId) finishGesture(null);
    };
    const mouseUp = (event: MouseEvent) => {
      if (event.button === 0 && dragging.current !== null) finishGesture({ x: event.screenX, y: event.screenY });
    };
    const blur = () => finishGesture(null);
    const visibilityChange = () => { if (document.hidden) finishGesture(null); };

    // Native window movement can put the final target outside React's root. Observe the
    // window in capture phase and keep the gesture alive through lostpointercapture.
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('mouseup', mouseUp, true);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibilityChange);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('mouseup', mouseUp, true);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibilityChange);
      finishGesture(null);
    };
  }, [finishGesture]);

  useEffect(() => {
    if (!state.visible) {
      api.setHitRegions([]);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    let frameId = 0;
    let lastDrawAt = -Infinity;
    let lastHitUpdate = -Infinity;
    let previousHitRegions = '';
    let lastRatio = 0;
    let dirty = true;
    const markDirty = () => { dirty = true; };
    const resizeObserver = new ResizeObserver(markDirty);
    resizeObserver.observe(canvas);
    window.addEventListener('resize', markDirty);
    const draw = () => {
      const now = performance.now();
      if (now - lastDrawAt < 1000 / 30 - 0.5) {
        frameId = requestAnimationFrame(draw);
        return;
      }
      lastDrawAt = now;
      const current = stateRef.current;
      const ratio = window.devicePixelRatio || 1;
      if (ratio !== lastRatio) {
        canvas.width = Math.round(SCENE_SIZE.width * ratio);
        canvas.height = Math.round(SCENE_SIZE.height * ratio);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        lastRatio = ratio;
        dirty = true;
      }
      const frame = renderCharacterScene(context, rock, current, Date.now());
      // Keep the bubble just above the HP label, including while the character jumps.
      bubbleRef.current?.style.setProperty('--bubble-motion-y', `${frame.pose.y}px`);
      if (dirty || now - lastHitUpdate >= 50) {
        const bounds = canvas.getBoundingClientRect();
        const scaleX = bounds.width / SCENE_SIZE.width;
        const scaleY = bounds.height / SCENE_SIZE.height;
        const round = (value: number) => Math.round(value * 2) / 2;
        const regions: HitRegion[] = [
          { type: 'polygon', points: frame.polygon.map((p) => ({ x: round(bounds.left + p.x * scaleX), y: round(bounds.top + p.y * scaleY) })) },
          { type: 'rect', rect: { x: round(bounds.left + frame.hp.x * scaleX), y: round(bounds.top + (frame.hp.y - 16) * scaleY), width: round(frame.hp.width * scaleX), height: round((frame.hp.height + 16) * scaleY) } },
        ];
        if (bubbleRef.current && current.bubble) {
          const bubble = bubbleRef.current.getBoundingClientRect();
          regions.push({ type: 'rect', rect: { x: round(bubble.left), y: round(bubble.top), width: round(bubble.width), height: round(bubble.height + 8) } });
        }
        const serialized = JSON.stringify(regions);
        if (serialized !== previousHitRegions) {
          api.setHitRegions(regions);
          previousHitRegions = serialized;
        }
        lastHitUpdate = now;
        dirty = false;
      }
      frameId = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener('resize', markDirty);
      api.setHitRegions([]);
    };
  }, [state.visible]);

  return <main
    className="widget"
    data-testid="companion-widget"
    aria-label={`${rock.label} 데스크톱 동료`}
    tabIndex={0}
    onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); api.openPanel(); } }}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      // A fresh press also recovers from an OS-level release that never reached us.
      if (dragging.current !== null) finishGesture(null);
      dragging.current = event.pointerId;
      captureTarget.current = event.currentTarget;
      event.currentTarget.setPointerCapture(event.pointerId);
      api.beginPointer({ x: event.screenX, y: event.screenY });
    }}
  >
    <canvas className="character-canvas" ref={canvasRef} aria-hidden="true" data-testid="character-canvas" />
    <span className="sr-only" role="progressbar" aria-label="퇴근 HP" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(state.hp)} />
    {state.bubble && <div className={`notification-bubble${state.bubble.kind === 'chat' ? ' chat-answer-bubble' : ''}`} ref={bubbleRef} role="status" data-testid="notification-bubble"
      onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => event.stopPropagation()}>
      <div className="bubble-heading"><span className="bubble-dot" /><span>{state.bubble.kind === 'reminder' ? '메모 알림' : state.bubble.kind === 'chat' ? 'AI 답변' : '알림 미리보기'}</span><button type="button" className="bubble-close" aria-label={state.bubble.kind === 'chat' ? 'AI 답변 닫기' : '알림 닫기'} data-testid="dismiss-notification" disabled={dismissing} onClick={dismiss}><CloseIcon /></button></div>
      <p tabIndex={state.bubble.kind === 'chat' ? 0 : undefined}>{(dismissError || (state.bubble.kind === 'reminder' && state.reminderError)) && <><span className="inline-error" role="alert" data-testid={state.bubble.kind === 'reminder' ? 'reminder-error' : 'bubble-error'}>{dismissError || state.reminderError}</span><br /></>}{state.bubble.text}</p>
    </div>}
  </main>;
}

function displayShortcut(shortcut: string): string {
  return shortcut.split('+').map((part) => ({ CommandOrControl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Space: 'Space' }[part] || part)).join(' ');
}

function shortcutFromEvent(event: React.KeyboardEvent<HTMLInputElement>): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return null;
  if (!(event.metaKey || event.ctrlKey || event.altKey)) return null;
  const keys: Record<string, string> = {
    Space: 'Space', Escape: 'Escape', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete',
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    Tab: 'Tab', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
  };
  let key = keys[event.code];
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) key = event.code;
  if (!key) return null;
  return [event.metaKey && 'Command', event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

function localDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function isValidTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function defaultEndTime(startTime: string): string {
  if (!isValidTime(startTime)) return '';
  const [hours, minutes] = startTime.split(':').map(Number);
  const endMinutes = (hours * 60 + minutes + 9 * 60) % (24 * 60);
  return `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;
}

function remainingTime(minutes: number | null): string {
  if (minutes === null) return '—';
  const total = Math.max(0, Math.ceil(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours ? `${hours}시간${rest ? ` ${rest}분` : ''}` : `${rest}분`;
}

function Panel({ state, companion }: { state: CompanionState; companion: CompanionApi }) {
  const [tab, setTab] = useState<'work' | 'memos' | 'chat'>('work');
  const [date, setDate] = useState(() => state.workSchedule?.date || localDate());
  const [startTime, setStartTime] = useState(() => state.workSchedule?.startTime || '');
  const [endTime, setEndTime] = useState(() => state.workSchedule?.endTime || '');
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleSaved, setScheduleSaved] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [savingShortcut, setSavingShortcut] = useState(false);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [shortcutSaved, setShortcutSaved] = useState(false);
  const error = shortcutError || state.error;
  const savedDate = state.workSchedule?.date;
  const savedStart = state.workSchedule?.startTime;
  const savedEnd = state.workSchedule?.endTime;
  const hp = Math.floor(Math.max(0, Math.min(100, state.hp)));
  const { phase, remainingMinutes, isOvernight } = state.workProgress;
  const progressText = phase === 'unset'
    ? '출근·퇴근 시간을 입력해 주세요.'
    : phase === 'finished'
      ? '퇴근 완료'
      : `${phase === 'before' ? '출근 전 · ' : ''}퇴근까지 ${remainingTime(remainingMinutes)}`;

  // Progress updates every second. Only a changed saved schedule may replace drafts.
  useEffect(() => {
    setDate(savedDate || localDate());
    setStartTime(savedStart || '');
    setEndTime(savedEnd || '');
  }, [savedDate, savedStart, savedEnd]);

  function editSchedule() {
    setScheduleSaved(false);
    setScheduleError(null);
  }

  async function saveSchedule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingSchedule) return;
    setScheduleSaved(false);
    if (!isValidDate(date)) { setScheduleError('근무 날짜를 입력해 주세요.'); return; }
    if (!isValidTime(startTime)) { setScheduleError('출근 시간을 올바르게 입력해 주세요.'); return; }
    if (!isValidTime(endTime)) { setScheduleError('퇴근 시간을 올바르게 입력해 주세요.'); return; }
    if (startTime === endTime) { setScheduleError('출근 시간과 퇴근 시간을 다르게 입력해 주세요.'); return; }
    setScheduleError(null);
    setSavingSchedule(true);
    try {
      const result = await companion.setWorkSchedule({ date, startTime, endTime });
      if (!result.ok) setScheduleError(result.error || '출퇴근 시간을 저장하지 못했어요. 다시 적용해 주세요.');
      else setScheduleSaved(true);
    } catch {
      setScheduleError('출퇴근 시간을 저장하지 못했어요. 다시 적용해 주세요.');
    } finally { setSavingSchedule(false); }
  }

  async function captureShortcut(event: React.KeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.currentTarget.blur();
      return;
    }
    if (event.repeat || savingShortcut) return;
    const value = shortcutFromEvent(event);
    if (!value) {
      if (!['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) setShortcutError('⌘, ⌃, ⌥ 중 하나와 함께 눌러 주세요.');
      return;
    }
    setSavingShortcut(true);
    setShortcutError(null);
    setShortcutSaved(false);
    try {
      const result = await companion.setShortcut(value);
      if (!result.ok) setShortcutError(result.error || '이 단축키는 사용할 수 없어요. 다른 조합을 눌러 주세요.');
      else { setShortcutSaved(true); setCapturingShortcut(false); }
    } catch {
      setShortcutError('단축키를 저장하지 못했어요. 다시 눌러 주세요.');
    } finally { setSavingShortcut(false); }
  }

  return <main className="panel" data-testid="companion-panel">
    <header className="panel-header">
      <div className="brand"><span className="brand-stone" aria-hidden="true">• •</span><span>작은 동료</span></div>
      <button type="button" className="icon-button" aria-label="패널 닫기" data-testid="close-panel" onClick={() => companion.closePanel()}><CloseIcon /></button>
    </header>
    <div className="panel-tabs" role="tablist" aria-label="관리 항목" onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const tabs = ['work', 'memos', 'chat'] as const;
      const index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      setTab(next);
      document.getElementById(`${next}-tab`)?.focus();
    }}>
      <button type="button" role="tab" id="work-tab" aria-controls="work-tabpanel" aria-selected={tab === 'work'} tabIndex={tab === 'work' ? 0 : -1} data-testid="work-tab" onClick={() => setTab('work')}>근무</button>
      <button type="button" role="tab" id="memos-tab" aria-controls="memos-tabpanel" aria-selected={tab === 'memos'} tabIndex={tab === 'memos' ? 0 : -1} data-testid="memos-tab" onClick={() => setTab('memos')}>메모</button>
      <button type="button" role="tab" id="chat-tab" aria-controls="chat-tabpanel" aria-selected={tab === 'chat'} tabIndex={tab === 'chat' ? 0 : -1} data-testid="chat-tab" onClick={() => setTab('chat')}>대화</button>
    </div>
    <div className="panel-content">
      <div role="tabpanel" id="work-tabpanel" aria-labelledby="work-tab" hidden={tab !== 'work'}>
      <section className="settings-card work-card" aria-label="출퇴근 시간">
        <form className="schedule-form" onSubmit={saveSchedule} noValidate>
          <div className="date-field">
            <label className="field-label" htmlFor="work-date">근무 날짜</label>
            <input id="work-date" type="date" value={date} required disabled={savingSchedule} data-testid="work-date" onChange={(event) => { setDate(event.target.value); editSchedule(); }} />
          </div>
          <div className="time-fields">
            <div><label className="field-label" htmlFor="work-start">출근</label><input id="work-start" type="time" value={startTime} required disabled={savingSchedule} data-testid="work-start" onChange={(event) => { setStartTime(event.target.value); setEndTime(defaultEndTime(event.target.value)); editSchedule(); }} /></div>
            <div><label className="field-label" htmlFor="work-end">퇴근</label><input id="work-end" type="time" value={endTime} required disabled={savingSchedule} data-testid="work-end" onChange={(event) => { setEndTime(event.target.value); editSchedule(); }} /></div>
            <button className="apply-button" type="submit" disabled={savingSchedule} data-testid="apply-work-schedule">{savingSchedule ? '저장 중' : '적용'}</button>
          </div>
          {scheduleError && <p className="inline-error" role="alert" data-testid="work-error">{scheduleError}</p>}
        </form>
        <div className="setting-divider" />
        <div className="hp-label-row"><span className="setting-title">퇴근 HP</span>{scheduleSaved && <span className="saved-indicator" role="status">적용됨</span>}<output data-testid="hp-value">{hp}<small>%</small></output></div>
        <progress className="work-progress" max="100" value={hp} aria-label="퇴근 HP" data-testid="work-progress-bar">{hp}%</progress>
        <p className="work-status" data-testid="work-status">{progressText}</p>
        {savedDate && (savedDate !== localDate() || isOvernight) && <p className="schedule-anchor" data-testid="schedule-anchor">{savedDate !== localDate() ? `${savedDate.replaceAll('-', '.')} 기준` : ''}{isOvernight ? `${savedDate !== localDate() ? ' · ' : ''}다음날 퇴근` : ''}</p>}
      </section>

      <section className="utility-settings" aria-label="캐릭터 동작">
        <div className="setting-row"><label id="walking-label" className="setting-title">자유롭게 이동</label><button type="button" role="switch" aria-checked={state.walking} aria-labelledby="walking-label" className={`toggle ${state.walking ? 'on' : ''}`} data-testid="walking-toggle" onClick={() => companion.setWalking(!state.walking)}><span /></button></div>
        <button type="button" className="preview-button" data-testid="preview-notification" onClick={() => companion.previewNotification()}><svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 6.5a3.5 3.5 0 0 1 7 0c0 4 1.5 4 1.5 4H3s1.5 0 1.5-4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M6.5 13h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg><span>알림 미리보기</span></button>
      </section>

      <section className="shortcut-settings" aria-label="단축키 설정">
        <div className="shortcut-label"><label className="field-label" htmlFor="shortcut-input">숨기기 · 다시 표시</label>{shortcutSaved && <span className="saved-indicator" role="status">저장됨</span>}</div>
        <input id="shortcut-input" className={`shortcut-input ${capturingShortcut ? 'capturing' : ''}`} aria-label="숨기기 단축키 변경" aria-describedby="shortcut-hint" type="text" readOnly value={capturingShortcut ? '새 조합 키를 눌러 주세요' : displayShortcut(state.shortcut)} onFocus={() => { setCapturingShortcut(true); setShortcutSaved(false); }} onBlur={() => setCapturingShortcut(false)} onKeyDown={captureShortcut} aria-busy={savingShortcut} data-testid="shortcut-input" />
        <p id="shortcut-hint" className="field-hint">입력칸을 선택한 뒤 원하는 조합 키를 눌러 주세요.</p>
        {!state.shortcutRegistered && !error && <p className="inline-error" role="alert">단축키를 등록하지 못했어요. 다른 조합으로 바꿔 주세요.</p>}
        {error && <p className="inline-error" role="alert" data-testid="panel-error">{error}</p>}
      </section>
      </div>
      <div role="tabpanel" id="memos-tabpanel" aria-labelledby="memos-tab" hidden={tab !== 'memos'}>
        <MemoPanel memos={state.memos} memoError={state.memoError} reminderError={state.reminderError} companion={companion} />
      </div>
      <div role="tabpanel" id="chat-tabpanel" aria-labelledby="chat-tab" hidden={tab !== 'chat'}>
        <ChatPanel chat={state.chat} companion={companion} active={tab === 'chat'} />
      </div>
    </div>
    <footer className="panel-footer">
      <button type="button" className="hide-button" data-testid="hide-companion" onClick={() => companion.toggleVisibility()}><svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 8s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4Z" stroke="currentColor" strokeWidth="1.2" /><path d="m3 13 10-10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>잠시 숨기기</button>
      <button type="button" className="quit-button" data-testid="quit-app" onClick={() => companion.quit()}>앱 종료</button>
    </footer>
  </main>;
}

function App() {
  const { state, error } = useCompanionState();
  if (error) return isWidget ? null : <main className="connection-message" role="alert">{error}</main>;
  if (!state) return isWidget ? null : <main className="connection-message" role="status">작은 동료를 불러오고 있어요…</main>;
  return isWidget ? <Widget state={state} /> : <Panel state={state} companion={api} />;
}

createRoot(document.getElementById('root')!).render(<App />);
