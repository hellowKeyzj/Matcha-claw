import { normalizeSendWithMediaInput } from '../chat/send-media';
import {
  validateRuntimeEndpointRef,
  validateSessionIdentity,
  type RuntimeEndpointRef,
  type SessionIdentity,
} from '../agent-runtime/contracts/runtime-address';
import {
  isRecord,
  normalizeString,
} from './session-value-normalization';
import {
  normalizeIncludeCanonical,
  normalizeWindowLimit,
  normalizeWindowMode,
  normalizeWindowOffset,
} from './session-window-model';
import type {
  SessionAbortRuntimePayload,
  SessionLoadPayload,
  SessionResolveApprovalPayload,
  SessionNewPayload,
  SessionPatchPayload,
  SessionPromptPayload,
  SessionRenamePayload,
  SessionStatusPayload,
  SessionWindowPayload,
} from './session-runtime-types';

function readSessionIdentity(value: unknown, expectedSessionKey?: unknown): {
  sessionIdentity: SessionIdentity | null;
  sessionIdentityError: string | null;
} {
  if (value === undefined) {
    return {
      sessionIdentity: null,
      sessionIdentityError: 'SessionIdentity is required',
    };
  }
  const error = validateSessionIdentity(value);
  if (error) {
    return {
      sessionIdentity: null,
      sessionIdentityError: error,
    };
  }
  const sessionIdentity = value as SessionIdentity;
  const sessionKey = normalizeString(expectedSessionKey);
  if (sessionKey && sessionIdentity.sessionKey !== sessionKey) {
    return {
      sessionIdentity: null,
      sessionIdentityError: 'sessionKey must match SessionIdentity.sessionKey',
    };
  }
  return {
    sessionIdentity,
    sessionIdentityError: null,
  };
}

function readRuntimeEndpoint(value: unknown): {
  endpoint: RuntimeEndpointRef | null;
  endpointError: string | null;
} {
  if (value === undefined) {
    return {
      endpoint: null,
      endpointError: 'RuntimeEndpointRef is required',
    };
  }
  const error = validateRuntimeEndpointRef(value);
  if (error) {
    return {
      endpoint: null,
      endpointError: error,
    };
  }
  return {
    endpoint: value as RuntimeEndpointRef,
    endpointError: null,
  };
}

export function readCreateSessionRequest(payload: unknown): {
  explicitSessionKey: string;
  endpoint: RuntimeEndpointRef | null;
  endpointError: string | null;
  agentId: string;
} {
  const body = isRecord(payload) ? payload as SessionNewPayload : {};
  return {
    explicitSessionKey: normalizeString(body.sessionKey),
    agentId: normalizeString(body.agentId),
    ...readRuntimeEndpoint(body.endpoint),
  };
}

export function readRequiredSessionKey(payload: unknown): string {
  const body = isRecord(payload) ? payload as SessionLoadPayload : {};
  return normalizeString(body.sessionKey);
}

export function readSessionIdentityRequest(payload: unknown): {
  sessionKey: string;
  sessionIdentity: SessionIdentity | null;
  sessionIdentityError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionLoadPayload : {};
  const sessionKey = normalizeString(body.sessionKey);
  return {
    sessionKey,
    ...readSessionIdentity(body.sessionIdentity, sessionKey),
  };
}

export function readSessionListRequest(payload: unknown): {
  endpoint: RuntimeEndpointRef | null;
  endpointError: string | null;
} {
  const body = isRecord(payload) ? payload as { endpoint?: unknown } : {};
  return readRuntimeEndpoint(body.endpoint);
}

export function readSessionLoadRequest(payload: unknown): {
  sessionKey: string;
  limit: number;
  sessionIdentity: SessionIdentity | null;
  sessionIdentityError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionLoadPayload : {};
  const sessionKey = normalizeString(body.sessionKey);
  return {
    sessionKey,
    limit: normalizeWindowLimit(body.limit),
    ...readSessionIdentity(body.sessionIdentity, sessionKey),
  };
}

export function readAbortSessionRequest(payload: unknown): {
  sessionKey: string;
  approvalIds: string[];
  sessionIdentity: SessionIdentity | null;
  sessionIdentityError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionAbortRuntimePayload : {};
  const rawApprovalIds = Array.isArray(body.approvalIds) ? body.approvalIds : [];
  const sessionKey = normalizeString(body.sessionKey);
  return {
    sessionKey,
    approvalIds: rawApprovalIds.flatMap((rawApprovalId) => {
      const approvalId = typeof rawApprovalId === 'string' ? rawApprovalId.trim() : '';
      return approvalId ? [approvalId] : [];
    }),
    ...readSessionIdentity(body.sessionIdentity, sessionKey),
  };
}

