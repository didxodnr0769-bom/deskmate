export type AgentConnectionStatus = 'unchecked' | 'checking' | 'ready' | 'not-installed' | 'unauthenticated' | 'error';
export interface AgentConnection { status: AgentConnectionStatus; message: string }
export interface ChatState {
  provider: string;
  providerLabel: string;
  connection: AgentConnection;
  status: 'idle' | 'thinking' | 'answered' | 'cancelled' | 'error';
  requestId: string | null;
  question: string;
  answer: string | null;
  error: string | null;
}
export const MAX_CHAT_QUESTION_LENGTH = 4000;
export const MAX_CHAT_ANSWER_LENGTH = 16000;
