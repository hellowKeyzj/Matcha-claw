export type ProviderMutationDesiredStatus = 'stored' | 'deleted';
export type ProviderMutationPersistedStatus = 'confirmed' | 'unknown';
export type ProviderMutationAppliedStatus = 'confirmed' | 'unknown';
export type ProviderMutationObservedStatus = 'matches' | 'mismatch' | 'unavailable';
export type ProviderMutationCommit = 'committed' | 'commit-outcome-unknown';

export type ProviderMutationNativeDiagnostic = Readonly<{
  phase: string;
  reason: string;
  configPath: string;
  method?: string;
  expectedPath?: string;
  detail?: string;
}>;

export type ProviderMutationReceipt = Readonly<{
  desired: Readonly<{
    status: ProviderMutationDesiredStatus;
    revision?: number;
  }>;
  persisted: Readonly<{ status: ProviderMutationPersistedStatus }>;
  native: Readonly<{
    changed: boolean;
    applied: Readonly<{ status: ProviderMutationAppliedStatus }>;
    observed: Readonly<{ status: ProviderMutationObservedStatus }>;
    diagnostic?: ProviderMutationNativeDiagnostic;
  }>;
  commit: ProviderMutationCommit;
}>;

export type ProviderMutationCommittedResponse = Readonly<{
  success: true;
  desired: ProviderMutationReceipt['desired'];
  persisted: Readonly<{ status: 'confirmed' }>;
  native: ProviderMutationReceipt['native'];
  commit: 'committed';
}>;

export type ProviderMutationAccount = Readonly<{
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  kind?: 'chat' | 'media';
  endpoint?: string;
  protocol?: 'anthropicMessages' | 'googleGenerativeAi' | 'openAiCompletions' | 'openAiResponses';
  mediaProtocol?: 'google' | 'openAi' | 'openRouter';
  authMode: 'apiKey' | 'oauthBrowser' | 'oauthDevice' | 'local';
  revision: number;
}>;

export type ProviderMutationCommittedAccountResponse = Readonly<ProviderMutationCommittedResponse & {
  account: ProviderMutationAccount;
}>;

export type ProviderMutationCommitUnknownResponse = Readonly<{
  success: false;
  code: 'commit-outcome-unknown';
  error: string;
  receipt: Readonly<{
    desired: ProviderMutationReceipt['desired'];
    persisted: ProviderMutationReceipt['persisted'];
    native: ProviderMutationReceipt['native'];
    commit: 'commit-outcome-unknown';
  }>;
}>;

export type ProviderMutationReceiptDecodeOptions = Readonly<{
  desiredStatus?: ProviderMutationDesiredStatus;
  desiredRevision: 'required' | 'optional' | 'forbidden';
  unknownError: string;
}>;

export type ProviderMutationAccountDecodeOptions = ProviderMutationReceiptDecodeOptions;

export class ProviderMutationReceiptUnavailableError extends Error {
  constructor() {
    super('Provider mutation receipt is unavailable');
    this.name = 'ProviderMutationReceiptUnavailableError';
  }
}

export function decodeProviderMutationCommittedAccountResponse(
  value: unknown,
  options: ProviderMutationAccountDecodeOptions,
): ProviderMutationCommittedAccountResponse {
  if (!isRecord(value)
    || !hasExactKeys(value, ['success', 'account', 'desired', 'persisted', 'native', 'commit'])
    || value.success !== true
    || !decodeProviderMutationAccount(value.account)) {
    throw new ProviderMutationReceiptUnavailableError();
  }
  const receipt = decodeReceipt({
    desired: value.desired,
    persisted: value.persisted,
    native: value.native,
    commit: value.commit,
  }, options, 'committed');
  if (!receipt || receipt.persisted.status !== 'confirmed') {
    throw new ProviderMutationReceiptUnavailableError();
  }
  return {
    success: true,
    account: decodeProviderMutationAccount(value.account)!,
    desired: receipt.desired,
    persisted: { status: 'confirmed' },
    native: receipt.native,
    commit: 'committed',
  };
}

export function decodeProviderMutationCommittedResponse(
  value: unknown,
  options: ProviderMutationReceiptDecodeOptions,
): ProviderMutationCommittedResponse {
  if (!isRecord(value)
    || !hasExactKeys(value, ['success', 'desired', 'persisted', 'native', 'commit'])
    || value.success !== true) {
    throw new ProviderMutationReceiptUnavailableError();
  }
  const receipt = decodeReceipt({
    desired: value.desired,
    persisted: value.persisted,
    native: value.native,
    commit: value.commit,
  }, options, 'committed');
  if (!receipt || receipt.persisted.status !== 'confirmed') {
    throw new ProviderMutationReceiptUnavailableError();
  }
  return {
    success: true,
    desired: receipt.desired,
    persisted: { status: 'confirmed' },
    native: receipt.native,
    commit: 'committed',
  };
}

export function decodeProviderMutationCommitUnknownResponse(
  value: unknown,
  options: ProviderMutationReceiptDecodeOptions,
): ProviderMutationCommitUnknownResponse | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['success', 'code', 'error', 'receipt'])
    || value.success !== false
    || value.code !== 'commit-outcome-unknown'
    || value.error !== options.unknownError) {
    return null;
  }
  const receipt = isRecord(value.receipt)
    ? decodeReceipt(value.receipt, options, 'commit-outcome-unknown')
    : null;
  if (!receipt || receipt.persisted.status !== 'unknown') return null;
  return {
    success: false,
    code: 'commit-outcome-unknown',
    error: options.unknownError,
    receipt: {
      desired: receipt.desired,
      persisted: { status: 'unknown' },
      native: receipt.native,
      commit: 'commit-outcome-unknown',
    },
  };
}

