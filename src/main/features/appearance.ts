import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { DEFAULT_APPEARANCE, validAppearanceSettings, type AppearanceSettings } from '../../shared/appearance';

/** User appearance preferences are local data, independent of memos and work schedules. */
export class AppearanceService {
  private value: AppearanceSettings = { ...DEFAULT_APPEARANCE };
  constructor(private readonly filename: string) {
    let data: { version?: unknown; settings?: unknown } | null;
    try {
      if (statSync(filename).size > 4096) throw new Error();
      data = JSON.parse(readFileSync(filename, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('캐릭터 설정을 읽지 못했어요. 원본 파일은 유지합니다.');
    }
    if (!data || data.version !== 1 || !validAppearanceSettings(data.settings)) throw new Error('캐릭터 설정이 올바르지 않아요. 원본 파일은 유지합니다.');
    this.value = { scale: data.settings.scale };
  }
  get settings(): AppearanceSettings { return { ...this.value }; }
  configure(value: unknown) {
    if (!validAppearanceSettings(value)) throw new Error('캐릭터 크기를 확인해 주세요.');
    const settings = { scale: value.scale };
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, settings }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.filename);
    } catch { throw new Error('캐릭터 설정을 저장하지 못했어요. 다시 시도해 주세요.'); }
    finally { try { unlinkSync(temporary); } catch { /* Preserve the original save result. */ } }
    this.value = settings;
  }
}
