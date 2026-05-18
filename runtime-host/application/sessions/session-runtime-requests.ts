import { normalizeSendWithMediaInput } from '../chat/send-media';
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
  SessionNewPayload,
  SessionPatchPayload,
  SessionPromptPayload,
  SessionRenamePayload,
  SessionWindowPayload,
} from './session-runtime-types';

export function readCreateSessionRequest(payload: unknown): {
  explicitSessionKey: string;
  agentId: string;
  canonicalPrefix: string;
} {
  const body = isRecord(payload) ? payload as SessionNewPayload : {};
  const explicitSessionKey = normalizeString(body.sessionKey);
  const agentId = normalizeString(body.agentId) || 'main';
  return {
    explicitSessionKey,
    agentId,
    canonicalPrefix: normalizeString(body.canonicalPrefix) || `agent:${agentId}`,
  };
}

export function readRequiredSessionKey(payload: unknown): string {
  const body = isRecord(payload) ? payload as SessionLoadPayload : {};
  return normalizeString(body.sessionKey);
}

export function readAbortSessionKey(payload: unknown, fallbackSessionKey: string | null): string {
  const body = isRecord(payload) ? payload as SessionAbortRuntimePayload : {};
  return normalizeString(body.sessionKey) || fallbackSessionKey || '';
}

export function readPatchSessionRequest(payload: unknown): {
  sessionKey: string;
  model: string;
} {
  const body = isRecord(payload) ? payload as SessionPatchPayload : {};
  return {
    sessionKey: normalizeString(body.sessionKey),
    model: normalizeString(body.model),
  };
}

export function readRenameSessionRequest(payload: unknown): {
  sessionKey: string;
  label: string;
} {
  const body = isRecord(payload) ? payload as SessionRenamePayload : {};
  return {
    sessionKey: normalizeString(body.sessionKey),
    label: normalizeString(body.label),
  };
}

export function readSessionWindowRequest(payload: unknown): {
  sessionKey: string;
  mode: ReturnType<typeof normalizeWindowMode>;
  limit: number;
  offset: number | null;
  includeCanonical: boolean;
} {
  const body = isRecord(payload) ? payload as SessionWindowPayload : {};
  return {
    sessionKey: normalizeString(body.sessionKey),
    mode: normalizeWindowMode(body.mode),
    limit: normalizeWindowLimit(body.limit),
    offset: normalizeWindowOffset(body.offset),
    includeCanonical: normalizeIncludeCanonical(body.includeCanonical),
  };
}

export function readPromptSessionRequest(payload: unknown): {
  directBody: SessionPromptPayload;
  mediaBody: ReturnType<typeof normalizeSendWithMediaInput>;
  sessionKey: string;
  message: string;
  requestedRunId: string;
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
  };
}
