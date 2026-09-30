import type { CallDetailByModule } from '../call-log';

export type ToolchainCallFailure = 'admissionClosed' | 'ownerUnavailable' | 'queueFull' | 'recordingUnavailable';
export type ToolchainCallAvailability = 'available' | 'unavailable' | 'unknown' | 'unsupported';
export type ToolchainCallReadiness = 'ready' | 'notReady' | 'unknown' | 'unavailable' | 'unsupported';
export type ToolchainCallPrepareOutcome = 'ready' | 'installed' | 'rejected' | 'unknown' | 'unavailable' | 'unsupported';

export type ToolchainCallDetail =
  | {
      kind: 'status';
      uv: ToolchainCallAvailability | null;
      python: ToolchainCallReadiness | null;
      failure: ToolchainCallFailure | null;
    }
  | {
      kind: 'prepare';
      pythonVersion: '3.12';
      outcome: ToolchainCallPrepareOutcome | null;
      failure: ToolchainCallFailure | null;
    };

declare module '../call-log' {
  interface CallDetailByModule {
    toolchain: ToolchainCallDetail;
  }
}

export type ToolchainCallSummary = CallDetailByModule['toolchain'];

export function decodeToolchainCallDetail(value: unknown): ToolchainCallDetail | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  if (detail.failure !== null && detail.failure !== 'admissionClosed'
    && detail.failure !== 'ownerUnavailable' && detail.failure !== 'queueFull'
    && detail.failure !== 'recordingUnavailable') return null;
  const failure = detail.failure;
  if (detail.kind === 'status') {
    if (!hasKeys(detail, ['kind', 'uv', 'python', 'failure'])
      || (detail.uv !== null && detail.uv !== 'available' && detail.uv !== 'unavailable'
        && detail.uv !== 'unknown' && detail.uv !== 'unsupported')
      || (detail.python !== null && detail.python !== 'ready' && detail.python !== 'notReady'
        && detail.python !== 'unknown' && detail.python !== 'unavailable' && detail.python !== 'unsupported')
      || (detail.uv === null) !== (detail.python === null)
      || (failure !== null && detail.uv !== null)) return null;
    return { kind: 'status', uv: detail.uv, python: detail.python, failure };
  }
  if (detail.kind === 'prepare') {
    if (!hasKeys(detail, ['kind', 'pythonVersion', 'outcome', 'failure'])
      || detail.pythonVersion !== '3.12'
      || (detail.outcome !== null && detail.outcome !== 'ready' && detail.outcome !== 'installed'
        && detail.outcome !== 'rejected' && detail.outcome !== 'unknown'
        && detail.outcome !== 'unavailable' && detail.outcome !== 'unsupported')
      || (failure !== null && detail.outcome !== null)) return null;
    return { kind: 'prepare', pythonVersion: '3.12', outcome: detail.outcome, failure };
  }
  return null;
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
