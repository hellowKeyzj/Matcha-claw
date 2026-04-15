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

  const request = (payload.request && typeof payload.request === 'object')
    ? payload.request as Record<string, unknown>
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

function normalizeApprovalItemFromGateway(value: unknown): ApprovalItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const request = asRecord(record.request);
  const id = asNonEmptyString(record.id)
    ?? asNonEmptyString(record.approvalId)
    ?? asNonEmptyString(record.requestId)
    ?? asNonEmptyString(request?.id);
  const sessionKey = asNonEmptyString(record.sessionKey)
    ?? asNonEmptyString(request?.sessionKey);
  if (!id || !sessionKey) return null;

  const runId = asNonEmptyString(record.runId)
    ?? asNonEmptyString(request?.runId);
  const toolName = asNonEmptyString(record.toolName)
    ?? asNonEmptyString(request?.toolName);
  const createdAtMs = normalizeApprovalTimestampMs(record.createdAt)
    ?? normalizeApprovalTimestampMs(record.createdAtMs)
    ?? normalizeApprovalTimestampMs(record.requestedAt)
    ?? normalizeApprovalTimestampMs(request?.createdAt)
    ?? normalizeApprovalTimestampMs(request?.requestedAt)
    ?? Date.now();
  const expiresAtMs = normalizeApprovalTimestampMs(record.expiresAt)
    ?? normalizeApprovalTimestampMs(record.expiresAtMs)
    ?? normalizeApprovalTimestampMs(request?.expiresAt);

  return {
    id,
    sessionKey,
    ...(runId ? { runId } : {}),
    ...(toolName ? { toolName } : {}),
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
