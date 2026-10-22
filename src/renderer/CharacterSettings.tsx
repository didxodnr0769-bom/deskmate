import React, { useEffect, useRef, useState } from 'react';
import { CHARACTER_OPTIONS, CHARACTER_SCALES, type AppearanceSettings } from '../shared/appearance';
import { getCharacterDefinition } from './characters';
import type { CharacterDefinition } from './character-runtime';
import type { CompanionState } from '../shared/contracts';
import type { CompanionApi } from '../shared/contracts';

function CharacterPreview({ character }: { character: CharacterDefinition }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    let active = true;
    const draw = () => {
      if (!active) return;
      const ratio = window.devicePixelRatio || 1;
      canvas.width = 84 * ratio; canvas.height = 60 * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, 84, 60);
      context.fillStyle = 'rgba(53,66,55,0.10)';
      context.beginPath(); context.ellipse(42, 56, 22, 2.5, 0, 0, Math.PI * 2); context.fill();
      context.translate(40, 55); context.scale(0.6, 0.6);
      character.draw(context, { motion: 'idle', direction: 1, motionStartedAt: 0 } as CompanionState, 0);
    };
    draw();
    void character.prepare?.().then(draw);
    return () => { active = false; };
  }, [character]);
  return <canvas ref={canvasRef} className="character-preview" aria-hidden="true" />;
}

export function CharacterSettings({ settings, error, walking, companion }: {
  settings: AppearanceSettings; error: string | null; walking: boolean; companion: CompanionApi;
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
    <div className="setting-row"><label id="walking-label" className="setting-title">자유롭게 이동</label><button type="button" role="switch" aria-checked={walking} aria-labelledby="walking-label" className={`toggle ${walking ? 'on' : ''}`} data-testid="walking-toggle" onClick={() => companion.setWalking(!walking)}><span /></button></div>
    <p className="field-hint">이동을 꺼도 제자리에서 쉬는 동작은 이어져요.</p>
    <div className="setting-divider" />
    <h2 className="setting-title">함께할 동료</h2>
    <div className="character-options" role="group" aria-label="기본 캐릭터 선택">{CHARACTER_OPTIONS.map(option => <button type="button" key={option.id} aria-pressed={settings.characterId === option.id} disabled={saving || !!error} data-testid={`character-${option.id}`} onClick={() => void apply({ ...settings, characterId: option.id })}><CharacterPreview character={getCharacterDefinition(option.id)} /><span>{option.label}</span></button>)}</div>
    <div className="setting-divider" />
    <div className="setting-row"><h2 className="setting-title">캐릭터 크기</h2><output className="character-size-value" data-testid="character-size-value">{Math.round(settings.scale * 100)}%</output></div>
    <div className="character-size-options" role="group" aria-label="캐릭터 크기 선택">{CHARACTER_SCALES.map(scale => <button type="button" key={scale} aria-pressed={settings.scale === scale} disabled={saving || !!error} data-testid={`character-size-${scale * 100}`} onClick={() => void apply({ ...settings, scale })}>{scale * 100}%</button>)}</div>
    <p className="field-hint">캐릭터와 HP 크기가 함께 바뀝니다.<br />선택하면 바로 적용되며 다음 실행에도 유지돼요.</p>
    {saved && <p className="saved-indicator" role="status" data-testid="appearance-saved">저장됨</p>}
    {(localError || error) && <p className="inline-error" role="alert" data-testid="appearance-error">{localError || error}</p>}
  </section>;
}
