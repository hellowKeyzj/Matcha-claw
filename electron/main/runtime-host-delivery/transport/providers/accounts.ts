import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from '../client';
import type { CallReceipt } from '../../../../../src/types/call-log';
import { decodeCallReceipt } from '../../../../../src/types/call-log/receipt';

const PROVIDER_ACCOUNTS_PATH = '/api/provider-accounts';
const NOT_ADMITTED = { success: false, error: 'Provider account mutation was not admitted', code: 'not-admitted' } as const;

const UNAVAILABLE = {
  success: false,
  error: 'Provider accounts are unavailable',
} as const;

const INVALID_REQUEST = {
  success: false,
  error: 'Provider account request is invalid',
} as const;

const REJECTED = {
  success: false,
  error: 'Provider account request was rejected',
} as const;

const MISSING = {
  success: false,
  error: 'Provider account was not found',
} as const;

type AuthMode = 'apiKey' | 'oauthBrowser' | 'oauthDevice' | 'token' | 'cliReuse' | 'local';

type AccountKind = 'chat' | 'media';
type ApiProtocol = 'anthropicMessages' | 'googleGenerativeAi' | 'openAiCompletions' | 'openAiResponses';
type MediaProtocol = 'google' | 'openAi' | 'openRouter';

export type ProviderAccount = Readonly<{
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  kind?: AccountKind;
  endpoint?: string;
  protocol?: ApiProtocol;
  mediaProtocol?: MediaProtocol;
  authMode: AuthMode;
  revision: number;
}>;

export type ProviderAccountsListRequest = Readonly<{
  id: 'provider.accounts';
  operationId: 'providerAccounts.list';
  scope: Readonly<{ kind: 'provider-account-catalog' }>;
  target: Readonly<{ kind: 'provider-accounts' }>;
  input: Readonly<{ kind: 'list' }>;
}>;

type Request =
  | ProviderAccountsListRequest
  | Readonly<{
    id: 'provider.accounts';
    operationId: 'providerAccounts.get';
    scope: Readonly<{ kind: 'provider-account-catalog' }>;
    target: Readonly<{ kind: 'provider-accounts' }>;
    input: Readonly<{ kind: 'get'; accountId: string }>;
  }>
  | Readonly<{
    id: 'provider.accounts';
    operationId: 'providerAccounts.replace';
    scope: Readonly<{ kind: 'provider-account-catalog' }>;
    target: Readonly<{ kind: 'provider-accounts' }>;
    input: Readonly<{ kind: 'replace'; account: ProviderAccount; privateTransactionId?: string }>;
  }>
  | Readonly<{
    id: 'provider.accounts';
    operationId: 'providerAccounts.delete';
    scope: Readonly<{ kind: 'provider-account-catalog' }>;
    target: Readonly<{ kind: 'provider-accounts' }>;
    input: Readonly<{ kind: 'delete'; accountId: string; revision: number; privateTransactionId?: string }>;
  }>;

export type ProviderAccountsListResponse = Readonly<{ accounts: ProviderAccount[] }>;
type AccountResponse = Readonly<{ account: ProviderAccount }>;
export type ProviderAccountsMutationResponse = CallReceipt;

const PROVIDER_ACCOUNT_KEYS: readonly string[] = [
  'id', 'provider', 'label', 'enabled', 'kind', 'endpoint', 'protocol', 'mediaProtocol', 'authMode', 'revision',
];

function providerAccountsTransportTrace(phase: string, payload: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({
    prefix: '[startup-trace]',
    source: 'provider-accounts-transport',
    phase,
    at: Date.now(),
    ...payload,
  }));
}

function idShape(value: string | null | undefined): { present: boolean; length: number } {
  return value ? { present: true, length: value.length } : { present: false, length: 0 };
}

