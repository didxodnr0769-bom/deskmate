import React, { useState } from 'react';
import type { CompanionApi, CompanionState } from '../shared/contracts';
import { displayShortcut, shortcutFromEvent } from './shortcut';

export function SettingsPanel({ state, companion }: { state: CompanionState; companion: CompanionApi }) {
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [savingShortcut, setSavingShortcut] = useState(false);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [shortcutSaved, setShortcutSaved] = useState(false);
  const error = shortcutError || state.error;
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

  return <section className="settings-card app-settings" aria-label="앱 설정" data-testid="app-settings">
    <h2 className="setting-title">캐릭터 동작</h2>
    <div className="setting-row"><label id="walking-label" className="setting-title">자유롭게 이동</label><button type="button" role="switch" aria-checked={state.walking} aria-labelledby="walking-label" className={`toggle ${state.walking ? 'on' : ''}`} data-testid="walking-toggle" onClick={() => companion.setWalking(!state.walking)}><span /></button></div>
    <p className="field-hint">이동을 꺼도 제자리에서 쉬는 동작은 이어져요.</p>
    <div className="setting-divider" />
    <h2 className="setting-title">표시 및 단축키</h2>
    <p className="field-hint">캐릭터를 숨기거나 단축키로 다시 표시할 수 있어요.</p>
      <button type="button" className="hide-button" data-testid="hide-companion" onClick={() => companion.toggleVisibility()}><svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 8s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4Z" stroke="currentColor" strokeWidth="1.2" /><path d="m3 13 10-10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>잠시 숨기기</button>
    <div className="setting-divider" />
<section className="shortcut-settings" aria-label="단축키 설정">
        <div className="shortcut-label"><label className="field-label" htmlFor="shortcut-input">숨기기 · 다시 표시</label>{shortcutSaved && <span className="saved-indicator" role="status">저장됨</span>}</div>
        <input id="shortcut-input" className={`shortcut-input ${capturingShortcut ? 'capturing' : ''}`} aria-label="숨기기 단축키 변경" aria-describedby="shortcut-hint" type="text" readOnly value={capturingShortcut ? '새 조합 키를 눌러 주세요' : displayShortcut(state.shortcut)} onFocus={() => { setCapturingShortcut(true); setShortcutSaved(false); }} onBlur={() => setCapturingShortcut(false)} onKeyDown={captureShortcut} aria-busy={savingShortcut} data-testid="shortcut-input" />
        <p id="shortcut-hint" className="field-hint">입력칸을 선택한 뒤 원하는 조합 키를 눌러 주세요.</p>
        {!state.shortcutRegistered && !error && <p className="inline-error" role="alert">단축키를 등록하지 못했어요. 다른 조합으로 바꿔 주세요.</p>}
        {error && <p className="inline-error" role="alert" data-testid="panel-error">{error}</p>}

      </section>
  </section>;
}
