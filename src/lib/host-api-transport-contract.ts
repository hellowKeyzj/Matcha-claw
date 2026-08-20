export type HostApiProxySuccessData = {
  status: number;
  ok: boolean;
  json?: unknown;
  text?: string;
};

export type HostApiProxySuccessEnvelope = {
  ok: true;
  data: HostApiProxySuccessData;
};

export type HostApiProxyFailureCode = 'TIMEOUT' | 'ABORTED' | 'UNAVAILABLE';

export type HostApiProxyFailureEnvelope = {
  ok: false;
  error: { message: string; code?: HostApiProxyFailureCode } | string;
};

export type HostApiProxyEnvelope = HostApiProxySuccessEnvelope | HostApiProxyFailureEnvelope;

export type ProviderMutationDesiredStatus = 'stored' | 'deleted';
export type ProviderMutationCommit = 'committed' | 'commit-outcome-unknown';
export type ProviderMutationAppliedStatus = 'confirmed' | 'unknown';
export type ProviderMutationObservedStatus = 'matches' | 'mismatch' | 'unavailable';

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

export type ProviderMutationNativeDiagnostic = Readonly<{
  phase: string;
  reason: string;
  configPath: string;
  method?: string;
  expectedPath?: string;
  detail?: string;
}>;

export type ProviderMutationNativeEvidence = Readonly<{
  changed: boolean;
  applied: Readonly<{ status: ProviderMutationAppliedStatus }>;
  observed: Readonly<{ status: ProviderMutationObservedStatus }>;
  diagnostic?: ProviderMutationNativeDiagnostic;
}>;

export type ProviderMutationReceipt = Readonly<{
  account?: ProviderMutationAccount;
  desired: Readonly<{ status: ProviderMutationDesiredStatus; revision?: number }>;
  persisted: Readonly<{ status: 'confirmed' | 'unknown'; revision?: number }>;
  native: ProviderMutationNativeEvidence;
  commit: ProviderMutationCommit;
}>;

export type ProviderMutationCommitted = Readonly<ProviderMutationReceipt & {
  persisted: Readonly<{ status: 'confirmed'; revision?: number }>;
  commit: 'committed';
}>;

export type ProviderMutationCommitUnknownEnvelope = Readonly<{
  success: false;
  code: 'commit-outcome-unknown';
  error: 'Provider mutation commit outcome is unknown; reopen before retrying';
  receipt: Readonly<ProviderMutationReceipt & {
    persisted: Readonly<{ status: 'unknown'; revision?: number }>;
    commit: 'commit-outcome-unknown';
  }>;
}>;

export const PROVIDER_MUTATION_COMMIT_UNKNOWN_MESSAGE =
  'Provider mutation commit outcome is unknown; reopen before retrying' as const;

export class ProviderMutationCommitOutcomeUnknownError extends Error {
  readonly code = 'commit-outcome-unknown' as const;
  readonly receipt: ProviderMutationCommitUnknownEnvelope['receipt'];

  constructor(receipt: ProviderMutationCommitUnknownEnvelope['receipt']) {
    super(PROVIDER_MUTATION_COMMIT_UNKNOWN_MESSAGE);
    this.name = 'ProviderMutationCommitOutcomeUnknownError';
    this.receipt = receipt;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isSafeProviderIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

function isSafeProviderText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maxLength
    && !/[\0\r\n]/.test(value);
}

function decodeProviderMutationAccount(value: unknown): ProviderMutationAccount | null {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      'id', 'provider', 'label', 'enabled', 'kind', 'endpoint', 'protocol', 'mediaProtocol', 'authMode', 'revision',
    ])
    || !isSafeProviderIdentifier(value.id)
    || !isSafeProviderIdentifier(value.provider)
    || !isSafeProviderText(value.label, 256)
    || typeof value.enabled !== 'boolean'
    || (value.kind !== undefined && value.kind !== 'chat' && value.kind !== 'media')
    || (value.endpoint !== undefined && !isSafeProviderText(value.endpoint, 2048))
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

