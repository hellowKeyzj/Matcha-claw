import { decodeRuntimeRepairSnapshot, type RuntimeRepairSnapshot } from '../runtime-repair';

export type RuntimeControlCallResult =
  | 'succeeded' | 'unsupported' | 'unavailable' | 'failed' | 'unknown';

export interface RuntimeDirectoryCallDetail {
  count: number | null;
  result: RuntimeControlCallResult | null;
}

export type RuntimeControlLifecycleFailure =
  | 'artifactUnavailable' | 'permissionDenied' | 'resourceUnavailable' | 'platformRejected'
  | 'stdio' | 'readiness' | 'unexpectedExit' | 'authorityLost'
  | 'cleanupUnconfirmed' | 'materialCleanupFailed';

export type RuntimeControlStartupDiagnostic =
  | 'portConflict' | 'configurationRejected' | 'appServerReportedError' | 'unclassifiedStderr'
  | 'invalidUtf8' | 'lineTooLong' | 'listenerReported' | 'bindRejected'
  | 'startupFailed' | 'invalidEncoding' | 'diagnosticLimitReached';

export interface RuntimeControlCallDetail {
  endpoint: {
    kind: 'native-runtime';
    runtimeAdapterId: 'openclaw' | 'matcha-agent';
    runtimeInstanceId: 'local';
  } | null;
  lifecycle:
    | 'unavailable' | 'idle' | 'starting' | 'running' | 'stopping'
    | 'waitingToRestart' | 'failed' | 'shutDown' | null;
  result: RuntimeControlCallResult | null;
  count: number | null;
  ready: boolean | null;
  healthy: boolean | null;
  failure: RuntimeControlLifecycleFailure | null;
  startupDiagnostic: RuntimeControlStartupDiagnostic | null;
  error: 'unsupported' | 'unavailable' | 'commandFailed' | 'busy' | null;
  repair?: RuntimeRepairSnapshot | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    'runtime-directory': RuntimeDirectoryCallDetail;
    'runtime-control': RuntimeControlCallDetail;
  }
}

const results = ['succeeded', 'unsupported', 'unavailable', 'failed', 'unknown'];
const lifecycles = [
  'unavailable', 'idle', 'starting', 'running', 'stopping', 'waitingToRestart', 'failed', 'shutDown',
];
const failures: readonly RuntimeControlLifecycleFailure[] = [
  'artifactUnavailable', 'permissionDenied', 'resourceUnavailable', 'platformRejected',
  'stdio', 'readiness', 'unexpectedExit', 'authorityLost', 'cleanupUnconfirmed', 'materialCleanupFailed',
];
const startupDiagnostics: readonly RuntimeControlStartupDiagnostic[] = [
  'portConflict', 'configurationRejected', 'appServerReportedError', 'unclassifiedStderr',
  'invalidUtf8', 'lineTooLong', 'listenerReported', 'bindRejected', 'startupFailed',
  'invalidEncoding', 'diagnosticLimitReached',
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function count(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
}

function result(value: unknown): boolean {
  return value === null || (typeof value === 'string' && results.includes(value));
}

export function decodeRuntimeDirectoryCallDetail(value: unknown): RuntimeDirectoryCallDetail | undefined {
  if (!record(value) || !exact(value, ['count', 'result']) || !count(value.count) || !result(value.result)) {
    return undefined;
  }
  return { count: value.count as number | null, result: value.result as RuntimeControlCallResult | null };
}

export function decodeRuntimeControlCallDetail(value: unknown): RuntimeControlCallDetail | undefined {
  if (!record(value) || !exact(value, ['endpoint', 'lifecycle', 'result', 'count', 'ready', 'healthy', 'failure', 'startupDiagnostic', 'error', ...(Object.hasOwn(value, 'repair') ? ['repair'] : [])])
    || !(value.endpoint === null || (record(value.endpoint)
      && exact(value.endpoint, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
      && value.endpoint.kind === 'native-runtime' && value.endpoint.runtimeInstanceId === 'local'
      && (value.endpoint.runtimeAdapterId === 'openclaw' || value.endpoint.runtimeAdapterId === 'matcha-agent')))
    || !(value.lifecycle === null || (typeof value.lifecycle === 'string' && lifecycles.includes(value.lifecycle)))
    || !result(value.result) || !count(value.count)
    || !(value.ready === null || typeof value.ready === 'boolean')
    || !(value.healthy === null || typeof value.healthy === 'boolean')
    || !(value.failure === null || failures.includes(value.failure as RuntimeControlLifecycleFailure))
    || !(value.startupDiagnostic === null || startupDiagnostics.includes(value.startupDiagnostic as RuntimeControlStartupDiagnostic))
    || !(Object.hasOwn(value, 'repair') === false || value.repair === null || decodeRuntimeRepairSnapshot(value.repair))
    || !(value.error === null || value.error === 'unsupported' || value.error === 'unavailable' || value.error === 'commandFailed' || value.error === 'busy')) {
    return undefined;
  }
  return {
    endpoint: value.endpoint as RuntimeControlCallDetail['endpoint'],
    lifecycle: value.lifecycle as RuntimeControlCallDetail['lifecycle'],
    result: value.result as RuntimeControlCallResult | null,
    count: value.count as number | null,
    ready: value.ready as boolean | null,
    healthy: value.healthy as boolean | null,
    failure: value.failure as RuntimeControlLifecycleFailure | null,
    startupDiagnostic: value.startupDiagnostic as RuntimeControlStartupDiagnostic | null,
    error: value.error as RuntimeControlCallDetail['error'],
    ...(Object.hasOwn(value, 'repair') ? { repair: value.repair === null ? null : decodeRuntimeRepairSnapshot(value.repair)! } : {}),
  };
}
