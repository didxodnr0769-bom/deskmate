import React, { useRef, useState } from 'react';
import { CHARACTER_SCALES, type AppearanceSettings } from '../shared/appearance';
import type { CompanionApi } from '../shared/contracts';

export function CharacterSettings({ settings, error, companion }: {
  settings: AppearanceSettings; error: string | null; companion: CompanionApi;
}) {
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);

  async function apply(next: AppearanceSettings) {
    if (inFlight.current) return;
    inFlight.current = true; setSaving(true); setLocalError(null); setSaved(false);
    try {
      const result = await companion.setAppearance(next);
      if (!result.ok) setLocalError(result.error || '캐릭터 설정을 저장하지 못했어요.');
      else setSaved(true);
    } catch { setLocalError('캐릭터 설정을 저장하지 못했어요. 다시 시도해 주세요.'); }
    finally { inFlight.current = false; setSaving(false); }
  }

  return <section className="settings-card character-settings" aria-label="캐릭터 설정" data-testid="character-settings" aria-busy={saving}>
    <div className="setting-row"><h2 className="setting-title">캐릭터 크기</h2><output className="character-size-value" data-testid="character-size-value">{Math.round(settings.scale * 100)}%</output></div>
    <div className="character-size-options" role="group" aria-label="캐릭터 크기 선택">{CHARACTER_SCALES.map(scale => <button type="button" key={scale} aria-pressed={settings.scale === scale} disabled={saving || !!error} data-testid={`character-size-${scale * 100}`} onClick={() => void apply({ ...settings, scale })}>{scale * 100}%</button>)}</div>
    <p className="field-hint">캐릭터와 HP 크기가 함께 바뀝니다.<br />선택하면 바로 적용되며 다음 실행에도 유지돼요.</p>
    {saved && <p className="saved-indicator" role="status" data-testid="appearance-saved">저장됨</p>}
    {(localError || error) && <p className="inline-error" role="alert" data-testid="appearance-error">{localError || error}</p>}
  </section>;
}
