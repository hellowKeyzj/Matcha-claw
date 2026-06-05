import { normalizeSendWithMediaInput } from '../chat/send-media';
import {
  validateRuntimeAddress,
  type RuntimeAddress,
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

function readRuntimeAddress(value: unknown): {
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
} {
  if (value === undefined) {
    return {
      runtimeAddress: null,
      runtimeAddressError: 'RuntimeAddress is required',
    };
  }
  const error = validateRuntimeAddress(value);
  if (error) {
    return {
      runtimeAddress: null,
      runtimeAddressError: error,
    };
  }
  return {
    runtimeAddress: value as RuntimeAddress,
    runtimeAddressError: null,
  };
}

export function readCreateSessionRequest(payload: unknown): {
  explicitSessionKey: string;
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionNewPayload : {};
  return {
    explicitSessionKey: normalizeString(body.sessionKey),
    ...readRuntimeAddress(body.runtimeAddress),
  };
}

export function readRequiredSessionKey(payload: unknown): string {
  const body = isRecord(payload) ? payload as SessionLoadPayload : {};
  return normalizeString(body.sessionKey);
}

export function readRuntimeAddressRequest(payload: unknown): {
  sessionKey: string;
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionLoadPayload : {};
  return {
    sessionKey: normalizeString(body.sessionKey),
    ...readRuntimeAddress(body.runtimeAddress),
  };
}

export function readSessionListRequest(payload: unknown): {
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionLoadPayload : {};
  return readRuntimeAddress(body.runtimeAddress);
}

export function readSessionLoadRequest(payload: unknown): {
  sessionKey: string;
  limit: number;
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionLoadPayload : {};
  return {
    sessionKey: normalizeString(body.sessionKey),
    limit: normalizeWindowLimit(body.limit),
    ...readRuntimeAddress(body.runtimeAddress),
  };
}

export function readAbortSessionRequest(payload: unknown): {
  sessionKey: string;
  approvalIds: string[];
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionAbortRuntimePayload : {};
  const rawApprovalIds = Array.isArray(body.approvalIds) ? body.approvalIds : [];
  return {
    sessionKey: normalizeString(body.sessionKey),
    approvalIds: rawApprovalIds.flatMap((rawApprovalId) => {
      const approvalId = typeof rawApprovalId === 'string' ? rawApprovalId.trim() : '';
      return approvalId ? [approvalId] : [];
    }),
    ...readRuntimeAddress(body.runtimeAddress),
  };
}

export function readResolveApprovalRequest(payload: unknown): {
  id: string;
  decision: '' | 'allow-once' | 'allow-always' | 'deny';
  sessionKey: string;
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionResolveApprovalPayload : {};
  const rawDecision = normalizeString(body.decision);
  const decision = rawDecision === 'allow-once' || rawDecision === 'allow-always' || rawDecision === 'deny'
    ? rawDecision
    : '';
  return {
    id: normalizeString(body.id),
    decision,
    sessionKey: normalizeString(body.sessionKey),
    ...readRuntimeAddress(body.runtimeAddress),
  };
}

export function readPatchSessionRequest(payload: unknown): {
  sessionKey: string;
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
  runtimeModelRef: string;
} {
  const body = isRecord(payload) ? payload as SessionPatchPayload : {};
  return {
    sessionKey: normalizeString(body.sessionKey),
    ...readRuntimeAddress(body.runtimeAddress),
    runtimeModelRef: normalizeString(body.runtimeModelRef),
  };
}

export function readRenameSessionRequest(payload: unknown): {
  sessionKey: string;
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
  label: string;
} {
  const body = isRecord(payload) ? payload as SessionRenamePayload : {};
  return {
    sessionKey: normalizeString(body.sessionKey),
    ...readRuntimeAddress(body.runtimeAddress),
    label: normalizeString(body.label),
  };
}

export function readSessionStatusRequest(payload: unknown): {
  sessionKey: string;
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
  status: 'active' | 'completed' | 'archived' | 'deleted' | null;
} {
  const body = isRecord(payload) ? payload as SessionStatusPayload : {};
  const status = body.status === 'active'
    || body.status === 'completed'
    || body.status === 'archived'
    || body.status === 'deleted'
    ? body.status
    : null;
  return {
    sessionKey: normalizeString(body.sessionKey),
    ...readRuntimeAddress(body.runtimeAddress),
    status,
  };
}

export function readSessionWindowRequest(payload: unknown): {
  sessionKey: string;
  mode: ReturnType<typeof normalizeWindowMode>;
  limit: number;
  offset: number | null;
  includeCanonical: boolean;
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
} {
  const body = isRecord(payload) ? payload as SessionWindowPayload : {};
  return {
    sessionKey: normalizeString(body.sessionKey),
    mode: normalizeWindowMode(body.mode),
    limit: normalizeWindowLimit(body.limit),
    offset: normalizeWindowOffset(body.offset),
    includeCanonical: normalizeIncludeCanonical(body.includeCanonical),
    ...readRuntimeAddress(body.runtimeAddress),
  };
}

export function readPromptSessionRequest(payload: unknown): {
  directBody: SessionPromptPayload;
  mediaBody: ReturnType<typeof normalizeSendWithMediaInput>;
  sessionKey: string;
  message: string;
  requestedRunId: string;
  runtimeAddress: RuntimeAddress | null;
  runtimeAddressError: string | null;
} {
  const directBody = isRecord(payload) ? payload as SessionPromptPayload : {};
  const mediaBody = normalizeSendWithMediaInput(payload);
  const message = typeof directBody.message === 'string'
    ? directBody.message
    : (mediaBody?.message ?? '');
  return {
    directBody,
    mediaBody,
    sessionKey: normalizeString(directBody.sessionKey ?? mediaBody?.sessionKey),
    message,
    requestedRunId: normalizeString(
      directBody.runId
      ?? directBody.idempotencyKey
      ?? mediaBody?.idempotencyKey,
    ),
    ...readRuntimeAddress(directBody.runtimeAddress),
  };
}
