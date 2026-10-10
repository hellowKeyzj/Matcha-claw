export type RuntimeRepairPhase = 'idle' | 'stopping' | 'repairing' | 'preparing' | 'starting' | 'succeeded' | 'failed';
export type RuntimeRepairTrigger = 'automatic' | 'manual';
export type RuntimeRepairFailure = 'stopFailed' | 'doctorFailed' | 'doctorTimedOut' | 'doctorCancelled' | 'doctorSpawnFailed' | 'preparationFailed' | 'startFailed';

export interface RuntimeRepairSnapshot {
  phase: RuntimeRepairPhase;
  trigger: RuntimeRepairTrigger | null;
  failure: RuntimeRepairFailure | null;
}

export function decodeRuntimeRepairSnapshot(value: unknown): RuntimeRepairSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || !['phase', 'trigger', 'failure'].every((key) => Object.hasOwn(record, key))
    || !['idle', 'stopping', 'repairing', 'preparing', 'starting', 'succeeded', 'failed'].includes(record.phase as string)
    || (record.trigger !== null && record.trigger !== 'automatic' && record.trigger !== 'manual')
    || (record.failure !== null && !['stopFailed', 'doctorFailed', 'doctorTimedOut', 'doctorCancelled', 'doctorSpawnFailed', 'preparationFailed', 'startFailed'].includes(record.failure as string))) {
    return null;
  }
  return {
    phase: record.phase as RuntimeRepairPhase,
    trigger: record.trigger as RuntimeRepairTrigger | null,
    failure: record.failure as RuntimeRepairFailure | null,
  };
}
