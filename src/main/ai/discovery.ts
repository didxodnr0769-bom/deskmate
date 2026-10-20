import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { AgentError } from './provider';

export interface CodexExecutable { path: string; env: NodeJS.ProcessEnv }
export async function discoverCodex(
  env: NodeJS.ProcessEnv = process.env, home = homedir(),
): Promise<CodexExecutable> {
  const nvmRoot = join(home, '.nvm', 'versions', 'node');
  let versions: string[] = [];
  try { versions = (await readdir(nvmRoot)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); }
  catch { /* nvm is optional. */ }
  const directories = [...new Set([
    ...(env.PATH ?? '').split(delimiter).filter((entry) => isAbsolute(entry)),
    '/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'),
    ...versions.map((version) => join(nvmRoot, version, 'bin')),
    '/usr/bin', '/bin',
  ])];
  const override = env.DESKMATE_CODEX_PATH?.trim();
  const candidates = override ? (isAbsolute(override) ? [override] : []) : directories.map((directory) => join(directory, 'codex'));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      return { path: candidate, env: { ...env, PATH: [...new Set([dirname(candidate), ...directories])].join(delimiter) } };
    } catch { /* Continue through known executable directories. */ }
  }
  throw new AgentError('not-installed', 'Codex CLI를 설치한 뒤 연결을 다시 확인해 주세요.');
}
