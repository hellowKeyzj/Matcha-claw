import type { RuntimeHostDeliveryIssuer } from '../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from './client';

const EXECUTE_PATH = '/api/capabilities/execute';
const INVALID = { success: false, error: 'OpenClaw gateway capability request is invalid' } as const;
const UNAVAILABLE = { success: false, error: 'OpenClaw gateway capability is unavailable' } as const;

export type OpenClawGatewayCapabilityResponse = Readonly<{
  status: 200 | 400 | 409 | 503;
  body: unknown;
}>;

export interface OpenClawGatewayTransport {
  execute(request: unknown): Promise<OpenClawGatewayCapabilityResponse>;
}

export function createOpenClawGatewayTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): OpenClawGatewayTransport {
  return {
    async execute(request): Promise<OpenClawGatewayCapabilityResponse> {
      const decision = decisionFor(request);
      if (!decision) return { status: 400, body: INVALID };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: EXECUTE_PATH,
        issuer,
        decision,
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isJsonValue(response.body, new Set<object>())) {
        return { status: 200, body: response.body };
      }
      if (response?.status === 400) return { status: 400, body: INVALID };
      if (response?.status === 409) return { status: 409, body: UNAVAILABLE };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function decisionFor(value: unknown) {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])) return null;
  if (value.id === 'openclaw.browser' && value.operationId === 'browser.request') {
    return {
      endpoint: EXECUTE_PATH,
      scope: 'openclaw.browser',
      capability: 'browser.request',
      subject: 'openclaw-browser',
    } as const;
  }
  if (value.id === 'openclaw.mcpApp' && typeof value.operationId === 'string' && value.operationId.startsWith('mcp.app.')) {
    return {
      endpoint: EXECUTE_PATH,
      scope: 'openclaw.mcpApp',
      capability: value.operationId,
      subject: 'openclaw-mcp-app',
    } as const;
  }
  if (value.id === 'openclaw.question' && value.operationId === 'question.resolve') {
    return {
      endpoint: EXECUTE_PATH,
      scope: 'openclaw.question',
      capability: 'question.resolve',
      subject: 'openclaw-question',
    } as const;
  }
  return null;
}

function isJsonValue(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, seen));
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null)
      && Object.values(value).every((entry) => isJsonValue(entry, seen));
  } finally {
    seen.delete(value);
  }
}
