import type { SessionApprovalDecision, SessionApprovalRequestItem } from '../../../shared/session-adapter-types';
import type { CanonicalApprovalEvent, RuntimeEndpointId, RuntimeProtocolId } from './canonical-events';

export interface CanonicalApprovalNotification {
  method: string;
  params?: unknown;
}

type ApprovalDecision = SessionApprovalDecision;

export interface CanonicalApprovalRuntimeIdentity {
  protocolId: RuntimeProtocolId;
  runtimeEndpointId: RuntimeEndpointId;
  eventIdPrefix: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readAllowedDecisions(value: unknown): ApprovalDecision[] {
  if (!Array.isArray(value)) {
    return ['allow-once', 'allow-always', 'deny'];
  }
  const decisions: ApprovalDecision[] = [];
  for (const item of value) {
    if ((item === 'allow-once' || item === 'allow-always' || item === 'deny') && !decisions.includes(item)) {
      decisions.push(item);
    }
  }
  return decisions.length > 0 ? decisions : ['allow-once', 'allow-always', 'deny'];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = asString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function readCommandArgv(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter((item) => item.length > 0);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function resolveApprovalTitle(input: {
  record: Record<string, unknown>;
  data: Record<string, unknown> | null;
  request: Record<string, unknown> | null;
  command?: string;
}): string {
  return firstString(
    input.record.title,
    input.data?.title,
    input.request?.title,
    input.record.toolName,
    input.data?.toolName,
    input.request?.toolName,
    input.record.host,
    input.data?.host,
    input.request?.host,
    input.command,
  ) ?? 'approval';
}

function asMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 10_000_000_000 ? value * 1000 : value;
}

function readApprovalId(value: unknown): string | undefined {
  const record = asRecord(value);
  const data = asRecord(record?.data);
  const request = asRecord(record?.request) ?? asRecord(data?.request);
  return asString(record?.id)
    ?? asString(record?.approvalId)
    ?? asString(record?.requestId)
    ?? asString(data?.id)
    ?? asString(data?.approvalId)
    ?? asString(data?.requestId)
    ?? asString(request?.id);
}

function readDecision(value: unknown): ApprovalDecision | undefined {
  const decision = asString(value);
  return decision === 'allow-once' || decision === 'allow-always' || decision === 'deny'
    ? decision
    : undefined;
}

function normalizePendingApproval(value: unknown, nowMs: number): SessionApprovalRequestItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const data = asRecord(record.data);
  const request = asRecord(record.request) ?? asRecord(data?.request);
  const id = readApprovalId(record);
  const sessionKey = asString(record.sessionKey)
    ?? asString(data?.sessionKey)
    ?? asString(request?.sessionKey);
  if (!id || !sessionKey) {
    return null;
  }

  const runId = asString(record.runId)
    ?? asString(data?.runId)
    ?? asString(request?.runId);
  const command = firstString(
    record.command,
    data?.command,
    record.commandPreview,
    data?.commandPreview,
    request?.commandPreview,
    request?.command,
  ) ?? readCommandArgv(record.commandArgv)
    ?? readCommandArgv(data?.commandArgv)
    ?? readCommandArgv(request?.commandArgv);
  const createdAtMs = asMs(record.createdAtMs)
    ?? asMs(record.createdAt)
    ?? asMs(record.requestedAt)
    ?? asMs(data?.createdAtMs)
    ?? asMs(data?.createdAt)
    ?? asMs(data?.requestedAt)
    ?? asMs(request?.createdAtMs)
    ?? asMs(request?.createdAt)
    ?? asMs(request?.requestedAt)
    ?? nowMs;
  const expiresAtMs = asMs(record.expiresAtMs)
    ?? asMs(record.expiresAt)
    ?? asMs(data?.expiresAtMs)
    ?? asMs(data?.expiresAt)
    ?? asMs(request?.expiresAtMs)
    ?? asMs(request?.expiresAt);

  return {
    id,
    sessionKey,
    ...(runId ? { runId } : {}),
    title: resolveApprovalTitle({ record, data, request, command }),
    ...(command ? { command } : {}),
    allowedDecisions: readAllowedDecisions(record.allowedDecisions ?? data?.allowedDecisions ?? request?.allowedDecisions),
    ...(request ? { request } : {}),
    createdAtMs,
    ...(expiresAtMs ? { expiresAtMs } : {}),
  };
}

function buildEventBase(input: {
  eventId: string;
  identity: CanonicalApprovalRuntimeIdentity;
  sessionKey: string;
  runId?: string;
  timestamp: number;
  raw?: unknown;
}): Pick<CanonicalApprovalEvent, 'eventId' | 'type' | 'protocolId' | 'runtimeEndpointId' | 'source' | 'sessionId' | 'runId' | 'timestamp' | 'laneKey' | 'origin'> {
  return {
    eventId: input.eventId,
    type: 'approval',
    protocolId: input.identity.protocolId,
    runtimeEndpointId: input.identity.runtimeEndpointId,
    source: 'live',
    sessionId: input.sessionKey,
    ...(input.runId ? { runId: input.runId } : {}),
    timestamp: input.timestamp,
    laneKey: 'main',
    origin: {
      runtimeEventType: 'approval.notification',
      runtimeIds: {
        sessionKey: input.sessionKey,
        ...(input.runId ? { runId: input.runId } : {}),
      },
      ...(input.raw !== undefined ? { raw: structuredClone(input.raw) } : {}),
    },
  };
}

export function buildCanonicalApprovalEventsFromGatewayNotification(
  notification: CanonicalApprovalNotification,
  nowMs: number,
  identity: CanonicalApprovalRuntimeIdentity,
): CanonicalApprovalEvent[] {
  if (notification.method === 'exec.approval.requested' || notification.method === 'plugin.approval.requested') {
    const approval = normalizePendingApproval(notification.params, nowMs);
    if (!approval || (typeof approval.expiresAtMs === 'number' && approval.expiresAtMs <= nowMs)) {
      return [];
    }
    return [{
      ...buildEventBase({
        identity,
        eventId: `${identity.eventIdPrefix}:approval:pending:${approval.sessionKey}:${approval.id}`,
        sessionKey: approval.sessionKey,
        runId: approval.runId,
        timestamp: approval.createdAtMs,
        raw: notification.params,
      }),
      approvalId: approval.id,
      status: 'pending',
      title: approval.title,
      ...(approval.command ? { command: approval.command } : {}),
      allowedDecisions: [...approval.allowedDecisions],
      ...(approval.request ? { request: structuredClone(approval.request) } : {}),
      createdAtMs: approval.createdAtMs,
      ...(approval.expiresAtMs ? { expiresAtMs: approval.expiresAtMs } : {}),
    }];
  }

  if (notification.method === 'exec.approval.resolved' || notification.method === 'plugin.approval.resolved') {
    const approvalId = readApprovalId(notification.params);
    const record = asRecord(notification.params);
    const data = asRecord(record?.data);
    const request = asRecord(record?.request) ?? asRecord(data?.request);
    const sessionKey = asString(record?.sessionKey)
      ?? asString(data?.sessionKey)
      ?? asString(request?.sessionKey);
    if (!approvalId || !sessionKey) {
      return [];
    }
    const runId = asString(record?.runId)
      ?? asString(data?.runId)
      ?? asString(request?.runId);
    const decision = readDecision(record?.decision ?? data?.decision ?? request?.decision);
    return [{
      ...buildEventBase({
        identity,
        eventId: `${identity.eventIdPrefix}:approval:resolved:${sessionKey}:${approvalId}`,
        sessionKey,
        runId,
        timestamp: nowMs,
        raw: notification.params,
      }),
      approvalId,
      status: 'resolved',
      ...(decision ? { decision } : {}),
      title: 'approval',
      allowedDecisions: ['allow-once', 'allow-always', 'deny'],
      createdAtMs: nowMs,
    }];
  }

  return [];
}
