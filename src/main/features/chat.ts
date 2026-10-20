import { randomUUID } from 'node:crypto';
import { MAX_CHAT_ANSWER_LENGTH, MAX_CHAT_CONTEXT_LENGTH, MAX_CHAT_QUESTION_LENGTH, type ChatMessage, type ChatState } from '../../shared/chat';
import type { CommandResult } from '../../shared/contracts';
import { AgentError, type AgentProvider } from '../ai/provider';

type Operation = { id: string; kind: 'check' | 'question'; abort: AbortController };
export interface ChatCommands { process(reply: string, question: string): string; reset(): void }

/** Keeps the current conversation in memory; providers never own app data. */
export class ChatService {
  private current: Operation | null = null;
  private disposed = false;
  private value: ChatState;

  constructor(private readonly provider: AgentProvider, private readonly onChange: (state: ChatState) => void, private readonly commands?: ChatCommands) {
    this.value = { provider: provider.id, providerLabel: provider.label,
      conversationId: randomUUID(), messages: [],
      connection: { status: 'unchecked', message: '연결을 확인해 주세요.' },
      status: 'idle', requestId: null, question: '', answer: null, error: null };
  }

  get state(): ChatState { return { ...this.value, connection: { ...this.value.connection }, messages: this.value.messages.map(message => ({ ...message })) }; }
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
    const text = question.trim();
    const history = this.value.messages.map(message => ({ ...message }));
    // Keep every visible turn. Never silently drop earlier context at the limit.
    if (JSON.stringify(history).length + text.length + MAX_CHAT_ANSWER_LENGTH + 256 > MAX_CHAT_CONTEXT_LENGTH) {
      return { ok: false, error: '대화가 길어졌어요. 현재 이력을 확인한 뒤 새 대화를 시작해 주세요.' };
    }
    const operation: Operation = { id: randomUUID(), kind: 'question', abort: new AbortController() };
    this.current = operation;
    const message: ChatMessage = { id: randomUUID(), requestId: operation.id, role: 'user', text, status: 'pending', createdAt: Date.now() };
    this.value = { ...this.value, status: 'thinking', requestId: operation.id, question: text, answer: null, error: null,
      messages: [...this.value.messages, message] };
    this.publish();
    void this.answer(operation, text, history);
    return { ok: true };
  }

  private markQuestion(requestId: string, status: ChatMessage['status']) {
    this.value.messages = this.value.messages.map(message => message.requestId === requestId && message.role === 'user' ? { ...message, status } : message);
  }

  private async answer(operation: Operation, question: string, history: ChatMessage[]) {
    try {
      const reply = await this.provider.ask({ question, history, ...(this.commands ? { appCommands: true } : {}), signal: operation.abort.signal });
      if (!this.isCurrent(operation)) return;
      if (typeof reply !== 'string' || !reply.trim() || reply.trim().length > MAX_CHAT_ANSWER_LENGTH) {
        throw new AgentError('failed', '답변을 읽지 못했어요. 질문을 짧게 나눠 다시 시도해 주세요.');
      }
      const answer = this.commands ? this.commands.process(reply.trim(), question) : reply.trim();
      if (!this.isCurrent(operation)) return;
      if (typeof answer !== 'string' || !answer.trim() || answer.trim().length > MAX_CHAT_ANSWER_LENGTH) {
        throw new AgentError('failed', '답변을 읽지 못했어요. 질문을 짧게 나눠 다시 시도해 주세요.');
      }
      this.markQuestion(operation.id, 'complete');
      this.value = { ...this.value, status: 'answered', answer: answer.trim(), error: null,
        messages: [...this.value.messages, { id: randomUUID(), requestId: operation.id, role: 'assistant', text: answer.trim(), status: 'complete', createdAt: Date.now() }] };
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      this.markQuestion(operation.id, 'error');
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
    if (!operation || operation.kind !== 'question' || operation.id !== requestId) return { ok: true };
    this.current = null;
    operation.abort.abort();
    this.commands?.reset();
    this.markQuestion(operation.id, 'cancelled');
    this.value = { ...this.value, status: 'cancelled', answer: null, error: null };
    this.publish();
    return { ok: true };
  }

  newConversation(): CommandResult {
    if (this.disposed) return { ok: false, error: '앱을 종료하고 있어요.' };
    if (this.current?.kind === 'question') {
      const operation = this.current;
      this.current = null;
      operation.abort.abort();
    }
    this.commands?.reset();
    this.value = { ...this.value, conversationId: randomUUID(), messages: [], status: 'idle', requestId: null, question: '', answer: null, error: null };
    this.publish();
    return { ok: true };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const operation = this.current;
    this.current = null;
    operation?.abort.abort();
    this.commands?.reset();
  }
}