export function decodeProviderMutationReceipt(value: unknown, commit: ProviderMutationCommit): ProviderMutationReceipt | null {
  if (!isRecord(value)) return null;
  const hasSuccess = Object.hasOwn(value, 'success');
  if (hasSuccess && (value.success !== true || commit !== 'committed')) return null;
  const allowedKeys = hasSuccess
    ? ['success', 'account', 'desired', 'persisted', 'native', 'commit']
    : ['account', 'desired', 'persisted', 'native', 'commit'];
  if (!hasOnlyKeys(value, allowedKeys)
    || !Object.hasOwn(value, 'desired')
    || !Object.hasOwn(value, 'persisted')
    || !Object.hasOwn(value, 'native')
    || !Object.hasOwn(value, 'commit')
    || (value.account !== undefined && !decodeProviderMutationAccount(value.account))
    || !isRecord(value.desired)
    || !hasOnlyKeys(value.desired, ['status', 'revision'])
    || !Object.hasOwn(value.desired, 'status')
    || !isRecord(value.persisted)
    || !hasOnlyKeys(value.persisted, ['status', 'revision'])
    || !Object.hasOwn(value.persisted, 'status')
    || !isRecord(value.native)
    || !hasOnlyKeys(value.native, ['changed', 'applied', 'observed', 'diagnostic'])
    || !Object.hasOwn(value.native, 'changed')
    || !Object.hasOwn(value.native, 'applied')
    || !Object.hasOwn(value.native, 'observed')
    || !isRecord(value.native.applied)
    || !hasExactKeys(value.native.applied, ['status'])
    || !isRecord(value.native.observed)
    || !hasExactKeys(value.native.observed, ['status'])
    || value.commit !== commit
    || !['stored', 'deleted'].includes(value.desired.status as string)
    || (value.desired.revision !== undefined && !isPositiveInteger(value.desired.revision))
    || (value.persisted.status !== 'confirmed' && value.persisted.status !== 'unknown')
    || (value.persisted.revision !== undefined && !isPositiveInteger(value.persisted.revision))
    || typeof value.native.changed !== 'boolean'
    || !['confirmed', 'unknown'].includes(value.native.applied.status as string)
    || !['matches', 'mismatch', 'unavailable'].includes(value.native.observed.status as string)) {
    return null;
  }
  return {
    ...(value.account === undefined ? {} : { account: decodeProviderMutationAccount(value.account)! }),
    desired: {
      status: value.desired.status as ProviderMutationDesiredStatus,
      ...(value.desired.revision === undefined ? {} : { revision: value.desired.revision as number }),
    },
    persisted: {
      status: value.persisted.status as 'confirmed' | 'unknown',
      ...(value.persisted.revision === undefined ? {} : { revision: value.persisted.revision as number }),
    },
    native: {
      changed: value.native.changed,
      applied: { status: value.native.applied.status as ProviderMutationAppliedStatus },
      observed: { status: value.native.observed.status as ProviderMutationObservedStatus },
      ...(decodeProviderMutationNativeDiagnostic(value.native.diagnostic)
        ? { diagnostic: decodeProviderMutationNativeDiagnostic(value.native.diagnostic)! }
        : {}),
    },
    commit,
  };
}

function decodeProviderMutationNativeDiagnostic(value: unknown): ProviderMutationNativeDiagnostic | null {
  if (value === undefined) return null;
  if (!isRecord(value)
    || !hasOnlyKeys(value, ['phase', 'reason', 'configPath', 'method', 'expectedPath', 'detail'])
    || !isSafeProviderText(value.phase, 128)
    || !isSafeProviderText(value.reason, 128)
    || !isSafeProviderText(value.configPath, 2048)
    || (value.method !== undefined && !isSafeProviderText(value.method, 128))
    || (value.expectedPath !== undefined && !isSafeProviderText(value.expectedPath, 512))
    || (value.detail !== undefined && !isSafeProviderText(value.detail, 2048))) {
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

export function decodeProviderMutationCommitted(value: unknown): ProviderMutationCommitted | null {
  const receipt = decodeProviderMutationReceipt(value, 'committed');
  if (!receipt || receipt.persisted.status !== 'confirmed') return null;
  return receipt as ProviderMutationCommitted;
}

export function decodeProviderMutationCommitUnknownEnvelope(
  value: unknown,
): ProviderMutationCommitUnknownEnvelope | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['success', 'code', 'error', 'receipt'])
    || value.success !== false
    || value.code !== 'commit-outcome-unknown'
    || value.error !== PROVIDER_MUTATION_COMMIT_UNKNOWN_MESSAGE) {
    return null;
  }
  const decodedReceipt = decodeProviderMutationReceipt(value.receipt, 'commit-outcome-unknown');
  if (!decodedReceipt || decodedReceipt.persisted.status !== 'unknown') return null;
  return {
    success: false,
    code: 'commit-outcome-unknown',
    error: PROVIDER_MUTATION_COMMIT_UNKNOWN_MESSAGE,
    receipt: {
      ...decodedReceipt,
      persisted: {
        status: 'unknown',
        ...(decodedReceipt.persisted.revision === undefined
          ? {}
          : { revision: decodedReceipt.persisted.revision }),
      },
      commit: 'commit-outcome-unknown',
    },
  };
}