function requestTrace(request: Request): Record<string, unknown> {
  if (request.operationId === 'providerAccounts.replace') {
    return {
      operationId: request.operationId,
      accountId: idShape(request.input.account.id),
      provider: request.input.account.provider,
      authMode: request.input.account.authMode,
      kind: request.input.account.kind,
      enabled: request.input.account.enabled,
      revision: request.input.account.revision,
      endpoint: idShape(request.input.account.endpoint),
      protocol: request.input.account.protocol,
      mediaProtocol: request.input.account.mediaProtocol,
    };
  }
  if (request.operationId === 'providerAccounts.delete' || request.operationId === 'providerAccounts.get') {
    return {
      operationId: request.operationId,
      accountId: idShape(request.input.accountId),
      revision: 'revision' in request.input ? request.input.revision : undefined,
    };
  }
  return { operationId: request.operationId };
}

export type ProviderAccountsTransportResponse = Readonly<{
  status: 200 | 202 | 400 | 404 | 422 | 503;
  body: ProviderAccountsListResponse | AccountResponse | CallReceipt | typeof INVALID_REQUEST | typeof REJECTED | typeof MISSING | typeof UNAVAILABLE | typeof NOT_ADMITTED;
}>;

export interface ProviderAccountsTransport {
  execute(request: unknown): Promise<ProviderAccountsTransportResponse>;
}

export function createProviderAccountsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): ProviderAccountsTransport {
  return {
    async execute(request: unknown): Promise<ProviderAccountsTransportResponse> {
      if (!isRequest(request)) {
        providerAccountsTransportTrace('request.rejected', { detail: 'invalid-request' });
        return { status: 400, body: INVALID_REQUEST };
      }
      return executeRequest(request, issuer, runtimeHostTransportPort, fetcher);
    },
  };
}

async function executeRequest(
  request: Request,
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch,
): Promise<ProviderAccountsTransportResponse> {
  const trace = requestTrace(request);
  providerAccountsTransportTrace('request.start', trace);
  const response = await sendLoopbackJson({
    port,
    path: PROVIDER_ACCOUNTS_PATH,
    issuer,
    decision: {
      endpoint: PROVIDER_ACCOUNTS_PATH,
      scope: 'providers:accounts',
      capability: request.operationId,
      subject: 'provider-accounts',
    },
    method: 'POST',
    fetcher,
    body: request,
  });
  if (response === null) {
    providerAccountsTransportTrace('response.rejected', { ...trace, status: 503, detail: 'loopback-unavailable' });
    return { status: 503, body: UNAVAILABLE };
  }
  providerAccountsTransportTrace('response.http', { ...trace, httpStatus: response.status });
  const body = response.body;
  const mutation = request.operationId === 'providerAccounts.replace' || request.operationId === 'providerAccounts.delete';
  if (mutation && response.status === 202) {
    try { return { status: 202, body: decodeCallReceipt(body) }; } catch { /* closed admission boundary */ }
  }
  if (!mutation && response.status === 200
    && (request.operationId === 'providerAccounts.list' ? isListResponse(body) : isAccountResponse(body))) {
    return { status: 200, body: body as ProviderAccountsListResponse | AccountResponse };
  }
  if (mutation && response.status === 503 && isRecord(body)
    && hasExactKeys(body, ['success', 'error', 'code'])
    && body.success === false && body.error === NOT_ADMITTED.error && body.code === NOT_ADMITTED.code) {
    return { status: 503, body: NOT_ADMITTED };
  }
  if (response.status === 400) {
    providerAccountsTransportTrace('response.rejected', { ...trace, status: 400 });
    return { status: 400, body: INVALID_REQUEST };
  }
  if (response.status === 404) {
    const status = request.operationId === 'providerAccounts.get' ? 404 : 503;
    providerAccountsTransportTrace('response.rejected', { ...trace, status });
    return request.operationId === 'providerAccounts.get'
      ? { status: 404, body: MISSING }
      : { status: 503, body: UNAVAILABLE };
  }
  if (response.status === 422) {
    providerAccountsTransportTrace('response.rejected', { ...trace, status: 422 });
    return { status: 422, body: REJECTED };
  }
  if (response.status === 503) {
    providerAccountsTransportTrace('response.rejected', { ...trace, status: 503 });
    return { status: 503, body: UNAVAILABLE };
  }
  providerAccountsTransportTrace('response.rejected', { ...trace, status: 503, detail: 'fallback-unavailable' });
  return { status: 503, body: UNAVAILABLE };
}

