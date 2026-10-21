import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CompanionApi, CompanionState, HitRegion, Point, PanelTab } from '../shared/contracts';
import { renderCharacterScene, SCENE_SIZE } from './character-runtime';
import { bubbleLayout, sceneLayout } from '../shared/appearance';
import { CharacterSettings } from './CharacterSettings';
import { getCharacterDefinition } from './characters';
import { getHpAppearance } from './hp-colors';
import { MemoPanel } from './MemoPanel';
import { BriefingSettings } from './BriefingSettings';
import { ChatPanel } from './ChatPanel';
import { displayShortcut, shortcutFromEvent } from './shortcut';
import { insideCharacter } from './widget-interaction';
import './styles.css';

const api = window.companion;
const isWidget = window.location.hash === '#widget';
const isChat = window.location.hash === '#chat';
document.documentElement.dataset.surface = isWidget ? 'widget' : isChat ? 'chat' : 'panel';

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
  const [cancelling, setCancelling] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const dragging = useRef<number | null>(null);
  const captureTarget = useRef<HTMLElement | null>(null);
  const characterPolygons = useRef<Point[][]>([]);
  const overCharacter = (point: Point) => characterPolygons.current.some(polygon => insideCharacter(point, polygon));
  const contextMenuShown = useRef(false);
  const bubbleActivationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bubbleGesture = useRef<{ id: string; pointerId: number; x: number; y: number; moved: boolean; hadSelection: boolean } | null>(null);
  stateRef.current = state;

  function cancelBubbleActivation() {
    if (bubbleActivationTimer.current !== null) clearTimeout(bubbleActivationTimer.current);
    bubbleActivationTimer.current = null;
  }

  useEffect(() => {
    setDismissError(null);
    bubbleGesture.current = null;
    cancelBubbleActivation();
    return cancelBubbleActivation;
  }, [state.bubble?.id]);
  useEffect(() => {
    const selectionChanged = () => { if (window.getSelection()?.toString()) cancelBubbleActivation(); };
    document.addEventListener('selectionchange', selectionChanged);
    return () => { document.removeEventListener('selectionchange', selectionChanged); cancelBubbleActivation(); };
  }, []);

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

  async function cancelChat() {
    const bubble = state.bubble;
    if (bubble?.kind !== 'chat-loading' || cancelling) return;
    setCancelling(true);
    setDismissError(null);
    try {
      const result = await api.cancelQuestion(bubble.requestId);
      if (!result.ok) setDismissError(result.error || '답변 요청을 취소하지 못했어요. 다시 시도해 주세요.');
    } catch { setDismissError('답변 요청을 취소하지 못했어요. 다시 시도해 주세요.'); }
    finally { setCancelling(false); }
  }

  function validBubbleClick(event: React.MouseEvent, ignoreSelection = false) {
    const gesture = bubbleGesture.current;
    bubbleGesture.current = null;
    return !!gesture && gesture.id === state.bubble?.id && !gesture.moved
      && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5
      && (ignoreSelection || (!gesture.hadSelection && !window.getSelection()?.toString()));
  }

  function activateBubble(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    cancelBubbleActivation();
    if (state.bubble?.kind === 'preview' || !state.bubble) return;
    if (event.detail === 0 || validBubbleClick(event, true)) api.activateBubble(state.bubble.id);
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
      characterPolygons.current = [];
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
      const layout = sceneLayout(current.appearance.scale, window.innerWidth, window.innerHeight);
      canvas.style.width = `${layout.width}px`;
      canvas.style.height = `${layout.height}px`;
      canvas.style.left = `${layout.left}px`;
      canvas.style.top = `${layout.top}px`;
      const ratio = (window.devicePixelRatio || 1) * layout.scale;
      if (ratio !== lastRatio) {
        canvas.width = Math.round(SCENE_SIZE.width * ratio);
        canvas.height = Math.round(SCENE_SIZE.height * ratio);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        lastRatio = ratio;
        dirty = true;
      }
      const frame = renderCharacterScene(context, getCharacterDefinition(current.appearance.characterId), current, Date.now());
      // Keep the bubble just above the HP label, including while the character jumps.
      const bubble = bubbleLayout(frame.hp.y, layout, window.innerHeight);
      bubbleRef.current?.style.setProperty('--bubble-bottom', `${bubble.bottom}px`);
      bubbleRef.current?.style.setProperty('--bubble-max-height', `${bubble.maxHeight}px`);
      if (dirty || now - lastHitUpdate >= 50) {
        const bounds = canvas.getBoundingClientRect();
        const scaleX = bounds.width / SCENE_SIZE.width;
        const scaleY = bounds.height / SCENE_SIZE.height;
        const round = (value: number) => Math.round(value * 2) / 2;
        characterPolygons.current = frame.polygons.map(polygon => polygon.map((p) => ({ x: round(bounds.left + p.x * scaleX), y: round(bounds.top + p.y * scaleY) })));
        const regions: HitRegion[] = [
          ...characterPolygons.current.map(points => ({ type: 'polygon' as const, points })),
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
      characterPolygons.current = [];
      api.setHitRegions([]);
    };
  }, [state.visible, state.appearance.scale, state.appearance.characterId]);

  return <main
    className="widget"
    data-testid="companion-widget"
    aria-label={`${getCharacterDefinition(state.appearance.characterId).label} 데스크톱 동료`}
    tabIndex={0}
    onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); api.openChat(); }
      else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); api.showContextMenu(); }
    }}
    onContextMenu={(event) => {
      event.preventDefault();
      if (contextMenuShown.current) { contextMenuShown.current = false; return; }
      if (!overCharacter({ x: event.clientX, y: event.clientY })) return;
      finishGesture(null);
      api.showContextMenu();
    }}
    onPointerDown={(event) => {
      contextMenuShown.current = false;
      if (event.button !== 0) return;
      if (event.ctrlKey) {
        event.preventDefault();
        if (overCharacter({ x: event.clientX, y: event.clientY })) {
          finishGesture(null);
          contextMenuShown.current = true;
          api.showContextMenu();
        }
        return;
      }
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
    {state.bubble && <div className={`notification-bubble${state.bubble.kind === 'chat' ? ' chat-answer-bubble' : state.bubble.kind === 'chat-loading' ? ' chat-loading-bubble' : state.bubble.kind === 'briefing' ? ' briefing-bubble' : ''}${state.bubble.kind !== 'preview' ? ' actionable-bubble' : ''}`} ref={bubbleRef} role="status" data-testid="notification-bubble"
      onContextMenu={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        event.stopPropagation();
        cancelBubbleActivation();
        bubbleGesture.current = event.button === 0 && !event.ctrlKey ? { id: state.bubble!.id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, hadSelection: !!window.getSelection()?.toString() } : null;
      }}
      onPointerMove={(event) => {
        const gesture = bubbleGesture.current;
        if (gesture?.pointerId === event.pointerId && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 5) gesture.moved = true;
      }}
      onPointerLeave={() => { if (bubbleGesture.current) bubbleGesture.current.moved = true; }}
      onPointerCancel={() => { bubbleGesture.current = null; }}
      onPointerUp={(event) => event.stopPropagation()}
      onWheel={() => { cancelBubbleActivation(); if (bubbleGesture.current) bubbleGesture.current.moved = true; }}
      onScrollCapture={() => { cancelBubbleActivation(); if (bubbleGesture.current) bubbleGesture.current.moved = true; }}
      onDoubleClick={() => { cancelBubbleActivation(); bubbleGesture.current = null; }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        if (state.bubble?.kind === 'preview' || !state.bubble || event.detail !== 1 || !validBubbleClick(event)) return;
        const bubbleId = state.bubble.id;
        // Let a second click, text selection or scrolling win over opening a window.
        bubbleActivationTimer.current = setTimeout(() => {
          bubbleActivationTimer.current = null;
          if (stateRef.current.bubble?.id === bubbleId && !window.getSelection()?.toString()) api.activateBubble(bubbleId);
        }, 300);
      }}
      onKeyDown={(event) => event.stopPropagation()}>
      <div className="bubble-heading"><span className="bubble-dot" />{state.bubble.kind === 'preview' ? <span>알림 미리보기</span> : <button type="button" className="bubble-open" aria-label={state.bubble.kind === 'reminder' || state.bubble.kind === 'briefing' ? '메모 목록 열기' : '대화 창 열기'} title={state.bubble.kind === 'reminder' || state.bubble.kind === 'briefing' ? '메모 목록 열기' : '대화 창 열기'} data-testid="activate-notification" onClick={activateBubble}>{state.bubble.kind === 'briefing' ? '퇴근 전 할 일' : state.bubble.kind === 'reminder' ? '메모 알림' : `${getCharacterDefinition(state.appearance.characterId).label}와 대화`}</button>}<button type="button" className="bubble-close" aria-label={state.bubble.kind === 'chat' ? 'AI 답변 닫기' : state.bubble.kind === 'chat-loading' ? '생성 상태 접기' : '알림 닫기'} title={state.bubble.kind === 'chat-loading' ? '표시만 접고 답변은 계속 기다려요' : undefined} data-testid="dismiss-notification" disabled={dismissing} onClick={(event) => { event.stopPropagation(); void dismiss(); }}><CloseIcon /></button></div>
      {(dismissError || (state.bubble.kind === 'reminder' && state.reminderError)) && <p className="inline-error" role="alert" data-testid={state.bubble.kind === 'reminder' ? 'reminder-error' : 'bubble-error'}>{dismissError || state.reminderError}</p>}
      {state.bubble.kind === 'chat-loading' ? <div className="bubble-thinking"><span className="thinking-dots" aria-hidden="true"><span /><span /><span /></span><span data-testid="chat-loading-status">응답 생성 중…</span><button type="button" className="text-button" data-testid="cancel-bubble-question" disabled={cancelling} onClick={(event) => { event.stopPropagation(); void cancelChat(); }}>{cancelling ? '취소 중' : '취소'}</button></div> : <p tabIndex={state.bubble.kind === 'chat' ? 0 : undefined}>{state.bubble.text}</p>}
    </div>}
  </main>;
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
  const [tab, setTab] = useState<PanelTab>(() => state.panelNavigation?.tab || 'work');
  useEffect(() => { if (state.panelNavigation) setTab(state.panelNavigation.tab); }, [state.panelNavigation?.sequence]);
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
  const hpAppearance = getHpAppearance(state.hp);
  const hp = hpAppearance.percent;
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
      const tabs = ['work', 'memos', 'appearance'] as const;
      const index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      setTab(next);
      document.getElementById(`${next}-tab`)?.focus();
    }}>
      <button type="button" role="tab" id="work-tab" aria-controls="work-tabpanel" aria-selected={tab === 'work'} tabIndex={tab === 'work' ? 0 : -1} data-testid="work-tab" onClick={() => setTab('work')}>근무</button>
      <button type="button" role="tab" id="memos-tab" aria-controls="memos-tabpanel" aria-selected={tab === 'memos'} tabIndex={tab === 'memos' ? 0 : -1} data-testid="memos-tab" onClick={() => setTab('memos')}>메모</button>
      <button type="button" role="tab" id="appearance-tab" aria-controls="appearance-tabpanel" aria-selected={tab === 'appearance'} tabIndex={tab === 'appearance' ? 0 : -1} data-testid="appearance-tab" onClick={() => setTab('appearance')}>캐릭터</button>
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
        <div className="hp-label-row"><span className="setting-title">퇴근 HP</span>{scheduleSaved && <span className="saved-indicator" role="status">적용됨</span>}<output style={{ color: hpAppearance.textColor }} data-testid="hp-value">{hp}<small>%</small></output></div>
        <progress className="work-progress" style={{ '--hp-color': hpAppearance.color } as React.CSSProperties} max="100" value={hp} aria-label="퇴근 HP" data-testid="work-progress-bar">{hp}%</progress>
        <p className="work-status" data-testid="work-status">{progressText}</p>
        {savedDate && (savedDate !== localDate() || isOvernight) && <p className="schedule-anchor" data-testid="schedule-anchor">{savedDate !== localDate() ? `${savedDate.replaceAll('-', '.')} 기준` : ''}{isOvernight ? `${savedDate !== localDate() ? ' · ' : ''}다음날 퇴근` : ''}</p>}
      </section>

      <section className="utility-settings" aria-label="캐릭터 동작">
        <div className="setting-row"><label id="walking-label" className="setting-title">자유롭게 이동</label><button type="button" role="switch" aria-checked={state.walking} aria-labelledby="walking-label" className={`toggle ${state.walking ? 'on' : ''}`} data-testid="walking-toggle" onClick={() => companion.setWalking(!state.walking)}><span /></button></div>
        <button type="button" className="preview-button" data-testid="preview-notification" onClick={() => companion.previewNotification()}><svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.5 6.5a3.5 3.5 0 0 1 7 0c0 4 1.5 4 1.5 4H3s1.5 0 1.5-4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M6.5 13h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg><span>알림 미리보기</span></button>
      </section>

      <BriefingSettings settings={state.briefingSettings} error={state.briefingError} companion={companion} />

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
      <div role="tabpanel" id="appearance-tabpanel" aria-labelledby="appearance-tab" hidden={tab !== 'appearance'}>
        <CharacterSettings settings={state.appearance} error={state.appearanceError} companion={companion} />
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
  return isWidget ? <Widget state={state} /> : isChat ? <main className="chat-window" data-testid="companion-chat"><ChatPanel characterName={getCharacterDefinition(state.appearance.characterId).label} chat={state.chat} companion={api} active={state.chatOpen} shortcut={state.chatShortcut} shortcutRegistered={state.chatShortcutRegistered} shortcutError={state.chatShortcutError} /></main> : <Panel state={state} companion={api} />;
}

createRoot(document.getElementById('root')!).render(<App />);
