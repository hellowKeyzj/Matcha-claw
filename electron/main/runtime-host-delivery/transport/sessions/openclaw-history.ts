import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = {
  success: false,
  error: 'OpenClaw chat history is unavailable',
} as const;

type OpenClawHistoryRequest = Readonly<{
  id: 'openclaw.chat.history';
  operationId: 'openclaw.chat.history';
  sessionKey: string;
}>;

type OpenClawHistoryResponse = Readonly<{
  messages: readonly Readonly<{
    role: 'user' | 'assistant';
    text: string;
  }>[];
}>;

export type OpenClawHistoryTransportResponse = Readonly<{
  status: 200 | 400 | 503;
  body: OpenClawHistoryResponse | typeof UNAVAILABLE;
}>;

export interface OpenClawHistoryTransport {
  read(request: unknown): Promise<OpenClawHistoryTransportResponse>;
}

export function createOpenClawHistoryTransport(
  issuer: RuntimeHostDeliveryIssuer,
  openclawHistoryTransportPort: number,
  fetcher: typeof fetch = fetch,
): OpenClawHistoryTransport {
  const url = `http://127.0.0.1:${openclawHistoryTransportPort}/api/openclaw/chat/history`;
  return {
    async read(request: unknown): Promise<OpenClawHistoryTransportResponse> {
      if (!isRequest(request)) return { status: 400, body: UNAVAILABLE };
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/openclaw/chat/history',
              scope: 'openclaw:chat-history:read',
              capability: 'openclaw.chat.history',
              subject: 'openclaw-chat-history',
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

function isRequest(value: unknown): value is OpenClawHistoryRequest {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'operationId', 'sessionKey'])
    && value.id === 'openclaw.chat.history'
    && value.operationId === 'openclaw.chat.history'
    && typeof value.sessionKey === 'string'
    && value.sessionKey.trim().length > 0
    && value.sessionKey.length <= 4096
    && !value.sessionKey.includes('\0');
}

function isResponse(value: unknown): value is OpenClawHistoryResponse {
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
