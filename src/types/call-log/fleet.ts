import type { CallDetailByModule } from '../call-log';

export interface FleetCallDetail {
  targetId: string | null;
  entityId: string | null;
  commandId: string | null;
  dispatchId: string | null;
  attempt: number | null;
  outcome: 'completed' | 'rejected' | 'admissionClosed' | 'remoteAccepted' | 'outcomeUnknown' | 'ready' | 'unhealthy' | 'unavailable' | 'failed' | 'cancelled' | 'timedOut' | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    fleet: FleetCallDetail;
  }
}

export type FleetCallSummary = CallDetailByModule['fleet'];

export function decodeFleetCallDetail(value: unknown): FleetCallDetail | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  const keys = ['targetId', 'entityId', 'commandId', 'dispatchId', 'attempt', 'outcome'];
  if (Object.keys(detail).length !== keys.length || !keys.every((key) => Object.hasOwn(detail, key))) return null;
  for (const key of ['targetId', 'entityId', 'commandId', 'dispatchId']) {
    const ref = detail[key];
    if (ref !== null && (typeof ref !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(ref))) return null;
  }
  if (detail.attempt !== null && (typeof detail.attempt !== 'number' || !Number.isSafeInteger(detail.attempt) || detail.attempt < 1)) return null;
  if (detail.outcome !== null && (typeof detail.outcome !== 'string' || !['completed', 'rejected', 'admissionClosed', 'remoteAccepted', 'outcomeUnknown', 'ready', 'unhealthy', 'unavailable', 'failed', 'cancelled', 'timedOut'].includes(detail.outcome))) return null;
  return { targetId: detail.targetId as string | null, entityId: detail.entityId as string | null,
    commandId: detail.commandId as string | null, dispatchId: detail.dispatchId as string | null,
    attempt: detail.attempt as number | null, outcome: detail.outcome as FleetCallDetail['outcome'] };
}
