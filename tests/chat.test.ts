import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatService } from '../src/main/features/chat';
import { AgentError, type AgentProvider } from '../src/main/ai/provider';
import { MAX_CHAT_ANSWER_LENGTH, MAX_CHAT_QUESTION_LENGTH, type AgentConnection, type ChatState } from '../src/shared/chat';

const ready: AgentConnection = { status: 'ready', message: '연결됨' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const settled = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(overrides: Partial<AgentProvider> = {}) {
  const changes: ChatState[] = [];
  const provider: AgentProvider = { id: 'fixture', label: '테스트 연결',
    checkConnection: async () => ready, ask: async () => '답변', ...overrides };
  const service = new ChatService(provider, state => changes.push(state));
  return { service, changes };
}

test('chat validates input and connection before starting one independent question', async () => {
  let calls = 0;
  const { service, changes } = fixture({ ask: async ({ question }) => { calls++; assert.equal(question, '질문'); return '  답변  '; } });
  assert.equal(service.state.connection.status, 'unchecked');
  assert.equal(changes.length, 0);
  for (const input of [null, 3, {}, '', '  ', '가'.repeat(MAX_CHAT_QUESTION_LENGTH + 1)]) assert.equal(service.ask(input).ok, false);
  assert.equal(service.ask('질문').ok, false);
  assert.equal(calls, 0);
  assert.equal((await service.checkConnection()).ok, true);
  assert.equal(service.ask('  질문  ').ok, true);
  assert.equal(service.state.status, 'thinking');
  assert.ok(service.state.requestId);
  await settled();
  assert.equal(service.state.status, 'answered');
  assert.equal(service.state.answer, '답변');
  assert.equal(calls, 1);
  assert.equal(changes.filter(s => s.status === 'answered').length, 1);
  const copy = service.state;
  copy.connection.status = 'error';
  assert.equal(service.state.connection.status, 'ready');
  service.dispose();
});

test('connection checks and questions cannot overlap or issue duplicate work', async () => {
  const check = deferred<AgentConnection>();
  const response = deferred<string>();
  const { service } = fixture({ checkConnection: () => check.promise, ask: () => response.promise });
  const pending = service.checkConnection();
  assert.equal(service.state.connection.status, 'checking');
  assert.equal((await service.checkConnection()).ok, false);
  assert.equal(service.ask('질문').ok, false);
  check.resolve(ready);
  await pending;
  assert.equal(service.ask('질문').ok, true);
  assert.equal(service.ask('중복').ok, false);
  assert.equal((await service.checkConnection()).ok, false);
  response.resolve('완료');
  await settled();
  assert.equal(service.state.question, '질문');
  service.dispose();
});

test('cancellation aborts the correct request and ignores a late answer after the following question', async () => {
  const first = deferred<string>(), second = deferred<string>();
  const signals: AbortSignal[] = [];
  const { service } = fixture({ ask: ({ signal }) => { signals.push(signal); return signals.length === 1 ? first.promise : second.promise; } });
  await service.checkConnection();
  service.ask('첫 질문');
  const oldId = service.state.requestId!;
  assert.equal(service.cancel(oldId).ok, true);
  assert.equal(signals[0].aborted, true);
  assert.equal(service.state.status, 'cancelled');
  assert.equal(service.ask('다음 질문').ok, true);
  assert.notEqual(service.state.requestId, oldId);
  assert.equal(service.cancel(oldId).ok, true);
  assert.equal(signals[1].aborted, false);
  second.resolve('다음 답변');
  await settled();
  first.resolve('늦은 이전 답변');
  await settled();
  assert.equal(service.state.status, 'answered');
  assert.equal(service.state.question, '다음 질문');
  assert.equal(service.state.answer, '다음 답변');
  service.dispose();
});

test('known auth errors update the connection and generic exceptions never disclose raw diagnostics', async () => {
  const { service } = fixture({ ask: async () => { throw new AgentError('unauthenticated', '다시 로그인해 주세요.'); } });
  await service.checkConnection();
  service.ask('질문');
  await settled();
  assert.equal(service.state.status, 'error');
  assert.equal(service.state.connection.status, 'unauthenticated');
  assert.equal(service.state.error, '다시 로그인해 주세요.');
  assert.equal(service.ask('다시').ok, false);
  service.dispose();
  const failed = fixture({ ask: async () => { throw new Error('INTERNAL_DIAGNOSTIC_MUST_STAY_PRIVATE'); } });
  await failed.service.checkConnection();
  failed.service.ask('질문');
  await settled();
  assert.equal(failed.service.state.status, 'error');
  assert.doesNotMatch(JSON.stringify(failed.service.state), /INTERNAL_DIAGNOSTIC/);
  failed.service.dispose();
});

test('missing CLI, login requirements and failed checks remain explicit and retryable', async () => {
  for (const connection of [
    { status: 'not-installed', message: '설치 필요' },
    { status: 'unauthenticated', message: '로그인 필요' },
    { status: 'error', message: '실행 불가' },
  ] as AgentConnection[]) {
    let checks = 0;
    const { service } = fixture({ checkConnection: async () => ++checks === 1 ? connection : ready });
    assert.equal((await service.checkConnection()).ok, false);
    assert.deepEqual(service.state.connection, connection);
    assert.equal(service.ask('질문').ok, false);
    assert.equal((await service.checkConnection()).ok, true);
    assert.equal(service.ask('질문').ok, true);
    await settled();
    assert.equal(service.state.status, 'answered');
    service.dispose();
  }
});

test('empty and oversized provider answers fail instead of presenting partial success', async () => {
  for (const answer of ['', '   ', 'x'.repeat(MAX_CHAT_ANSWER_LENGTH + 1)]) {
    const { service } = fixture({ ask: async () => answer });
    await service.checkConnection();
    service.ask('질문');
    await settled();
    assert.equal(service.state.status, 'error');
    assert.equal(service.state.answer, null);
    service.dispose();
  }
});

test('timeout errors leave the connection retryable and permit another question', async () => {
  let attempts = 0;
  const { service } = fixture({ ask: async () => { if (++attempts === 1) throw new AgentError('timeout', '시간이 초과됐어요.'); return '다시 답변'; } });
  await service.checkConnection();
  service.ask('질문');
  await settled();
  assert.equal(service.state.error, '시간이 초과됐어요.');
  assert.equal(service.state.connection.status, 'ready');
  service.ask('다시 질문');
  await settled();
  assert.equal(service.state.answer, '다시 답변');
  service.dispose();
});

test('disposal aborts checks and prevents late state publications', async () => {
  const pending = deferred<AgentConnection>();
  let signal!: AbortSignal;
  const { service, changes } = fixture({ checkConnection: s => { signal = s; return pending.promise; } });
  const check = service.checkConnection();
  service.dispose();
  const publications = changes.length;
  assert.equal(signal.aborted, true);
  pending.resolve(ready);
  await check;
  assert.equal(changes.length, publications);
  assert.equal(service.ask('질문').ok, false);
  assert.equal((await service.checkConnection()).ok, false);
});

test('disposal during a question suppresses late provider completion', async () => {
  const pending = deferred<string>();
  let signal!: AbortSignal;
  const { service, changes } = fixture({ ask: request => { signal = request.signal; return pending.promise; } });
  await service.checkConnection();
  service.ask('질문');
  assert.equal(service.cancel(null).ok, false);
  service.dispose();
  const publications = changes.length;
  pending.resolve('종료 뒤 답변');
  await settled();
  assert.equal(signal.aborted, true);
  assert.equal(changes.length, publications);
  assert.equal(service.state.answer, null);
});