function isHostApiProxyFailureCode(value: unknown): value is HostApiProxyFailureCode {
  return value === 'TIMEOUT' || value === 'ABORTED' || value === 'UNAVAILABLE';
}

function extractHostApiErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) {
    return fallback;
  }
  if (typeof payload.error === 'string' && payload.error.trim()) {
    return payload.error;
  }
  if (isRecord(payload.error) && typeof payload.error.message === 'string' && payload.error.message.trim()) {
    return payload.error.message;
  }
  if (typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message;
  }
  return fallback;
}

export function resolveHostApiProxyErrorMessage(error: HostApiProxyFailureEnvelope['error'] | undefined): string {
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return 'Host API proxy request failed';
}

export function resolveHostApiProxyErrorCode(
  error: HostApiProxyFailureEnvelope['error'] | undefined,
): HostApiProxyFailureCode | undefined {
  if (isRecord(error) && isHostApiProxyFailureCode(error.code)) {
    return error.code;
  }
  return undefined;
}

export function decodeHostApiProxyEnvelope(payload: unknown): HostApiProxyEnvelope {
  if (!isRecord(payload)) {
    throw new Error('Invalid hostapi proxy envelope: expected object');
  }

  if (payload.ok === true) {
    if (!isRecord(payload.data)) {
      throw new Error('Invalid hostapi proxy envelope: success response missing data object');
    }
    const status = payload.data.status;
    const ok = payload.data.ok;
    if (typeof status !== 'number' || !Number.isFinite(status)) {
      throw new Error('Invalid hostapi proxy envelope: success response missing numeric status');
    }
    if (typeof ok !== 'boolean') {
      throw new Error('Invalid hostapi proxy envelope: success response missing boolean ok');
    }
    if (payload.data.text !== undefined && typeof payload.data.text !== 'string') {
      throw new Error('Invalid hostapi proxy envelope: success response text must be string');
    }
    return {
      ok: true,
      data: {
        status,
        ok,
        ...(payload.data.json !== undefined ? { json: payload.data.json } : {}),
        ...(typeof payload.data.text === 'string' ? { text: payload.data.text } : {}),
      },
    };
  }

  if (payload.ok === false) {
    const error = payload.error;
    if (
      !(typeof error === 'string' && error.trim())
      && !(isRecord(error) && typeof error.message === 'string' && error.message.trim())
    ) {
      throw new Error('Invalid hostapi proxy envelope: failure response missing error message');
    }
    return {
      ok: false,
      error: typeof error === 'string'
        ? error
        : {
          message: error.message as string,
          ...(isHostApiProxyFailureCode(error.code) ? { code: error.code } : {}),
        },
    };
  }

  throw new Error('Invalid hostapi proxy envelope: missing boolean ok');
}

function isProviderMutationRequest(context: { method: string; path: string }): boolean {
  return context.method.toUpperCase() === 'POST'
    && (context.path === '/api/provider-models' || context.path === '/api/provider-routing');
}

export function unwrapHostApiProxyEnvelope<T>(
  envelope: HostApiProxyEnvelope,
  context: { method: string; path: string },
): { status: number; data: T } {
  if (!envelope.ok) {
    const error = new Error(resolveHostApiProxyErrorMessage(envelope.error));
    const code = resolveHostApiProxyErrorCode(envelope.error);
    if (code) {
      Object.assign(error, { code });
    }
    throw error;
  }

  const { status, ok, json, text } = envelope.data;
  if (status >= 400 || ok === false) {
    const fallbackMessage = text || `Host API request failed: ${context.method} ${context.path} (HTTP ${status})`;
    if (status === 409 && isProviderMutationRequest(context)) {
      const unknown = decodeProviderMutationCommitUnknownEnvelope(json);
      if (unknown) {
        throw new ProviderMutationCommitOutcomeUnknownError(unknown.receipt);
      }
    }
    throw new Error(extractHostApiErrorMessage(json, fallbackMessage));
  }

  if (status === 204) {
    return {
      status,
      data: undefined as T,
    };
  }
  if (json !== undefined) {
    return {
      status,
      data: json as T,
    };
  }
  return {
    status,
    data: text as T,
  };
}
