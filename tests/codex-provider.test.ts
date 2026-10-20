import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { CodexProvider, parseCodexAnswer } from '../src/main/ai/codex';
import { discoverCodex } from '../src/main/ai/discovery';
import { AgentError } from '../src/main/ai/provider';
import type { ProcessRequest, ProcessResult, ProcessRunner } from '../src/main/ai/process';

const signal = () => new AbortController().signal;
const result = (stdout: string, exitCode = 0, stderr = ''): ProcessResult => ({ stdout, stderr, exitCode });
const events = (...values: object[]) => values.map((value) => JSON.stringify(value)).join('\n');
const success = (answer = '안녕하세요') => result(events(
  { type: 'thread.started', thread_id: 'test' },
  { type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } },
  { type: 'item.completed', item: { type: 'agent_message', text: answer } },
  { type: 'turn.completed', usage: {} },
));
const help = '--json --ephemeral --ignore-user-config --skip-git-repo-check --sandbox --config --disable';
function fixture(outputs: ProcessResult[], inspect?: (request: ProcessRequest) => void | Promise<void>) {
  const requests: ProcessRequest[] = [];
  const runner: ProcessRunner = async (request) => {
    requests.push(request);
    await inspect?.(request);
    const output = outputs.shift();
    assert.ok(output, 'unexpected process');
    return output;
  };
  return { provider: new CodexProvider({ runner, discover: async () => ({ path: '/fixture/codex', env: { PATH: '/fixture' } }) }), requests };
}
const verified = () => [result('codex-cli 0.154.0'), result(help), result('', 0, 'Logged in using ChatGPT')];

test('checks supported CLI version, execution options, and login without exposing authentication output', async () => {
  const { provider, requests } = fixture(verified());
  assert.deepEqual(await provider.checkConnection(signal()), { status: 'ready', message: 'Codex CLI에 연결되었습니다.' });
  assert.deepEqual(requests.map((request) => request.args), [['--version'], ['exec', '--help'], ['login', 'status']]);
  assert.equal(new Set(requests.map((request) => request.cwd)).size, 1);
  await assert.rejects(access(requests[0].cwd));
});

test('old or incompatible versions fail closed before login or sending a prompt', async () => {
  for (const version of ['codex-cli 0.153.9', 'unrecognized binary', 'codex-cli 0.1.0']) {
    const { provider, requests } = fixture([result(version)]);
    const state = await provider.checkConnection(signal());
    assert.equal(state.status, 'error');
    assert.match(state.message, /0\.154\.0/);
    assert.equal(requests.length, 1);
  }
  const missingFlag = fixture([result('codex-cli 0.154.0'), result(help.replace('--ephemeral', ''))]);
  assert.equal((await missingFlag.provider.checkConnection(signal())).status, 'error');
  assert.equal(missingFlag.requests.length, 2);
});

test('missing CLI and unauthenticated statuses return fixed actionable messages', async () => {
  const missing = new CodexProvider({ discover: async () => { throw new AgentError('not-installed', 'Codex CLI를 설치해 주세요.'); } });
  assert.equal((await missing.checkConnection(signal())).status, 'not-installed');
  const { provider } = fixture([result('codex-cli 0.154.0'), result(help), result('PRIVATE ACCOUNT FIXTURE', 1, 'Not logged in')]);
  const state = await provider.checkConnection(signal());
  assert.equal(state.status, 'unauthenticated');
  assert.match(state.message, /codex login/);
  assert.doesNotMatch(state.message, /PRIVATE ACCOUNT/);
});

test('ask sends prompt only through stdin in an empty temporary directory with restricted options', async () => {
  const question = '사용자 질문; $(echo test) --output /tmp/fixture';
  const { provider, requests } = fixture([...verified(), success()], async (request) => {
    assert.deepEqual(await readdir(request.cwd), []);
  });
  assert.equal(await provider.ask({ question, signal: signal() }), '안녕하세요');
  const request = requests[3];
  assert.equal(request.input, question);
  assert.ok(request.args.includes('--ephemeral'));
  assert.ok(request.args.includes('--ignore-user-config'));
  assert.equal(request.args[request.args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(request.args[request.args.indexOf('-a') + 1], 'never');
  assert.ok(request.args.includes('web_search="disabled"'));
  assert.ok(request.args.includes('project_doc_max_bytes=0'));
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'hooks', 'memories', 'computer_use', 'multi_agent']) {
    const at = request.args.indexOf(feature);
    assert.equal(request.args[at - 1], '--disable');
  }
  assert.equal(request.args.at(-1), '-');
  assert.ok(request.args.every((value) => !value.includes(question)));
  assert.equal(request.timeoutMs, 120000);
  await assert.rejects(access(request.cwd));
});

