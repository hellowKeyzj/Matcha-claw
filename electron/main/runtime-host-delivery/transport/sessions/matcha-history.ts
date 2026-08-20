import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
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
  matchaHistoryTransportPort: number,
  fetcher: typeof fetch = fetch,
): MatchaAgentHistoryTransport {
  const url = `http://127.0.0.1:${matchaHistoryTransportPort}/api/matcha-agent/chat/history`;
  return {
    async read(request: unknown): Promise<MatchaAgentHistoryTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: UNAVAILABLE };
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/matcha-agent/chat/history',
              scope: 'matcha-agent:chat-history:read',
              capability: 'matcha-agent.chat.history',
              subject: 'matcha-agent-chat-history',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isResponse(body)) return { status: 200, body };
      } catch {
        // The public contract deliberately suppresses transport details.
      }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
