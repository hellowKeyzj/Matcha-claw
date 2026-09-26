import type { RuntimeEndpointRef } from '../types/desktop/runtime-address';

const SESSION_TRACE_PREFIX = 'session-trace';
const SESSION_TRACE_STORAGE_KEY = 'matchaclaw:session-trace';

type TracePayload = Record<string, unknown>;

type SessionIdentityLike = {
  endpoint: RuntimeEndpointRef;
  agentId?: string;
  sessionKey: string;
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
  if (!endpoint) {
    return null;
  }
  switch (endpoint.kind) {
    case 'native-runtime':
      return {
        kind: endpoint.kind,
        runtimeAdapterId: endpoint.runtimeAdapterId,
        runtimeInstanceId: endpoint.runtimeInstanceId,
      };
    case 'protocol-connector':
      return {
        kind: endpoint.kind,
        protocolId: summarizeIdentifier(endpoint.protocolId),
        connectorId: summarizeIdentifier(endpoint.connectorId),
        endpointId: summarizeIdentifier(endpoint.endpointId),
      };
  }
}

export function summarizeSessionIdentity(identity: SessionIdentityLike | null | undefined) {
  if (!identity) {
    return null;
  }
  return {
    endpoint: summarizeEndpoint(identity.endpoint),
    agentId: summarizeIdentifier(identity.agentId),
    sessionKey: summarizeIdentifier(identity.sessionKey),
  };
}
