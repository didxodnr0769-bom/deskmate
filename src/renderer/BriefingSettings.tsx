import React, { useEffect, useRef, useState } from 'react';
import type { CompanionApi, CompanionState } from '../shared/contracts';

export function BriefingSettings({ settings, error, companion }: {
  settings: CompanionState['briefingSettings'];
  error: string | null;
  companion: CompanionApi;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [minutes, setMinutes] = useState(String(settings.beforeMinutes));
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);

  // Only an applied change may replace the local draft; clock updates leave it alone.
  useEffect(() => { setEnabled(settings.enabled); setMinutes(String(settings.beforeMinutes)); }, [settings.enabled, settings.beforeMinutes]);

  function edited() { setLocalError(null); setSaved(false); }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const beforeMinutes = Number(minutes);
    if (!minutes.trim() || !Number.isInteger(beforeMinutes) || beforeMinutes < 5 || beforeMinutes > 120) { setLocalError('알림 시점은 5~120분 사이의 정수로 입력해 주세요.'); return; }
    inFlight.current = true;
    setSaving(true);
    setSaved(false);
    setLocalError(null);
    try {
      const result = await companion.setBriefingSettings({ enabled, beforeMinutes });
      if (!result.ok) setLocalError(result.error || '퇴근 전 알림 설정을 저장하지 못했어요.');
      else setSaved(true);
    } catch { setLocalError('퇴근 전 알림 설정을 저장하지 못했어요. 다시 시도해 주세요.'); }
    finally { inFlight.current = false; setSaving(false); }
  }

  return <section className="settings-card briefing-settings" aria-label="퇴근 전 할 일 알림" data-testid="briefing-settings">
    <form noValidate onSubmit={save} aria-busy={saving}>
      <div className="setting-row"><label id="briefing-toggle-label" className="setting-title">퇴근 전 할 일 알림</label><button type="button" role="switch" className={`toggle ${enabled ? 'on' : ''}`} aria-checked={enabled} aria-labelledby="briefing-toggle-label" disabled={saving} data-testid="briefing-enabled" onClick={() => { setEnabled(value => !value); edited(); }}><span /></button></div>
      <p className="briefing-hint">설정한 퇴근시간 전에 남은 할 일을 한 번 알려드려요.</p>
      <div className="briefing-time-row"><label className="field-label" htmlFor="briefing-minutes">퇴근</label><input id="briefing-minutes" type="number" inputMode="numeric" min="5" max="120" step="1" value={minutes} disabled={saving} data-testid="briefing-minutes" aria-label="퇴근 몇 분 전에 알릴지" onChange={(event) => { setMinutes(event.target.value); edited(); }} /><span>분 전</span><button className="apply-button" type="submit" disabled={saving} data-testid="save-briefing-settings">{saving ? '저장 중' : '저장'}</button></div>
      <div className="briefing-presets" aria-label="알림 시점 빠른 선택">{[10, 30, 60].map(value => <button type="button" className="text-button" key={value} disabled={saving} aria-pressed={minutes === String(value)} onClick={() => { setMinutes(String(value)); edited(); }}>{value}분 전</button>)}{saved && <span className="saved-indicator" role="status">저장됨</span>}</div>
      {(localError || error) && <p className="inline-error" role="alert" data-testid="briefing-error">{localError || error}</p>}
    </form>
  </section>;
}
