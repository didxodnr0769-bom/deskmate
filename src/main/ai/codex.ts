import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConnection, ChatMessage } from '../../shared/chat';
import { MAX_CHAT_ANSWER_LENGTH, MAX_CHAT_QUESTION_LENGTH } from '../../shared/chat';
import { APP_COMMAND_INSTRUCTIONS, CHAT_INSTRUCTIONS, buildChatPrompt } from './prompt';
import { AgentError, type AgentProvider } from './provider';
import { discoverCodex, type CodexExecutable } from './discovery';
import { runProcess, type ProcessRunner, type ProcessResult } from './process';

const MIN_CODEX_VERSION = [0, 154, 0];
const REQUIRED_EXEC_FLAGS = ['--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', '--config', '--disable'];
// The conversation adapter exposes no local, browser, connector, image, or delegated tools.
const DISABLED_FEATURES = [
  'shell_tool', 'unified_exec', 'plugins', 'hooks', 'apps', 'memories',
  'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'computer_use', 'image_generation', 'view_image',
  'code_mode_host', 'skill_search', 'sleep_tool', 'in_app_browser',
  'workspace_dependencies', 'chronicle', 'remote_plugin', 'tool_suggest',
];

interface CodexProviderOptions {
  runner?: ProcessRunner;
  discover?: () => Promise<CodexExecutable>;
  checkTimeoutMs?: number;
  askTimeoutMs?: number;
}
function failure(): AgentError {
  return new AgentError('failed', 'Codex 응답을 처리하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.');
}
function isAuthText(text: string): boolean {
  return /not logged in|not authenticated|unauthorized|authentication (?:required|failed)|invalid api key|refresh token|token (?:has )?expired|401\b/i.test(text);
}
function authenticationError(): AgentError {
  return new AgentError('unauthenticated', '터미널에서 codex login을 실행한 뒤 연결을 다시 확인해 주세요.');
}
function eventError(record: Record<string, unknown>): AgentError {
  return isAuthText(JSON.stringify(record.error ?? record.message ?? '')) ? authenticationError() : failure();
}
function checkVersion(text: string): boolean {
  const version = /\bcodex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)\b/.exec(text);
  if (!version) return false;
  const values = version.slice(1).map(Number);
  for (let i = 0; i < MIN_CODEX_VERSION.length; i++) {
    if (values[i] !== MIN_CODEX_VERSION[i]) return values[i] > MIN_CODEX_VERSION[i];
  }
  return true;
}
export function parseCodexAnswer(result: ProcessResult): string {
  if (result.exitCode !== 0 && isAuthText(result.stderr)) throw authenticationError();
  const messages: string[] = [];
  let completed = false;
  try {
    for (const line of result.stdout.split(/\r?\n/).filter((value) => value.trim())) {
      const event: unknown = JSON.parse(line);
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw failure();
      const record = event as Record<string, unknown>;
      if (record.type === 'error' || record.type === 'turn.failed') throw eventError(record);
      if (record.type === 'turn.completed') completed = true;
      if (record.type === 'item.completed' && record.item && typeof record.item === 'object') {
        const item = record.item as Record<string, unknown>;
        if (item.type === 'agent_message') {
          if (typeof item.text !== 'string') throw failure();
          messages.push(item.text);
        }
      }
    }
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw failure();
  }
  const answer = messages.join('\n\n').trim();
  if (result.exitCode !== 0 || !completed || !answer || answer.length > MAX_CHAT_ANSWER_LENGTH) throw failure();
  return answer;
}

