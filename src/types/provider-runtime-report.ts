import { validateRuntimeEndpointRef, type NativeRuntimeEndpointRef } from './desktop/runtime-address';

export const PROVIDER_CALL_DIAGNOSTIC_REASONS = [
  'invalid-provider-key', 'config-snapshot-unavailable', 'invalid-config-document',
  'projection-serialize-failed', 'config-document-invalid', 'request-build-failed',
  'config-readback-unavailable', 'config-readback-mismatch', 'gateway-write-rejected',
  'gateway-write-unknown', 'provider-account-configuration-invalid',
  'provider-credential-unavailable', 'provider-key-duplicate',
  'provider-model-capability-invalid', 'provider-model-identifier-invalid',
  'provider-model-token-limit-invalid', 'provider-model-persistence-failed',
  'provider-routing-account-unavailable', 'provider-routing-credential-unavailable',
  'provider-routing-invalid', 'provider-routing-model-capability-unavailable',
  'provider-routing-model-unavailable', 'provider-routing-persistence-failed',
  'private-profile-deadline', 'private-profile-credential-missing',
  'private-profile-invalid-provider-key', 'private-resolver-unavailable',
  'private-transaction-settle-failed', 'provider-projection-partial',
  'provider-auth-unsupported', 'provider-restart-required', 'provider-cleanup-partial',
  'provider-projection-not-sent', 'provider-projection-outcome-unknown',
  'provider-cleanup-blocked', 'provider-projection-rejected', 'unknown',
] as const;
export type ProviderCallDiagnosticReason = typeof PROVIDER_CALL_DIAGNOSTIC_REASONS[number];

export const PROVIDER_CALL_PRIVATE_RESOLVER_CODES = [
  'invalid-request', 'credential-missing', 'credential-decrypt-failed',
  'credential-provider-mismatch', 'credential-invalid', 'auth-profile-read-invalid',
  'auth-profile-write-failed', 'credential-store-unavailable', 'unknown',
] as const;
export type ProviderCallPrivateResolverCode = typeof PROVIDER_CALL_PRIVATE_RESOLVER_CODES[number];

export interface ProviderDiagnostic {
  reason: ProviderCallDiagnosticReason | null;
  privateResolverCode: ProviderCallPrivateResolverCode | null;
}

// Readiness describes observed local configuration and credentials, not provider network health.
export type ProviderExecutionStatus = 'ready' | 'blocked' | 'unknown' | 'unsupported';

export interface ProviderRuntimeAccountReport {
  accountId: string;
  accountRevision: number;
  execution: ProviderExecutionStatus;
  diagnostic: ProviderDiagnostic | null;
}

export interface ProviderRuntimeReport {
  endpoint: NativeRuntimeEndpointRef & {
    readonly runtimeAdapterId: 'openclaw' | 'matcha-agent';
    readonly runtimeInstanceId: 'local';
  };
  changed: boolean;
  applied: 'confirmed' | 'unknown';
  observed: 'matches' | 'mismatch' | 'unavailable';
  diagnostic: ProviderDiagnostic | null;
  accounts: ProviderRuntimeAccountReport[];
}

function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isProviderDiagnostic(value: unknown): value is ProviderDiagnostic | null {
  return value === null || hasKeys(value, ['reason', 'privateResolverCode'])
    && (value.reason === null || PROVIDER_CALL_DIAGNOSTIC_REASONS.includes(value.reason as ProviderCallDiagnosticReason))
    && (value.privateResolverCode === null || PROVIDER_CALL_PRIVATE_RESOLVER_CODES.includes(value.privateResolverCode as ProviderCallPrivateResolverCode));
}

export function decodeProviderRuntimeReports(value: unknown): ProviderRuntimeReport[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const endpoints = new Set<string>();
  for (const report of value) {
    if (!hasKeys(report, ['endpoint', 'changed', 'applied', 'observed', 'diagnostic', 'accounts'])
      || validateRuntimeEndpointRef(report.endpoint) !== null
      || (report.endpoint as NativeRuntimeEndpointRef).kind !== 'native-runtime'
      || typeof report.changed !== 'boolean'
      || !['confirmed', 'unknown'].includes(report.applied as string)
      || !['matches', 'mismatch', 'unavailable'].includes(report.observed as string)
      || !isProviderDiagnostic(report.diagnostic)
      || !Array.isArray(report.accounts)) return undefined;
    const endpoint = report.endpoint as NativeRuntimeEndpointRef;
    if ((endpoint.runtimeAdapterId !== 'openclaw' && endpoint.runtimeAdapterId !== 'matcha-agent')
      || endpoint.runtimeInstanceId !== 'local') return undefined;
    const endpointKey = JSON.stringify([endpoint.runtimeAdapterId, endpoint.runtimeInstanceId]);
    if (endpoints.has(endpointKey)) return undefined;
    endpoints.add(endpointKey);
    const accountIds = new Set<string>();
    for (const account of report.accounts) {
      if (!hasKeys(account, ['accountId', 'accountRevision', 'execution', 'diagnostic'])
        || typeof account.accountId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(account.accountId)
        || !Number.isSafeInteger(account.accountRevision) || (account.accountRevision as number) <= 0
        || !['ready', 'blocked', 'unknown', 'unsupported'].includes(account.execution as string)
        || !isProviderDiagnostic(account.diagnostic)
        || accountIds.has(account.accountId)) return undefined;
      accountIds.add(account.accountId);
    }
  }
  return value as ProviderRuntimeReport[];
}
