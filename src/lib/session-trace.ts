import type { RuntimeEndpointRef } from '../../electron/desktop-contract/runtime-address';

const SESSION_TRACE_PREFIX = 'session-trace';
const SESSION_TRACE_STORAGE_KEY = 'matchaclaw:session-trace';

type TracePayload = Record<string, unknown>;

type SessionIdentityLike = {
  endpoint?: {
    kind?: string;
    runtimeAdapterId?: string;
    runtimeInstanceId?: string;
  };
  agentId?: unknown;
  sessionKey?: unknown;
};

function isSessionTraceEnabled(): boolean {
  if (import.meta.env.VITE_MATCHACLAW_SESSION_TRACE === '1') {
    return true;
  }
  try {
    return window.localStorage.getItem(SESSION_TRACE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function createSessionTraceId(label: string): string | null {
  if (!isSessionTraceEnabled()) {
    return null;
  }
  return `${SESSION_TRACE_PREFIX}:${label}:${crypto.randomUUID()}`;
}

export function logSessionTrace(stage: string, traceId: string | null | undefined, payload: TracePayload = {}): void {
  if (!traceId || !isSessionTraceEnabled()) {
    return;
  }
  console.info(JSON.stringify({
    prefix: SESSION_TRACE_PREFIX,
    source: 'renderer',
    traceId,
    stage,
    at: Date.now(),
    ...payload,
  }));
}

export function summarizeIdentifier(value: string | null | undefined): { present: boolean; length: number; hash: string | null } {
  if (!value) {
    return { present: false, length: 0, hash: null };
  }
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    present: true,
    length: value.length,
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
  };
}

export function summarizeError(error: unknown): {
  errorName: string;
  message: { present: boolean; length: number; hash: string | null };
} {
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    message: summarizeIdentifier(message),
  };
}

export function summarizeEndpoint(endpoint: RuntimeEndpointRef | null | undefined) {
  return endpoint
    ? {
        runtimeAdapterId: endpoint.runtimeAdapterId,
        runtimeInstanceId: endpoint.runtimeInstanceId,
      }
    : null;
}

export function summarizeSessionIdentity(identity: SessionIdentityLike | null | undefined) {
  if (!identity) {
    return null;
  }
  const endpoint = identity.endpoint && typeof identity.endpoint.runtimeAdapterId === 'string' && typeof identity.endpoint.runtimeInstanceId === 'string'
    ? summarizeEndpoint({
        kind: 'native-runtime',
        runtimeAdapterId: identity.endpoint.runtimeAdapterId,
        runtimeInstanceId: identity.endpoint.runtimeInstanceId,
      })
    : null;
  return {
    endpoint,
    agentId: summarizeIdentifier(typeof identity.agentId === 'string' ? identity.agentId : null),
    sessionKey: summarizeIdentifier(typeof identity.sessionKey === 'string' ? identity.sessionKey : null),
  };
}