export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly label = 'Codex CLI';
  private readonly runner: ProcessRunner;
  private readonly discover: () => Promise<CodexExecutable>;
  private readonly checkTimeoutMs: number;
  private readonly askTimeoutMs: number;

  constructor(options: CodexProviderOptions = {}) {
    this.runner = options.runner ?? runProcess;
    this.discover = options.discover ?? (() => discoverCodex());
    this.checkTimeoutMs = options.checkTimeoutMs ?? 5000;
    this.askTimeoutMs = options.askTimeoutMs ?? 120000;
  }
  private async withDirectory<T>(run: (cwd: string) => Promise<T>): Promise<T> {
    const cwd = await mkdtemp(join(tmpdir(), 'deskmate-chat-'));
    try { return await run(cwd); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  }
  private async verify(executable: CodexExecutable, cwd: string, signal: AbortSignal): Promise<void> {
    const base = { executable: executable.path, env: executable.env, cwd, signal, timeoutMs: this.checkTimeoutMs, maxOutputBytes: 128 * 1024 };
    const version = await this.runner({ ...base, args: ['--version'] });
    if (version.exitCode !== 0 || !checkVersion(version.stdout)) {
      throw new AgentError('failed', 'Codex CLI 0.154.0 이상으로 업데이트한 뒤 연결을 다시 확인해 주세요.');
    }
    const help = await this.runner({ ...base, args: ['exec', '--help'] });
    if (help.exitCode !== 0 || REQUIRED_EXEC_FLAGS.some((flag) => !help.stdout.includes(flag))) {
      throw new AgentError('failed', '이 Codex CLI는 안전한 대화 실행 옵션을 지원하지 않습니다. 최신 버전으로 업데이트해 주세요.');
    }
    const auth = await this.runner({ ...base, args: ['login', 'status'] });
    if (auth.exitCode !== 0 || isAuthText(auth.stdout + '\n' + auth.stderr)) {
      throw new AgentError('unauthenticated', '터미널에서 codex login을 실행한 뒤 연결을 다시 확인해 주세요.');
    }
  }
  async checkConnection(signal: AbortSignal): Promise<AgentConnection> {
    try {
      if (signal.aborted) throw new AgentError('cancelled', '요청을 취소했습니다.');
      const executable = await this.discover();
      await this.withDirectory((cwd) => this.verify(executable, cwd, signal));
      return { status: 'ready', message: 'Codex CLI에 연결되었습니다.' };
    } catch (error) {
      if (error instanceof AgentError) {
        if (error.code === 'cancelled') throw error;
        if (error.code === 'not-installed' || error.code === 'unauthenticated') return { status: error.code, message: error.message };
        return { status: 'error', message: error.message };
      }
      return { status: 'error', message: 'Codex CLI 연결을 확인하지 못했습니다. 다시 시도해 주세요.' };
    }
  }
  async ask({ question, history = [], appCommands = false, signal }: { question: string; history?: readonly ChatMessage[]; appCommands?: boolean; signal: AbortSignal }): Promise<string> {
    if (signal.aborted) throw new AgentError('cancelled', '요청을 취소했습니다.');
    if (!question.trim() || question.length > MAX_CHAT_QUESTION_LENGTH) throw new AgentError('failed', '질문은 1자 이상 4,000자 이하로 입력해 주세요.');
    const input = buildChatPrompt(question, history, { appCommands });
    const instructions = appCommands ? APP_COMMAND_INSTRUCTIONS : CHAT_INSTRUCTIONS;
    const executable = await this.discover();
    return this.withDirectory(async (cwd) => {
      await this.verify(executable, cwd, signal);
      const instructionsPath = join(cwd, 'conversation-instructions.md');
      await writeFile(instructionsPath, instructions, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const args = [
        '-a', 'never', 'exec', '--json', '--ephemeral', '--ignore-user-config',
        '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never',
        '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
        '-c', 'features.skip_host_skill_discovery=true',
        '-c', 'skills.include_instructions=false', '-c', 'skills.bundled.enabled=false',
        '-c', 'history.persistence="none"',
        '-c', 'model_instructions_file=' + JSON.stringify(instructionsPath),
        '-c', 'developer_instructions=' + JSON.stringify(instructions),
        ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]), '-',
      ];
      const result = await this.runner({
        executable: executable.path, env: executable.env, args, cwd, signal,
        timeoutMs: this.askTimeoutMs, maxOutputBytes: 1024 * 1024, input,
      });
      return parseCodexAnswer(result);
    });
  }
}
