import { randomUUID } from 'node:crypto';
import { MAX_CHAT_ANSWER_LENGTH, MAX_CHAT_QUESTION_LENGTH, type ChatState } from '../../shared/chat';
import type { CommandResult } from '../../shared/contracts';
import { AgentError, type AgentProvider } from '../ai/provider';

type Operation = { id: string; kind: 'check' | 'question'; abort: AbortController };

/** One ephemeral question at a time. Providers never own app data or presentation. */
export class ChatService {
  private current: Operation | null = null;
  private disposed = false;
  private value: ChatState;

  constructor(private readonly provider: AgentProvider, private readonly onChange: (state: ChatState) => void) {
    this.value = { provider: provider.id, providerLabel: provider.label,
      connection: { status: 'unchecked', message: '연결을 확인해 주세요.' },
      status: 'idle', requestId: null, question: '', answer: null, error: null };
  }

  get state(): ChatState { return { ...this.value, connection: { ...this.value.connection } }; }
  private publish() { if (!this.disposed) this.onChange(this.state); }
  private isCurrent(operation: Operation) { return !this.disposed && this.current === operation; }

  async checkConnection(): Promise<CommandResult> {
    if (this.disposed) return { ok: false, error: '앱을 종료하고 있어요.' };
    if (this.current) return { ok: false, error: '진행 중인 요청이 끝난 뒤 다시 확인해 주세요.' };
    const operation: Operation = { id: randomUUID(), kind: 'check', abort: new AbortController() };
    this.current = operation;
    this.value.connection = { status: 'checking', message: '연결을 확인하고 있어요…' };
    this.publish();
    try {
      const connection = await this.provider.checkConnection(operation.abort.signal);
      if (!this.isCurrent(operation)) return { ok: false };
      this.value.connection = connection;
      return { ok: connection.status === 'ready', ...(connection.status === 'ready' ? {} : { error: connection.message }) };
    } catch (error) {
      if (!this.isCurrent(operation)) return { ok: false };
      const message = error instanceof AgentError ? error.message : '연결을 확인하지 못했어요. 다시 시도해 주세요.';
      this.value.connection = { status: error instanceof AgentError && (error.code === 'not-installed' || error.code === 'unauthenticated') ? error.code : 'error', message };
      return { ok: false, error: message };
    } finally {
      if (this.isCurrent(operation)) { this.current = null; this.publish(); }
    }
  }

  ask(question: unknown): CommandResult {
    if (this.disposed) return { ok: false, error: '앱을 종료하고 있어요.' };
    if (typeof question !== 'string' || !question.trim() || question.trim().length > MAX_CHAT_QUESTION_LENGTH) {
      return { ok: false, error: `질문은 1~${MAX_CHAT_QUESTION_LENGTH.toLocaleString('ko-KR')}자로 입력해 주세요.` };
    }
    if (this.current) return { ok: false, error: '답변을 기다리거나 진행 중인 요청을 취소해 주세요.' };
    if (this.value.connection.status !== 'ready') return { ok: false, error: '먼저 AI 연결을 확인해 주세요.' };
    const operation: Operation = { id: randomUUID(), kind: 'question', abort: new AbortController() };
    this.current = operation;
    this.value = { ...this.value, status: 'thinking', requestId: operation.id, question: question.trim(), answer: null, error: null };
    this.publish();
    void this.answer(operation);
    return { ok: true };
  }

  private async answer(operation: Operation) {
    try {
      const answer = await this.provider.ask({ question: this.value.question, signal: operation.abort.signal });
      if (!this.isCurrent(operation)) return;
      if (typeof answer !== 'string' || !answer.trim() || answer.trim().length > MAX_CHAT_ANSWER_LENGTH) {
        throw new AgentError('failed', '답변을 읽지 못했어요. 질문을 짧게 나눠 다시 시도해 주세요.');
      }
      this.value = { ...this.value, status: 'answered', answer: answer.trim(), error: null };
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      const message = error instanceof AgentError ? error.message : '답변을 받지 못했어요. 다시 시도해 주세요.';
      this.value = { ...this.value, status: 'error', answer: null, error: message };
      if (error instanceof AgentError && (error.code === 'not-installed' || error.code === 'unauthenticated')) {
        this.value.connection = { status: error.code, message };
      }
    } finally {
      if (this.isCurrent(operation)) { this.current = null; this.publish(); }
    }
  }

  cancel(requestId: unknown): CommandResult {
    if (typeof requestId !== 'string' || requestId.length > 100) return { ok: false, error: '요청을 확인하지 못했어요.' };
    const operation = this.current;
    // Delayed UI events must never cancel the following question.
    if (!operation || operation.kind !== 'question' || operation.id !== requestId) return { ok: true };
    this.current = null;
    operation.abort.abort();
    this.value = { ...this.value, status: 'cancelled', answer: null, error: null };
    this.publish();
    return { ok: true };
  }

  dispose() {
    this.disposed = true;
    const operation = this.current;
    this.current = null;
    operation?.abort.abort();
  }
}
