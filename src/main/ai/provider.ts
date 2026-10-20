import type { AgentConnection, ChatMessage } from '../../shared/chat';

export interface AgentProvider {
  readonly id: string;
  readonly label: string;
  checkConnection(signal: AbortSignal): Promise<AgentConnection>;
  ask(request: { question: string; history?: readonly ChatMessage[]; appCommands?: boolean; signal: AbortSignal }): Promise<string>;
}
export type AgentErrorCode = 'not-installed' | 'unauthenticated' | 'timeout' | 'cancelled' | 'failed';
export class AgentError extends Error {
  constructor(readonly code: AgentErrorCode, message: string) { super(message); this.name = 'AgentError'; }
}
