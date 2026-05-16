import type { RuntimeClockPort } from '../common/runtime-ports';

export interface PendingApprovalNotification {
  method: string;
  params?: unknown;
}

export interface PendingApprovalItem {
  readonly id: string;
  readonly sessionKey: string;
  readonly runId?: string;
  readonly title: string;
  readonly command?: string;
  readonly allowedDecisions: ApprovalDecision[];
  readonly request?: Record<string, unknown>;
  readonly createdAtMs: number;
  readonly expiresAtMs?: number;
}

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export interface PendingApprovalStoreDeps {
  readonly clock: Pick<RuntimeClockPort, 'nowMs'>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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
    if (item === 'allow-once' || item === 'allow-always' || item === 'deny') {
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

function resolveApprovalTitle(params: {
  record: Record<string, unknown>;
  data: Record<string, unknown> | null;
  request: Record<string, unknown> | null;
  command?: string;
}): string {
  const { record, data, request, command } = params;
  return firstString(
    record.title,
    data?.title,
    request?.title,
    record.toolName,
    data?.toolName,
    request?.toolName,
    record.host,
    data?.host,
    request?.host,
    command,
  ) ?? 'approval';
}

function asMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 10_000_000_000 ? value * 1000 : value;
}

function normalizePendingApproval(value: unknown, nowMs: number): PendingApprovalItem | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const data = asRecord(record.data);
  const request = asRecord(record.request) ?? asRecord(data?.request);
  const id = asString(record.id)
    ?? asString(record.approvalId)
    ?? asString(record.requestId)
    ?? asString(data?.id)
    ?? asString(data?.approvalId)
    ?? asString(data?.requestId)
    ?? asString(request?.id);
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
  const allowedDecisions = readAllowedDecisions(record.allowedDecisions ?? data?.allowedDecisions ?? request?.allowedDecisions);
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
    ?? asMs(request?.expiresAtMs)
    ?? asMs(request?.expiresAt);

  return {
    id,
    sessionKey,
    ...(runId ? { runId } : {}),
    title: resolveApprovalTitle({ record, data, request, command }),
    ...(command ? { command } : {}),
    allowedDecisions,
    ...(request ? { request } : {}),
    createdAtMs,
    ...(expiresAtMs ? { expiresAtMs } : {}),
  };
}

export class PendingApprovalStore {
  private readonly pendingById = new Map<string, PendingApprovalItem>();

  constructor(private readonly deps: PendingApprovalStoreDeps) {}

  consumeGatewayNotification(notification: PendingApprovalNotification): void {
    if (notification.method === 'exec.approval.requested' || notification.method === 'plugin.approval.requested') {
      this.recordRequested(notification.params);
      return;
    }
    if (notification.method === 'exec.approval.resolved' || notification.method === 'plugin.approval.resolved') {
      this.recordResolved(notification.params);
    }
  }

  list(): PendingApprovalItem[] {
    this.pruneExpired();
    return [...this.pendingById.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  private recordRequested(payload: unknown): void {
    this.pruneExpired();
    const item = normalizePendingApproval(payload, this.deps.clock.nowMs());
    if (!item || this.isExpired(item)) {
      return;
    }
    this.pendingById.set(item.id, item);
  }

  private recordResolved(payload: unknown): void {
    const record = asRecord(payload);
    const data = asRecord(record?.data);
    const request = asRecord(record?.request) ?? asRecord(data?.request);
    const id = asString(record?.id)
      ?? asString(record?.approvalId)
      ?? asString(record?.requestId)
      ?? asString(data?.id)
      ?? asString(data?.approvalId)
      ?? asString(data?.requestId)
      ?? asString(request?.id);
    if (!id) {
      return;
    }
    this.pendingById.delete(id);
  }

  private pruneExpired(): void {
    for (const [id, item] of this.pendingById.entries()) {
      if (this.isExpired(item)) {
        this.pendingById.delete(id);
      }
    }
  }

  private isExpired(item: PendingApprovalItem): boolean {
    return typeof item.expiresAtMs === 'number' && item.expiresAtMs <= this.deps.clock.nowMs();
  }
}
