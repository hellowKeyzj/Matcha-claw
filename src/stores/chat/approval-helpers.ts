import type { ApprovalDecision, ApprovalItem } from './types';
import { toMs } from './store-state-helpers';
import { asRecord } from './value';

export function normalizeApprovalDecision(value: unknown): ApprovalDecision | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  if (normalized === 'allow-once') return 'allow-once';
  if (normalized === 'allow-always') return 'allow-always';
  if (normalized === 'deny') return 'deny';
  return undefined;
}

export function normalizeApprovalTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return toMs(value);
}

export function resolveApprovalSessionKey(payload: Record<string, unknown>): string | undefined {
  const directSessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
  if (directSessionKey) return directSessionKey;

  const data = (payload.data && typeof payload.data === 'object')
    ? payload.data as Record<string, unknown>
    : undefined;
  const dataSessionKey = typeof data?.sessionKey === 'string' ? data.sessionKey.trim() : '';
  if (dataSessionKey) return dataSessionKey;

  const request = (payload.request && typeof payload.request === 'object')
    ? payload.request as Record<string, unknown>
    : (data?.request && typeof data.request === 'object')
      ? data.request as Record<string, unknown>
    : undefined;
  const nestedSessionKey = typeof request?.sessionKey === 'string' ? request.sessionKey.trim() : '';
  if (nestedSessionKey) return nestedSessionKey;

  return undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readAllowedDecisions(value: unknown): ApprovalDecision[] {
  if (!Array.isArray(value)) return ['allow-once', 'allow-always', 'deny'];
  const decisions: ApprovalDecision[] = [];
  for (const item of value) {
    const decision = normalizeApprovalDecision(item);
    if (decision && !decisions.includes(decision)) {
      decisions.push(decision);
    }
  }
  return decisions.length > 0 ? decisions : ['allow-once', 'allow-always', 'deny'];
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = asNonEmptyString(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function readCommandArgv(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((item) => asNonEmptyString(item))
    .filter((item): item is string => Boolean(item));
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function resolveApprovalTitle(
  record: Record<string, unknown>,
  data: Record<string, unknown> | null,
  request: Record<string, unknown> | null,
  command?: string,
): string {
  return firstNonEmptyString(
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

function normalizeApprovalItemFromGateway(value: unknown): ApprovalItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const data = asRecord(record.data);
  const request = asRecord(record.request) ?? asRecord(data?.request);
  const id = asNonEmptyString(record.id)
    ?? asNonEmptyString(record.approvalId)
    ?? asNonEmptyString(record.requestId)
    ?? asNonEmptyString(data?.id)
    ?? asNonEmptyString(data?.approvalId)
    ?? asNonEmptyString(data?.requestId)
    ?? asNonEmptyString(request?.id);
  const sessionKey = asNonEmptyString(record.sessionKey)
    ?? asNonEmptyString(data?.sessionKey)
    ?? asNonEmptyString(request?.sessionKey);
  if (!id || !sessionKey) return null;

  const runId = asNonEmptyString(record.runId)
    ?? asNonEmptyString(data?.runId)
    ?? asNonEmptyString(request?.runId);
  const command = firstNonEmptyString(
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
  const createdAtMs = normalizeApprovalTimestampMs(record.createdAt)
    ?? normalizeApprovalTimestampMs(record.createdAtMs)
    ?? normalizeApprovalTimestampMs(record.requestedAt)
    ?? normalizeApprovalTimestampMs(data?.createdAt)
    ?? normalizeApprovalTimestampMs(data?.createdAtMs)
    ?? normalizeApprovalTimestampMs(data?.requestedAt)
    ?? normalizeApprovalTimestampMs(request?.createdAt)
    ?? normalizeApprovalTimestampMs(request?.requestedAt)
    ?? Date.now();
  const expiresAtMs = normalizeApprovalTimestampMs(record.expiresAt)
    ?? normalizeApprovalTimestampMs(record.expiresAtMs)
    ?? normalizeApprovalTimestampMs(data?.expiresAt)
    ?? normalizeApprovalTimestampMs(data?.expiresAtMs)
    ?? normalizeApprovalTimestampMs(request?.expiresAt);

  return {
    id,
    sessionKey,
    ...(runId ? { runId } : {}),
    title: resolveApprovalTitle(record, data, request, command),
    ...(command ? { command } : {}),
    allowedDecisions,
    ...(request ? { request } : {}),
    createdAtMs,
    ...(expiresAtMs ? { expiresAtMs } : {}),
  };
}

export function parseGatewayApprovalResponse(
  payload: unknown,
): { recognized: boolean; items: ApprovalItem[] } {
  const rawRecords: unknown[] = [];
  let recognized = false;

  const collect = (candidate: unknown, forceObjectMap = false): void => {
    if (Array.isArray(candidate)) {
      recognized = true;
      rawRecords.push(...candidate);
      return;
    }
    const objectCandidate = asRecord(candidate);
    if (!objectCandidate) return;
    if (normalizeApprovalItemFromGateway(objectCandidate)) {
      recognized = true;
      rawRecords.push(objectCandidate);
      return;
    }
    if (!forceObjectMap) return;
    rawRecords.push(...Object.values(objectCandidate));
    recognized = true;
  };

  if (Array.isArray(payload)) {
    collect(payload);
  } else {
    const root = asRecord(payload);
    if (root) {
      const listKeys = ['approvals', 'items', 'pending', 'list', 'records', 'requests'];
      for (const key of listKeys) {
        if (Object.prototype.hasOwnProperty.call(root, key)) {
          collect(root[key], true);
        }
      }
      const containerKeys = ['data', 'result', 'payload'];
      for (const key of containerKeys) {
        const nested = asRecord(root[key]);
        if (!nested) continue;
        for (const listKey of listKeys) {
          if (Object.prototype.hasOwnProperty.call(nested, listKey)) {
            collect(nested[listKey], true);
          }
        }
      }
      if (!recognized) {
        collect(root);
      }
    }
  }

  if (!recognized) {
    return { recognized: false, items: [] };
  }

  const dedup = new Map<string, ApprovalItem>();
  for (const entry of rawRecords) {
    const normalized = normalizeApprovalItemFromGateway(entry);
    if (!normalized) continue;
    dedup.set(`${normalized.sessionKey}::${normalized.id}`, normalized);
  }

  return {
    recognized: true,
    items: [...dedup.values()].sort((a, b) => a.createdAtMs - b.createdAtMs),
  };
}