export function readResolveApprovalRequest(payload: unknown): {
  id: string;
  decision: '' | 'allow-once' | 'allow-always' | 'deny';
  sessionKey: string;
  sessionIdentity: SessionIdentity | null;
  sessionIdentityError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionResolveApprovalPayload : {};
  const rawDecision = normalizeString(body.decision);
  const decision = rawDecision === 'allow-once' || rawDecision === 'allow-always' || rawDecision === 'deny'
    ? rawDecision
    : '';
  const sessionKey = normalizeString(body.sessionKey);
  return {
    id: normalizeString(body.id),
    decision,
    sessionKey,
    ...readSessionIdentity(body.sessionIdentity, sessionKey),
  };
}

export function readPatchSessionRequest(payload: unknown): {
  sessionKey: string;
  sessionIdentity: SessionIdentity | null;
  sessionIdentityError: string | null;
  runtimeModelRef: string;
} {
  const body = isRecord(payload) ? payload as SessionPatchPayload : {};
  const sessionKey = normalizeString(body.sessionKey);
  return {
    sessionKey,
    ...readSessionIdentity(body.sessionIdentity, sessionKey),
    runtimeModelRef: normalizeString(body.runtimeModelRef),
  };
}

export function readRenameSessionRequest(payload: unknown): {
  sessionKey: string;
  sessionIdentity: SessionIdentity | null;
  sessionIdentityError: string | null;
  label: string;
} {
  const body = isRecord(payload) ? payload as SessionRenamePayload : {};
  const sessionKey = normalizeString(body.sessionKey);
  return {
    sessionKey,
    ...readSessionIdentity(body.sessionIdentity, sessionKey),
    label: normalizeString(body.label),
  };
}

export function readSessionStatusRequest(payload: unknown): {
  sessionKey: string;
  sessionIdentity: SessionIdentity | null;
  sessionIdentityError: string | null;
  status: 'active' | 'completed' | 'archived' | 'deleted' | null;
} {
  const body = isRecord(payload) ? payload as SessionStatusPayload : {};
  const status = body.status === 'active'
    || body.status === 'completed'
    || body.status === 'archived'
    || body.status === 'deleted'
    ? body.status
    : null;
  const sessionKey = normalizeString(body.sessionKey);
  return {
    sessionKey,
    ...readSessionIdentity(body.sessionIdentity, sessionKey),
    status,
  };
}

export function readSessionWindowRequest(payload: unknown): {
  sessionKey: string;
  mode: ReturnType<typeof normalizeWindowMode>;
  limit: number;
  offset: number | null;
  includeCanonical: boolean;
  sessionIdentity: SessionIdentity | null;
  sessionIdentityError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionWindowPayload : {};
  const sessionKey = normalizeString(body.sessionKey);
  return {
    sessionKey,
    mode: normalizeWindowMode(body.mode),
    limit: normalizeWindowLimit(body.limit),
    offset: normalizeWindowOffset(body.offset),
    includeCanonical: normalizeIncludeCanonical(body.includeCanonical),
    ...readSessionIdentity(body.sessionIdentity, sessionKey),
  };
}

export function readPromptSessionRequest(payload: unknown): {
  directBody: SessionPromptPayload;
  mediaBody: ReturnType<typeof normalizeSendWithMediaInput>;
  sessionKey: string;
  message: string;
  requestedRunId: string;
  sessionIdentity: SessionIdentity | null;
  sessionIdentityError: string | null;
} {
  const directBody = isRecord(payload) ? payload as SessionPromptPayload : {};
  const mediaBody = normalizeSendWithMediaInput(payload);
  const message = typeof directBody.message === 'string'
    ? directBody.message
    : (mediaBody?.message ?? '');
  const sessionKey = normalizeString(directBody.sessionKey ?? mediaBody?.sessionKey);
  return {
    directBody,
    mediaBody,
    sessionKey,
    message,
    requestedRunId: normalizeString(
      directBody.runId
      ?? directBody.idempotencyKey
      ?? mediaBody?.idempotencyKey,
    ),
    ...readSessionIdentity(directBody.sessionIdentity, sessionKey),
  };
}
