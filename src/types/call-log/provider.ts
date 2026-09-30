import type { CallDetailByModule } from '../call-log';

export type ProviderCallKind =
  | 'listAccounts' | 'getAccount' | 'replaceAccount' | 'deleteAccount'
  | 'listModels' | 'selectableModels' | 'discoverModels' | 'replaceModels'
  | 'listRouting' | 'replaceRouting' | 'textGenerationModelLimits' | 'generateText'
  | 'selectSessionModel' | 'selectMatchaSessionModelRuntime'
  | 'acceptSessionRuntimeModels' | 'selectSessionModelRebound';

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
  'private-transaction-settle-failed', 'unknown',
] as const;
export type ProviderCallDiagnosticReason = typeof PROVIDER_CALL_DIAGNOSTIC_REASONS[number];

export const PROVIDER_CALL_PRIVATE_RESOLVER_CODES = [
  'invalid-request', 'credential-missing', 'credential-decrypt-failed',
  'credential-provider-mismatch', 'credential-invalid', 'auth-profile-read-invalid',
  'auth-profile-write-failed', 'credential-store-unavailable', 'unknown',
] as const;
export type ProviderCallPrivateResolverCode = typeof PROVIDER_CALL_PRIVATE_RESOLVER_CODES[number];

export interface ProviderCallDetail {
  kind: ProviderCallKind;
  phase: 'received' | 'running' | 'native' | 'terminal';
  outcome: 'available' | 'stored' | 'deleted' | 'unknown' | 'rejected' | 'missing'
    | 'unavailable' | 'discovered' | 'selected' | 'unsupported' | 'accepted'
    | 'generated' | 'cancelled' | null;
  count: number | null;
  acceptedCount: number | null;
  persisted: 'confirmed' | 'unknown' | null;
  commit: 'committed' | 'unknown' | null;
  accountId: string | null;
  accountRevision: number | null;
  diagnostic: {
    reason: ProviderCallDiagnosticReason | null;
    privateResolverCode: ProviderCallPrivateResolverCode | null;
  } | null;
  native: {
    changed: boolean;
    applied: 'confirmed' | 'unknown';
    observed: 'matches' | 'mismatch' | 'unavailable';
  } | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    provider: ProviderCallDetail;
  }
}

const KINDS: readonly string[] = [
  'listAccounts', 'getAccount', 'replaceAccount', 'deleteAccount', 'listModels',
  'selectableModels', 'discoverModels', 'replaceModels', 'listRouting', 'replaceRouting',
  'textGenerationModelLimits', 'generateText', 'selectSessionModel',
  'selectMatchaSessionModelRuntime', 'acceptSessionRuntimeModels', 'selectSessionModelRebound',
];
const OUTCOMES: readonly unknown[] = [
  null, 'available', 'stored', 'deleted', 'unknown', 'rejected', 'missing', 'unavailable',
  'discovered', 'selected', 'unsupported', 'accepted', 'generated', 'cancelled',
];

function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function decodeProviderCallDetail(value: unknown): CallDetailByModule['provider'] | undefined {
  if (!hasKeys(value, ['kind', 'phase', 'outcome', 'count', 'acceptedCount', 'persisted', 'commit', 'native', 'accountId', 'accountRevision', 'diagnostic'])
    || typeof value.kind !== 'string' || !KINDS.includes(value.kind)
    || !['received', 'running', 'native', 'terminal'].includes(value.phase as string)
    || !OUTCOMES.includes(value.outcome)
    || !(value.count === null || (Number.isSafeInteger(value.count) && (value.count as number) >= 0))
    || !(value.acceptedCount === null || (Number.isSafeInteger(value.acceptedCount) && (value.acceptedCount as number) >= 0
      && typeof value.count === 'number' && (value.acceptedCount as number) <= value.count))
    || ![null, 'confirmed', 'unknown'].includes(value.persisted as string | null)
    || ![null, 'committed', 'unknown'].includes(value.commit as string | null)
    || !(value.accountId === null || typeof value.accountId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value.accountId))
    || !(value.accountRevision === null || Number.isSafeInteger(value.accountRevision) && (value.accountRevision as number) > 0)) return undefined;
  if (value.diagnostic !== null
    && (!hasKeys(value.diagnostic, ['reason', 'privateResolverCode'])
      || !(value.diagnostic.reason === null || PROVIDER_CALL_DIAGNOSTIC_REASONS.includes(value.diagnostic.reason as ProviderCallDiagnosticReason))
      || !(value.diagnostic.privateResolverCode === null || PROVIDER_CALL_PRIVATE_RESOLVER_CODES.includes(value.diagnostic.privateResolverCode as ProviderCallPrivateResolverCode)))) return undefined;
  if (value.native !== null
    && (!hasKeys(value.native, ['changed', 'applied', 'observed'])
      || typeof value.native.changed !== 'boolean'
      || !['confirmed', 'unknown'].includes(value.native.applied as string)
      || !['matches', 'mismatch', 'unavailable'].includes(value.native.observed as string))) return undefined;
  return value as unknown as ProviderCallDetail;
}
