import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';

const ROUTE_PATH = '/api/matcha-agent/chat/history';
const UNAVAILABLE = {
  success: false,
  error: 'Matcha Agent chat history is unavailable',
} as const;

type MatchaAgentHistoryRequest = Readonly<{
  id: 'matcha-agent.chat.history';
  operationId: 'matcha-agent.chat.history';
  sessionId: string;
}>;

type MatchaAgentHistoryResponse = Readonly<{
  messages: readonly Readonly<{
    role: 'user' | 'assistant';
    text: string;
  }>[];
}>;

export type MatchaAgentHistoryTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: MatchaAgentHistoryResponse | typeof UNAVAILABLE;
}>;

export interface MatchaAgentHistoryTransport {
  read(request: unknown): Promise<MatchaAgentHistoryTransportResponse>;
}

export function createMatchaAgentHistoryTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): MatchaAgentHistoryTransport {
  return {
    async read(request: unknown): Promise<MatchaAgentHistoryTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: UNAVAILABLE };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ROUTE_PATH,
        issuer,
        decision: {
          endpoint: ROUTE_PATH,
          scope: 'matcha-agent:chat-history:read',
          capability: 'matcha-agent.chat.history',
          subject: 'matcha-agent-chat-history',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isResponse(response.body)) return { status: 200, body: response.body };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is MatchaAgentHistoryRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'sessionId'])
    && value.id === 'matcha-agent.chat.history'
    && value.operationId === 'matcha-agent.chat.history'
    && typeof value.sessionId === 'string'
    && value.sessionId.trim().length > 0
    && value.sessionId.length <= 4096
    && !value.sessionId.includes('\0');
}

function isResponse(value: unknown): value is MatchaAgentHistoryResponse {
  return isRecord(value)
    && hasExactKeys(value, ['messages'])
    && Array.isArray(value.messages)
    && value.messages.every((message) => isRecord(message)
      && hasExactKeys(message, ['role', 'text'])
      && (message.role === 'user' || message.role === 'assistant')
      && typeof message.text === 'string');
}
