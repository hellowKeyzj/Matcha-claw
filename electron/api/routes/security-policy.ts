import type { IncomingMessage, ServerResponse } from 'http';
import type {
  SecurityPolicyRequest,
  SecurityPolicyTransport,
} from '../../main/runtime-host-delivery/transport/security/policy';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Security policy request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Security policy is unavailable',
} as const;

export async function handleSecurityPolicyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: SecurityPolicyTransport,
): Promise<boolean> {
  if (url.pathname === '/api/security/policy/current' && req.method === 'GET') {
    try {
      const policy = await transport.read();
      sendJson(res, policy ? 200 : 503, policy ?? UNAVAILABLE);
    } catch {
      sendJson(res, 503, UNAVAILABLE);
    }
    return true;
  }
  if (url.pathname !== '/api/security/policy' || req.method !== 'POST') return false;

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!isRequest(body)) {
    sendJson(res, 400, INVALID);
    return true;
  }
  try {
    const response = await transport.submit(body);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function isRequest(value: unknown): value is SecurityPolicyRequest {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])) return false;
  return value.id === 'security.policy'
    && value.operationId === 'security.replace'
    && isExactRecord(value.scope, ['kind'])
    && value.scope.kind === 'security-policy'
    && isExactRecord(value.target, ['kind'])
    && value.target.kind === 'security-policy'
    && isRecord(value.input)
    && hasExactKeys(value.input, ['policy'])
    && isPolicy(value.input.policy);
}

function isPolicy(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && hasExactKeys(value, ['preset', 'securityPolicyVersion', 'runtime'])
    && (value.preset === 'strict' || value.preset === 'balanced' || value.preset === 'relaxed')
    && isPositiveInteger(value.securityPolicyVersion)
    && isRecord(value.runtime);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, keys);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
