import { buildCanonicalApprovalEventsFromGatewayNotification, type CanonicalApprovalNotification } from '../../../sessions/canonical/canonical-approval-events';
import type { CanonicalApprovalEvent } from '../../../sessions/canonical/canonical-events';
import { OPENCLAW_RUNTIME_ENDPOINT_ID, OPENCLAW_RUNTIME_PROTOCOL_ID } from './openclaw-runtime-identity';

export type { CanonicalApprovalNotification } from '../../../sessions/canonical/canonical-approval-events';

type OpenClawApprovalPayload = {
  id: string;
  sessionKey: string;
  runId?: string;
  title?: string;
  command?: string;
  allowedDecisions?: readonly string[];
  request?: Record<string, unknown>;
  createdAtMs?: number;
  expiresAtMs?: number;
  decision?: string;
  raw: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 10_000_000_000 ? value * 1000 : value;
}

function readAllowedDecisions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const decisions = value
    .filter((item): item is string => item === 'allow-once' || item === 'allow-always' || item === 'deny');
  return decisions.length > 0 ? [...new Set(decisions)] : undefined;
}

function readCommandArgv(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function normalizeRequestedPayload(params: unknown): OpenClawApprovalPayload | null {
  const record = asRecord(params);
  if (!record) {
    return null;
  }
  const data = asRecord(record.data);
  const request = asRecord(record.request) ?? asRecord(data?.request);
  const id = asString(record.id) ?? asString(data?.id);
  const sessionKey = asString(record.sessionKey) ?? asString(data?.sessionKey) ?? asString(request?.sessionKey);
  if (!id || !sessionKey) {
    return null;
  }
  const command = asString(record.command)
    ?? asString(data?.command)
    ?? asString(record.commandPreview)
    ?? asString(data?.commandPreview)
    ?? asString(request?.commandPreview)
    ?? asString(request?.command)
    ?? readCommandArgv(record.commandArgv)
    ?? readCommandArgv(data?.commandArgv)
    ?? readCommandArgv(request?.commandArgv);
  return {
    id,
    sessionKey,
    ...(asString(record.runId) ?? asString(data?.runId) ?? asString(request?.runId)
      ? { runId: asString(record.runId) ?? asString(data?.runId) ?? asString(request?.runId) }
      : {}),
    ...(asString(record.title) ?? asString(data?.title) ?? asString(request?.title) ?? asString(record.toolName) ?? asString(data?.toolName) ?? asString(request?.toolName) ?? asString(record.host) ?? asString(data?.host) ?? asString(request?.host)
      ? { title: asString(record.title) ?? asString(data?.title) ?? asString(request?.title) ?? asString(record.toolName) ?? asString(data?.toolName) ?? asString(request?.toolName) ?? asString(record.host) ?? asString(data?.host) ?? asString(request?.host) }
      : {}),
    ...(command ? { command } : {}),
    ...(readAllowedDecisions(record.allowedDecisions ?? data?.allowedDecisions ?? request?.allowedDecisions)
      ? { allowedDecisions: readAllowedDecisions(record.allowedDecisions ?? data?.allowedDecisions ?? request?.allowedDecisions) }
      : {}),
    ...(request ? { request } : {}),
    ...(asMs(record.createdAtMs) ?? asMs(record.createdAt) ?? asMs(record.requestedAt) ?? asMs(data?.createdAtMs) ?? asMs(data?.createdAt) ?? asMs(data?.requestedAt) ?? asMs(request?.createdAtMs) ?? asMs(request?.createdAt) ?? asMs(request?.requestedAt)
      ? { createdAtMs: asMs(record.createdAtMs) ?? asMs(record.createdAt) ?? asMs(record.requestedAt) ?? asMs(data?.createdAtMs) ?? asMs(data?.createdAt) ?? asMs(data?.requestedAt) ?? asMs(request?.createdAtMs) ?? asMs(request?.createdAt) ?? asMs(request?.requestedAt) }
      : {}),
    ...(asMs(record.expiresAtMs) ?? asMs(record.expiresAt) ?? asMs(data?.expiresAtMs) ?? asMs(data?.expiresAt) ?? asMs(request?.expiresAtMs) ?? asMs(request?.expiresAt)
      ? { expiresAtMs: asMs(record.expiresAtMs) ?? asMs(record.expiresAt) ?? asMs(data?.expiresAtMs) ?? asMs(data?.expiresAt) ?? asMs(request?.expiresAtMs) ?? asMs(request?.expiresAt) }
      : {}),
    raw: params,
  };
}

function normalizeResolvedPayload(params: unknown): OpenClawApprovalPayload | null {
  const record = asRecord(params);
  if (!record) {
    return null;
  }
  const data = asRecord(record.data);
  const request = asRecord(record.request) ?? asRecord(data?.request);
  const id = asString(record.id) ?? asString(data?.id);
  const sessionKey = asString(record.sessionKey) ?? asString(data?.sessionKey) ?? asString(request?.sessionKey);
  if (!id || !sessionKey) {
    return null;
  }
  return {
    id,
    sessionKey,
    ...(asString(record.runId) ?? asString(data?.runId) ?? asString(request?.runId)
      ? { runId: asString(record.runId) ?? asString(data?.runId) ?? asString(request?.runId) }
      : {}),
    ...(asString(record.decision) ?? asString(data?.decision) ?? asString(request?.decision)
      ? { decision: asString(record.decision) ?? asString(data?.decision) ?? asString(request?.decision) }
      : {}),
    raw: params,
  };
}

function normalizeOpenClawApprovalNotification(notification: CanonicalApprovalNotification, nowMs: number): CanonicalApprovalNotification {
  if (notification.method === 'exec.approval.requested' || notification.method === 'plugin.approval.requested') {
    const normalized = normalizeRequestedPayload(notification.params);
    if (!normalized) {
      return notification;
    }
    return {
      method: notification.method,
      params: {
        id: normalized.id,
        sessionKey: normalized.sessionKey,
        ...(normalized.runId ? { runId: normalized.runId } : {}),
        ...(normalized.title ? { title: normalized.title } : {}),
        ...(normalized.command ? { command: normalized.command } : {}),
        ...(normalized.allowedDecisions ? { allowedDecisions: normalized.allowedDecisions } : {}),
        ...(normalized.request ? { request: normalized.request } : {}),
        createdAtMs: normalized.createdAtMs ?? nowMs,
        ...(normalized.expiresAtMs ? { expiresAtMs: normalized.expiresAtMs } : {}),
      },
    };
  }
  if (notification.method === 'exec.approval.resolved' || notification.method === 'plugin.approval.resolved') {
    const normalized = normalizeResolvedPayload(notification.params);
    if (!normalized) {
      return notification;
    }
    return {
      method: notification.method,
      params: {
        id: normalized.id,
        sessionKey: normalized.sessionKey,
        ...(normalized.runId ? { runId: normalized.runId } : {}),
        ...(normalized.decision ? { decision: normalized.decision } : {}),
      },
    };
  }
  return notification;
}

export class OpenClawApprovalAdapter {
  translateNotification(notification: CanonicalApprovalNotification, nowMs: number): CanonicalApprovalEvent[] {
    return buildCanonicalApprovalEventsFromGatewayNotification(normalizeOpenClawApprovalNotification(notification, nowMs), nowMs, {
      protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
      runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
      eventIdPrefix: OPENCLAW_RUNTIME_PROTOCOL_ID,
    });
  }
}