function decodeReceipt(
  value: Record<string, unknown>,
  options: ProviderMutationReceiptDecodeOptions,
  commit: ProviderMutationCommit,
): ProviderMutationReceipt | null {
  if (!hasExactKeys(value, ['desired', 'persisted', 'native', 'commit'])
    || !isRecord(value.desired)
    || !isRecord(value.persisted)
    || !isRecord(value.native)
    || value.commit !== commit) {
    return null;
  }
  const desired = decodeDesired(value.desired, options);
  const persisted = decodePersisted(value.persisted);
  const native = decodeNative(value.native);
  if (!desired || !persisted || !native) return null;
  return { desired, persisted, native, commit };
}

function decodeDesired(
  value: Record<string, unknown>,
  options: ProviderMutationReceiptDecodeOptions,
): ProviderMutationReceipt['desired'] | null {
  const hasRevision = Object.hasOwn(value, 'revision');
  if ((!hasRevision && options.desiredRevision === 'required')
    || (hasRevision && options.desiredRevision === 'forbidden')
    || !hasOnlyKeys(value, hasRevision ? ['status', 'revision'] : ['status'])
    || (options.desiredStatus !== undefined && value.status !== options.desiredStatus)
    || (value.status !== 'stored' && value.status !== 'deleted')
    || (hasRevision && !isPositiveInteger(value.revision))) {
    return null;
  }
  return hasRevision
    ? { status: value.status as ProviderMutationDesiredStatus, revision: value.revision as number }
    : { status: value.status as ProviderMutationDesiredStatus };
}

function decodeProviderMutationAccount(value: unknown): ProviderMutationAccount | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'id', 'provider', 'label', 'enabled', 'kind', 'endpoint', 'protocol', 'mediaProtocol', 'authMode', 'revision',
    ])
    || !isIdentifier(value.id)
    || !isIdentifier(value.provider)
    || !isBoundedText(value.label, 256)
    || typeof value.enabled !== 'boolean'
    || (value.kind !== undefined && value.kind !== 'chat' && value.kind !== 'media')
    || (value.endpoint !== undefined && !isBoundedText(value.endpoint, 2048))
    || (value.protocol !== undefined && ![
      'anthropicMessages', 'googleGenerativeAi', 'openAiCompletions', 'openAiResponses',
    ].includes(value.protocol as string))
    || (value.mediaProtocol !== undefined && !['google', 'openAi', 'openRouter'].includes(value.mediaProtocol as string))
    || !['apiKey', 'oauthBrowser', 'oauthDevice', 'local'].includes(value.authMode as string)
    || !isPositiveInteger(value.revision)) {
    return null;
  }
  if (value.kind === 'media' && (value.protocol !== undefined || value.mediaProtocol === undefined)) return null;
  if (value.kind !== 'media' && value.mediaProtocol !== undefined) return null;
  return {
    id: value.id,
    provider: value.provider,
    label: value.label,
    enabled: value.enabled,
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.endpoint === undefined ? {} : { endpoint: value.endpoint }),
    ...(value.protocol === undefined ? {} : { protocol: value.protocol }),
    ...(value.mediaProtocol === undefined ? {} : { mediaProtocol: value.mediaProtocol }),
    authMode: value.authMode,
    revision: value.revision,
  } as ProviderMutationAccount;
}

function decodePersisted(
  value: Record<string, unknown>,
): ProviderMutationReceipt['persisted'] | null {
  if (!hasExactKeys(value, ['status'])
    || (value.status !== 'confirmed' && value.status !== 'unknown')) {
    return null;
  }
  return { status: value.status };
}

function decodeNative(
  value: Record<string, unknown>,
): ProviderMutationReceipt['native'] | null {
  if (!hasOnlyKeys(value, ['changed', 'applied', 'observed', 'diagnostic'])
    || !Object.hasOwn(value, 'changed')
    || !Object.hasOwn(value, 'applied')
    || !Object.hasOwn(value, 'observed')
    || typeof value.changed !== 'boolean'
    || !isRecord(value.applied)
    || !hasExactKeys(value.applied, ['status'])
    || (value.applied.status !== 'confirmed' && value.applied.status !== 'unknown')
    || !isRecord(value.observed)
    || !hasExactKeys(value.observed, ['status'])
    || (value.observed.status !== 'matches'
      && value.observed.status !== 'mismatch'
      && value.observed.status !== 'unavailable')) {
    return null;
  }
  return {
    changed: value.changed,
    applied: { status: value.applied.status },
    observed: { status: value.observed.status },
    ...(decodeNativeDiagnostic(value.diagnostic)
      ? { diagnostic: decodeNativeDiagnostic(value.diagnostic)! }
      : {}),
  };
}

function decodeNativeDiagnostic(value: unknown): ProviderMutationNativeDiagnostic | null {
  if (value === undefined) return null;
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['phase', 'reason', 'configPath', 'method', 'expectedPath', 'detail'])
    || !isBoundedText(value.phase, 128)
    || !isBoundedText(value.reason, 128)
    || !isBoundedText(value.configPath, 2048)
    || (value.method !== undefined && !isBoundedText(value.method, 128))
    || (value.expectedPath !== undefined && !isBoundedText(value.expectedPath, 512))
    || (value.detail !== undefined && !isBoundedText(value.detail, 2048))) {
    return null;
  }
  return {
    phase: value.phase,
    reason: value.reason,
    configPath: value.configPath,
    ...(value.method === undefined ? {} : { method: value.method }),
    ...(value.expectedPath === undefined ? {} : { expectedPath: value.expectedPath }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !/[\0\r\n]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
