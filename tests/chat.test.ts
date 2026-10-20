import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatService, type ChatCommands } from '../src/main/features/chat';
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
function fixture(overrides: Partial<AgentProvider> = {}, commands?: ChatCommands) {
  const changes: ChatState[] = [];
  const provider: AgentProvider = { id: 'fixture', label: '테스트 연결',
    checkConnection: async () => ready, ask: async () => '답변', ...overrides };
  const service = new ChatService(provider, state => changes.push(state), commands);
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

test('every visible conversation message is retained and passed to later questions until new conversation', async () => {
  const requests: { question: string; history: unknown }[] = [];
  const { service } = fixture({ ask: async request => {
    requests.push({ question: request.question, history: structuredClone(request.history) });
    return `답변 ${requests.length}`;
  } });
  await service.checkConnection();
  const conversationId = service.state.conversationId;
  service.ask('첫 질문'); await settled();
  service.ask('방금 뭐 물어봤지?'); await settled();
  assert.deepEqual((requests[1].history as { role: string; text: string }[]).map(m => [m.role, m.text]), [['user', '첫 질문'], ['assistant', '답변 1']]);
  assert.equal(service.state.messages.length, 4);
  assert.equal(service.state.conversationId, conversationId);
  const snapshot = service.state;
  snapshot.messages[0].text = '외부 변경';
  assert.equal(service.state.messages[0].text, '첫 질문');
  service.newConversation();
  assert.notEqual(service.state.conversationId, conversationId);
  assert.deepEqual(service.state.messages, []);
  service.ask('새 첫 질문'); await settled();
  assert.deepEqual(requests[2].history, []);
  assert.equal(service.state.messages.length, 2);
  service.dispose();
});

test('new conversation cancels an active request and suppresses its late result in both state and history', async () => {
  const response = deferred<string>(); let signal!: AbortSignal;
  const { service } = fixture({ ask: request => { signal = request.signal; return response.promise; } });
  await service.checkConnection(); service.ask('잊을 질문');
  const old = service.state.conversationId;
  assert.equal(service.newConversation().ok, true);
  assert.equal(signal.aborted, true);
  response.resolve('늦은 답변'); await settled();
  assert.equal(service.state.status, 'idle');
  assert.equal(service.state.requestId, null);
  assert.deepEqual(service.state.messages, []);
  assert.notEqual(service.state.conversationId, old);
  service.dispose();
});

test('cancelled and failed questions stay visible without inventing assistant answers', async () => {
  let count = 0;
  const never = deferred<string>();
  const { service } = fixture({ ask: async () => { count++; if (count === 1) return never.promise; throw new Error('PRIVATE'); } });
  await service.checkConnection(); service.ask('취소 질문'); service.cancel(service.state.requestId);
  service.ask('실패 질문'); await settled();
  assert.deepEqual(service.state.messages.map(m => [m.role, m.text, m.status]), [['user', '취소 질문', 'cancelled'], ['user', '실패 질문', 'error']]);
  assert.doesNotMatch(JSON.stringify(service.state.messages), /PRIVATE/);
  service.dispose();
});

test('context capacity never silently discards earlier visible messages', async () => {
  const { service } = fixture({ ask: async () => '답'.repeat(16000) });
  await service.checkConnection();
  for (let index = 0; index < 30; index++) {
    const before = service.state.messages;
    const accepted = service.ask(`질문 ${index} ` + '가'.repeat(3900));
    if (!accepted.ok) {
      assert.match(accepted.error!, /새 대화/);
      assert.deepEqual(service.state.messages, before);
      assert.equal(service.state.messages[0].text.startsWith('질문 0'), true);
      assert.ok(before.length > 2);
      service.newConversation();
      assert.equal(service.ask('다시 시작').ok, true);
      await settled(); service.dispose(); return;
    }
    await settled();
  }
  service.dispose(); assert.fail('the explicit context capacity must eventually be reached');
});

test('new conversation during connection check preserves the eventual connection result', async () => {
  const check = deferred<AgentConnection>();
  const { service } = fixture({ checkConnection: () => check.promise });
  const pending = service.checkConnection();
  const old = service.state.conversationId;
  service.newConversation(); check.resolve(ready); await pending;
  assert.notEqual(service.state.conversationId, old);
  assert.equal(service.state.connection.status, 'ready');
  assert.deepEqual(service.state.messages, []);
  service.dispose();
});


test('command mode processes one current provider reply and keeps only the actual app result in history', async () => {
  const requests: Parameters<AgentProvider['ask']>[0][] = [];
  const processed: [string, string][] = [];
  const raw = JSON.stringify({ kind: 'command', command: { name: 'memo.add', text: '장보기' } });
  const { service } = fixture({ ask: async request => { requests.push(request); return raw; } }, {
    process: (reply, question) => { processed.push([reply, question]); return '장보기 메모를 추가했어요.'; }, reset() {},
  });
  await service.checkConnection();
  service.ask('장보기 메모 추가'); await settled();
  assert.equal(requests[0].appCommands, true);
  assert.deepEqual(processed, [[raw, '장보기 메모 추가']]);
  assert.equal(service.state.answer, '장보기 메모를 추가했어요.');
  assert.deepEqual(service.state.messages.map(message => [message.role, message.text]), [
    ['user', '장보기 메모 추가'], ['assistant', '장보기 메모를 추가했어요.'],
  ]);
  service.ask('방금 추가한 메모는?'); await settled();
  assert.equal(requests[1].history?.[1].text, '장보기 메모를 추가했어요.');
  assert.doesNotMatch(JSON.stringify(requests[1].history), /"kind"|"command"/);
  service.dispose();
});

test('without a command handler the provider request and plain conversation remain unchanged', async () => {
  let request!: Parameters<AgentProvider['ask']>[0];
  const { service } = fixture({ ask: async value => { request = value; return '그대로 답변'; } });
  await service.checkConnection(); service.ask('일반 질문'); await settled();
  assert.equal(Object.hasOwn(request, 'appCommands'), false);
  assert.equal(service.state.answer, '그대로 답변');
  service.dispose();
});

test('late command plans after cancel, new conversation or disposal never execute', async () => {
  for (const action of ['cancel', 'new', 'dispose'] as const) {
    const response = deferred<string>();
    let processed = 0, reset = 0;
    const { service } = fixture({ ask: () => response.promise }, {
      process: () => { processed++; return '실행 결과'; }, reset: () => { reset++; },
    });
    await service.checkConnection(); service.ask('늦게 실행하면 안 되는 요청');
    if (action === 'cancel') service.cancel(service.state.requestId);
    if (action === 'new') service.newConversation();
    if (action === 'dispose') service.dispose();
    response.resolve('{"kind":"command","command":{"name":"character.walk","enabled":false}}');
    await settled();
    assert.equal(processed, 0);
    assert.equal(service.state.answer, null);
    assert.equal(reset, 1);
    service.dispose(); service.dispose();
    assert.equal(reset, action === 'dispose' ? 1 : 2);
  }
});

test('a cancelled old plan cannot execute after a newer command has completed', async () => {
  const old = deferred<string>(), current = deferred<string>();
  const processed: string[] = [];
  let calls = 0;
  const { service } = fixture({ ask: () => ++calls === 1 ? old.promise : current.promise }, {
    process: (_reply, question) => { processed.push(question); return '현재 요청의 실행 결과'; }, reset() {},
  });
  await service.checkConnection(); service.ask('취소할 명령'); service.cancel(service.state.requestId);
  service.ask('현재 명령'); current.resolve('현재 계획'); await settled();
  old.resolve('취소된 계획'); await settled();
  assert.deepEqual(processed, ['현재 명령']);
  assert.equal(service.state.answer, '현재 요청의 실행 결과');
  service.dispose();
});

test('invalid raw responses are rejected before the app command processor is called', async () => {
  for (const reply of ['', '   ', 'x'.repeat(MAX_CHAT_ANSWER_LENGTH + 1), null]) {
    let processed = 0;
    const { service } = fixture({ ask: async () => reply as string }, {
      process: () => { processed++; return '실행됐다는 잘못된 결과'; }, reset() {},
    });
    await service.checkConnection(); service.ask('명령'); await settled();
    assert.equal(processed, 0);
    assert.equal(service.state.status, 'error');
    assert.equal(service.state.messages.some(message => message.role === 'assistant'), false);
    service.dispose();
  }
});

test('invalid command results and processor exceptions do not leak a plan or raw diagnostic to visible history', async () => {
  for (const output of ['', 'x'.repeat(MAX_CHAT_ANSWER_LENGTH + 1), null, new Error('PRIVATE PROCESSOR DIAGNOSTIC')]) {
    const { service } = fixture({ ask: async () => '{"kind":"command","command":{"name":"summary.get"}}' }, {
      process: () => { if (output instanceof Error) throw output; return output as string; }, reset() {},
    });
    await service.checkConnection(); service.ask('요약'); await settled();
    assert.equal(service.state.status, 'error');
    assert.equal(service.state.answer, null);
    assert.deepEqual(service.state.messages.map(message => [message.role, message.status]), [['user', 'error']]);
    assert.doesNotMatch(JSON.stringify(service.state), /PRIVATE PROCESSOR|summary.get/);
    service.dispose();
  }
});

test('new conversation clears pending command selections while preserving the usable connection', async () => {
  let resets = 0;
  const { service } = fixture({}, { process: () => '선택할 메모를 알려 주세요.', reset: () => { resets++; } });
  await service.checkConnection(); service.ask('메모 완료'); await settled();
  service.newConversation();
  assert.equal(resets, 1);
  assert.equal(service.state.connection.status, 'ready');
  assert.deepEqual(service.state.messages, []);
  service.dispose();
  assert.equal(resets, 2);
});


test('cancelling the current question resets an old selection once while stale or invalid cancellation does not', async () => {
  const response = deferred<string>();
  let calls = 0, resets = 0, executions = 0;
  let pendingSelection = false;
  const { service } = fixture({ ask: () => ++calls === 2 ? response.promise : Promise.resolve('계획') }, {
    process: (_reply, question) => {
      if (question === '메모 완료') { pendingSelection = true; return '어느 메모인지 번호로 선택해 주세요.'; }
      if (question === '1') {
        if (pendingSelection) { executions++; return '이전 후보를 완료했어요.'; }
        return '선택 대기 중인 메모가 없어요.';
      }
      return '현재 질문의 답변';
    },
    reset: () => { pendingSelection = false; resets++; },
  });
  await service.checkConnection();
  service.ask('메모 완료'); await settled();
  assert.equal(pendingSelection, true);
  service.ask('다른 질문');
  const id = service.state.requestId!;
  assert.equal(service.cancel('stale-request').ok, true);
  assert.equal(service.cancel(null).ok, false);
  assert.equal(resets, 0);
  assert.equal(service.cancel(id).ok, true);
  assert.equal(pendingSelection, false);
  assert.equal(resets, 1);
  assert.equal(service.cancel(id).ok, true);
  assert.equal(resets, 1);
  response.resolve('늦은 계획'); await settled();
  service.ask('1'); await settled();
  assert.equal(executions, 0);
  assert.equal(service.state.answer, '선택 대기 중인 메모가 없어요.');
  assert.equal(resets, 1);
  service.dispose();
  assert.equal(resets, 2);
});