test('empty/oversized questions and pre-aborted requests never discover or start CLI', async () => {
  let discoveries = 0;
  const provider = new CodexProvider({ discover: async () => { discoveries++; throw new Error('must not discover'); } });
  for (const question of ['', '   ', 'a'.repeat(4001)]) {
    await assert.rejects(provider.ask({ question, signal: signal() }), (error: unknown) => error instanceof AgentError && error.code === 'failed');
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.ask({ question: '질문', signal: controller.signal }), (error: unknown) => error instanceof AgentError && error.code === 'cancelled');
  assert.equal(discoveries, 0);
});

test('temporary directory is removed when an active CLI request fails or is cancelled', async () => {
  let directory = '';
  let calls = 0;
  for (const code of ['cancelled', 'timeout'] as const) {
    const provider = new CodexProvider({
      discover: async () => ({ path: '/fixture/codex', env: {} }),
      runner: async (request) => {
        directory = request.cwd;
        calls++;
        if (calls % 4 === 1) return result('codex-cli 0.154.0');
        if (calls % 4 === 2) return result(help);
        if (calls % 4 === 3) return result('Logged in');
        throw new AgentError(code, '고정 오류');
      },
    });
    await assert.rejects(provider.ask({ question: '질문', signal: signal() }), (error: unknown) => error instanceof AgentError && error.code === code);
    await assert.rejects(access(directory));
  }
});

test('JSONL parser returns only complete agent messages, including multiple text items', () => {
  assert.equal(parseCodexAnswer(success()), '안녕하세요');
  assert.equal(parseCodexAnswer(result(events(
    { type: 'item.completed', item: { type: 'agent_message', text: '첫 문장' } },
    { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'not an answer' } },
    { type: 'item.completed', item: { type: 'agent_message', text: '두 번째' } },
    { type: 'turn.completed' },
  ))), '첫 문장\n\n두 번째');
  assert.equal(parseCodexAnswer(success('HTTP 401 Unauthorized 오류는 인증 오류입니다.')), 'HTTP 401 Unauthorized 오류는 인증 오류입니다.');
});

test('JSONL parser rejects malformed, failed, incomplete, empty, oversized, or unsuccessful answers', () => {
  const invalid = [
    result('{'),
    result('null'),
    result(events({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } })),
    result(events({ type: 'turn.completed' })),
    result(events({ type: 'item.completed', item: { type: 'agent_message', text: 1 } }, { type: 'turn.completed' })),
    result(events({ type: 'error', message: 'PRIVATE ERROR FIXTURE' })),
    result(events({ type: 'turn.failed', error: { message: 'PRIVATE ERROR FIXTURE' } })),
    success('a'.repeat(16001)),
    { ...success(), exitCode: 1, stderr: 'PRIVATE ERROR FIXTURE' },
    { ...success(), exitCode: null },
  ];
  for (const value of invalid) {
    assert.throws(() => parseCodexAnswer(value), (error: unknown) => error instanceof AgentError && error.code === 'failed' && !error.message.includes('PRIVATE'));
  }
  assert.throws(() => parseCodexAnswer(result(events({ type: 'turn.failed', error: { message: '401 Unauthorized PRIVATE ERROR FIXTURE' } }))),
    (error: unknown) => error instanceof AgentError && error.code === 'unauthenticated' && !error.message.includes('PRIVATE'));
  assert.throws(() => parseCodexAnswer({ ...success('HTTP 401 Unauthorized 오류입니다.'), exitCode: 1 }),
    (error: unknown) => error instanceof AgentError && error.code === 'failed');
  assert.throws(() => parseCodexAnswer(result('', 1, '401 Unauthorized PRIVATE ERROR FIXTURE')),
    (error: unknown) => error instanceof AgentError && error.code === 'unauthenticated' && !error.message.includes('PRIVATE'));
});

test('discovery uses explicit absolute override or PATH precedence and supplies interpreter search paths', async () => {
  const home = await mkdtemp(join(tmpdir(), 'deskmate-discovery-'));
  try {
    const bin = join(home, 'custom', 'bin');
    const nvm = join(home, '.nvm', 'versions', 'node', 'v24.0.0', 'bin');
    await mkdir(bin, { recursive: true });
    await mkdir(nvm, { recursive: true });
    const executable = join(bin, 'codex');
    await writeFile(executable, '#!/usr/bin/env node\n');
    await chmod(executable, 0o755);
    const found = await discoverCodex({ PATH: bin }, home);
    assert.equal(found.path, executable);
    assert.equal(found.env.PATH?.split(delimiter)[0], bin);
    assert.ok(found.env.PATH?.split(delimiter).includes(nvm));
    const overridden = await discoverCodex({ PATH: '/fixture', DESKMATE_CODEX_PATH: executable }, home);
    assert.equal(overridden.path, executable);
    for (const path of ['relative/codex', join(home, 'missing')]) {
      await assert.rejects(discoverCodex({ DESKMATE_CODEX_PATH: path }, home),
        (error: unknown) => error instanceof AgentError && error.code === 'not-installed');
    }
    await chmod(executable, 0o644);
    await assert.rejects(discoverCodex({ DESKMATE_CODEX_PATH: executable }, home));
  } finally { await rm(home, { recursive: true, force: true }); }
});
