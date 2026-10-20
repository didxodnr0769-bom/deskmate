import { spawn } from 'node:child_process';
import { AgentError } from './provider';

export interface ProcessRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  input?: string;
  maxOutputBytes?: number;
}
export interface ProcessResult { stdout: string; stderr: string; exitCode: number | null }
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

// No command shell, raw output logging, or persistent output files are used here.
export const runProcess: ProcessRunner = (request) => new Promise((resolve, reject) => {
  if (request.signal.aborted) {
    reject(new AgentError('cancelled', '요청을 취소했습니다.'));
    return;
  }
  const child = spawn(request.executable, request.args, {
    cwd: request.cwd, env: request.env, shell: false,
    detached: process.platform !== 'win32', windowsHide: true, stdio: 'pipe',
  });
  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let stopping: AgentError | null = null;
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* It may already have exited. */ }
  };
  const stop = (reason: AgentError) => {
    if (settled || stopping) return;
    stopping = reason;
    kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 250);
    killTimer.unref();
  };
  const abort = () => stop(new AgentError('cancelled', '요청을 취소했습니다.'));
  const timeout = setTimeout(() => stop(new AgentError('timeout', '응답 시간이 초과되었습니다. 다시 시도해 주세요.')), request.timeoutMs);
  const cleanup = () => {
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    request.signal.removeEventListener('abort', abort);
  };
  const receive = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
    if (stopping) return;
    outputBytes += chunk.length;
    if (outputBytes > (request.maxOutputBytes ?? 1024 * 1024)) {
      stop(new AgentError('failed', '응답 크기가 제한을 초과했습니다. 질문을 짧게 나누어 주세요.'));
      return;
    }
    // StringDecoder behavior is provided by setEncoding, preserving split UTF-8.
    if (kind === 'stdout') stdout += chunk.toString();
    else stderr += chunk.toString();
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => receive('stdout', Buffer.from(chunk)));
  child.stderr.on('data', (chunk: string) => receive('stderr', Buffer.from(chunk)));
  child.stdin.on('error', () => { /* EPIPE is handled through process completion. */ });
  child.once('error', (error: NodeJS.ErrnoException) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(stopping ?? new AgentError(error.code === 'ENOENT' ? 'not-installed' : 'failed',
      error.code === 'ENOENT' ? 'Codex CLI를 찾을 수 없습니다.' : 'Codex CLI를 실행할 수 없습니다.'));
  });
  child.once('close', (exitCode) => {
    if (settled) return;
    settled = true;
    // The CLI can exit before its descendants. Finish cancellation for the whole group.
    if (stopping) kill('SIGKILL');
    cleanup();
    if (stopping) reject(stopping);
    else resolve({ stdout, stderr, exitCode });
  });
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  child.stdin.end(request.input ?? '');
});