function isRequest(value: unknown): value is Request {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'provider.accounts'
    || !isRecord(value.scope)
    || !hasExactKeys(value.scope, ['kind'])
    || value.scope.kind !== 'provider-account-catalog'
    || !isRecord(value.target)
    || !hasExactKeys(value.target, ['kind'])
    || value.target.kind !== 'provider-accounts'
    || !isRecord(value.input)) return false;
  if (value.operationId === 'providerAccounts.list') return hasExactKeys(value.input, ['kind']) && value.input.kind === 'list';
  if (value.operationId === 'providerAccounts.get') {
    return hasExactKeys(value.input, ['kind', 'accountId']) && value.input.kind === 'get' && isIdentifier(value.input.accountId);
  }
  if (value.operationId === 'providerAccounts.replace') {
    return hasExactKeys(value.input, value.input.privateTransactionId === undefined ? ['kind', 'account'] : ['kind', 'account', 'privateTransactionId'])
      && validTransactionId(value.input.privateTransactionId)
      && value.input.kind === 'replace'
      && isProviderAccount(value.input.account);
  }
  return value.operationId === 'providerAccounts.delete'
    && hasExactKeys(value.input, value.input.privateTransactionId === undefined ? ['kind', 'accountId', 'revision'] : ['kind', 'accountId', 'revision', 'privateTransactionId'])
    && validTransactionId(value.input.privateTransactionId)
    && value.input.kind === 'delete'
    && isIdentifier(value.input.accountId)
    && isRevision(value.input.revision);
}

function validTransactionId(value: unknown): boolean {
  return value === undefined || typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}

function isListResponse(value: unknown): value is ProviderAccountsListResponse {
  return isRecord(value) && hasExactKeys(value, ['accounts']) && Array.isArray(value.accounts) && value.accounts.every(isProviderAccount);
}

function isAccountResponse(value: unknown): value is AccountResponse {
  return isRecord(value) && hasExactKeys(value, ['account']) && isProviderAccount(value.account);
}

function isProviderAccount(value: unknown): value is ProviderAccount {
  if (!isRecord(value) || !Object.keys(value).every((key) => PROVIDER_ACCOUNT_KEYS.includes(key))) return false;
  const kind = value.kind ?? 'chat';
  const media = kind === 'media';
  return isIdentifier(value.id)
    && isIdentifier(value.provider)
    && typeof value.label === 'string'
    && value.label.trim().length > 0
    && typeof value.enabled === 'boolean'
    && (value.kind === undefined || isAccountKind(value.kind))
    && optionalEndpoint(value.endpoint)
    && (media ? value.protocol === undefined && isMediaProtocol(value.mediaProtocol) : optionalApiProtocol(value.protocol) && value.mediaProtocol === undefined)
    && isAuthMode(value.authMode)
    && isRevision(value.revision);
}

function isRevision(value: unknown): value is number {
  return isSafeNonNegativeInteger(value) && value > 0;
}

function isAccountKind(value: unknown): value is AccountKind {
  return value === 'chat' || value === 'media';
}

function optionalEndpoint(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.trim().length > 0 && value.length <= 2048);
}

function optionalApiProtocol(value: unknown): value is ApiProtocol | undefined {
  return value === undefined || value === 'anthropicMessages' || value === 'googleGenerativeAi'
    || value === 'openAiCompletions' || value === 'openAiResponses';
}

function isMediaProtocol(value: unknown): value is MediaProtocol {
  return value === 'google' || value === 'openAi' || value === 'openRouter';
}

function isAuthMode(value: unknown): value is AuthMode {
  return value === 'apiKey' || value === 'oauthBrowser' || value === 'oauthDevice' || value === 'token' || value === 'cliReuse' || value === 'local';
}

export function isProviderAccountIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

function isIdentifier(value: unknown): value is string {
  return isProviderAccountIdentifier(value);
}
