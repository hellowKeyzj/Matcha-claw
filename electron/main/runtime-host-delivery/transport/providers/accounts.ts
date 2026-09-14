import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';
import {
  decodeProviderMutationCommittedAccountResponse,
  decodeProviderMutationCommittedResponse,
  decodeProviderMutationCommitUnknownResponse,
  ProviderMutationReceiptUnavailableError,
  type ProviderMutationCommittedAccountResponse,
  type ProviderMutationCommittedResponse,
  type ProviderMutationCommitUnknownResponse,
} from './mutation-receipt';

const DECISION_TTL_MS = 30_000;
const MUTATION_UNKNOWN_ERROR = 'Provider mutation commit outcome is unknown; reopen before retrying';

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
    input: Readonly<{ kind: 'replace'; account: ProviderAccount }>;
  }>
  | Readonly<{
    id: 'provider.accounts';
    operationId: 'providerAccounts.delete';
    scope: Readonly<{ kind: 'provider-account-catalog' }>;
    target: Readonly<{ kind: 'provider-accounts' }>;
    input: Readonly<{ kind: 'delete'; accountId: string; revision: number }>;
  }>;

export type ProviderAccountsListResponse = Readonly<{ accounts: ProviderAccount[] }>;
type AccountResponse = Readonly<{ account: ProviderAccount }>;
export type ProviderAccountsMutationResponse =
  | ProviderMutationCommittedAccountResponse
  | ProviderMutationCommittedResponse
  | ProviderMutationCommitUnknownResponse;

type ReplaceResponse = ProviderMutationCommittedAccountResponse | ProviderMutationCommitUnknownResponse;

type DeleteResponse = ProviderMutationCommittedResponse | ProviderMutationCommitUnknownResponse;

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

function receiptTrace(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { receipt: false };
  const value = body as Record<string, unknown>;
  const receipt = 'receipt' in value && value.receipt && typeof value.receipt === 'object'
    ? value.receipt as Record<string, unknown>
    : value;
  const native = receipt.native && typeof receipt.native === 'object' ? receipt.native as Record<string, unknown> : undefined;
  const applied = native?.applied && typeof native.applied === 'object' ? native.applied as Record<string, unknown> : undefined;
  const observed = native?.observed && typeof native.observed === 'object' ? native.observed as Record<string, unknown> : undefined;
  const diagnostic = native?.diagnostic && typeof native.diagnostic === 'object' ? native.diagnostic as Record<string, unknown> : undefined;
  return {
    receipt: Boolean(native),
    nativeChanged: typeof native?.changed === 'boolean' ? native.changed : undefined,
    nativeApplied: typeof applied?.status === 'string' ? applied.status : undefined,
    nativeObserved: typeof observed?.status === 'string' ? observed.status : undefined,
    nativeDiagnostic: diagnostic ? {
      phase: typeof diagnostic.phase === 'string' ? diagnostic.phase : undefined,
      reason: typeof diagnostic.reason === 'string' ? diagnostic.reason : undefined,
      method: typeof diagnostic.method === 'string' ? diagnostic.method : undefined,
      expectedPath: typeof diagnostic.expectedPath === 'string' ? diagnostic.expectedPath : undefined,
      detail: idShape(typeof diagnostic.detail === 'string' ? diagnostic.detail : undefined),
    } : undefined,
  };
}

export type ProviderAccountsTransportResponse = Readonly<{
  status: 200 | 400 | 409 | 404 | 422 | 503;
  body: ProviderAccountsListResponse | AccountResponse | ReplaceResponse | DeleteResponse | typeof INVALID_REQUEST | typeof REJECTED | typeof MISSING | typeof UNAVAILABLE;
}>;

export interface ProviderAccountsTransport {
  execute(request: unknown): Promise<ProviderAccountsTransportResponse>;
}

export function createProviderAccountsTransport(
  issuer: RuntimeHostDeliveryIssuer,
  providerAccountsTransportPort: number,
  fetcher: typeof fetch = fetch,
): ProviderAccountsTransport {
  const url = `http://127.0.0.1:${providerAccountsTransportPort}/api/provider-accounts`;
  return {
    async execute(request: unknown): Promise<ProviderAccountsTransportResponse> {
      if (!isRequest(request)) {
        providerAccountsTransportTrace('request.rejected', { detail: 'invalid-request' });
        return { status: 400, body: INVALID_REQUEST };
      }
      const trace = requestTrace(request);
      providerAccountsTransportTrace('request.start', trace);
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/provider-accounts',
              scope: 'providers:accounts',
              capability: request.operationId,
              subject: 'provider-accounts',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        providerAccountsTransportTrace('response.http', { ...trace, httpStatus: response.status });
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          providerAccountsTransportTrace('response.decode-failed', { ...trace, httpStatus: response.status });
          if (response.status === 200) throw new ProviderMutationReceiptUnavailableError();
          return { status: 503, body: UNAVAILABLE };
        }
        if (response.status === 200) {
          if (request.operationId === 'providerAccounts.replace') {
            const decoded = decodeProviderMutationCommittedAccountResponse(body, {
              desiredStatus: 'stored',
              desiredRevision: 'optional',
              unknownError: MUTATION_UNKNOWN_ERROR,
            });
            providerAccountsTransportTrace('response.decoded', { ...trace, status: 200, ...receiptTrace(decoded) });
            return {
              status: 200,
              body: decoded,
            };
          }
          if (request.operationId === 'providerAccounts.delete') {
            const decoded = decodeProviderMutationCommittedResponse(body, {
              desiredStatus: 'deleted',
              desiredRevision: 'optional',
              unknownError: MUTATION_UNKNOWN_ERROR,
            });
            providerAccountsTransportTrace('response.decoded', { ...trace, status: 200, ...receiptTrace(decoded) });
            return {
              status: 200,
              body: decoded,
            };
          }
          if (isListResponse(body) || isAccountResponse(body)) {
            providerAccountsTransportTrace('response.decoded', { ...trace, status: 200, receipt: false });
            return { status: 200, body };
          }
        }
        if (response.status === 409
          && (request.operationId === 'providerAccounts.replace' || request.operationId === 'providerAccounts.delete')) {
          const unknown = decodeProviderMutationCommitUnknownResponse(body, {
            desiredRevision: 'optional',
            unknownError: MUTATION_UNKNOWN_ERROR,
          });
          providerAccountsTransportTrace('response.decoded', { ...trace, status: unknown ? 409 : 503, ...receiptTrace(unknown) });
          return unknown
            ? { status: 409, body: unknown }
            : { status: 503, body: UNAVAILABLE };
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
      } catch (error) {
        providerAccountsTransportTrace('request.failed', {
          ...trace,
          errorName: error instanceof Error ? error.name : typeof error,
          message: idShape(error instanceof Error ? error.message : String(error)),
        });
        // Public delivery deliberately redacts malformed loopback and host failures.
      }
      providerAccountsTransportTrace('response.rejected', { ...trace, status: 503, detail: 'fallback-unavailable' });
      return { status: 503, body: UNAVAILABLE };
    },
  };
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
    return hasExactKeys(value.input, ['kind', 'account'])
      && value.input.kind === 'replace'
      && isProviderAccount(value.input.account);
  }
  return value.operationId === 'providerAccounts.delete'
    && hasExactKeys(value.input, ['kind', 'accountId', 'revision'])
    && value.input.kind === 'delete'
    && isIdentifier(value.input.accountId)
    && isRevision(value.input.revision);
}

function isListResponse(value: unknown): value is ProviderAccountsListResponse {
  return isRecord(value) && hasExactKeys(value, ['accounts']) && Array.isArray(value.accounts) && value.accounts.every(isProviderAccount);
}

function isAccountResponse(value: unknown): value is AccountResponse {
  return isRecord(value) && hasExactKeys(value, ['account']) && isProviderAccount(value.account);
}

function isProviderAccount(value: unknown): value is ProviderAccount {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'id', 'provider', 'label', 'enabled', 'kind', 'endpoint', 'protocol', 'mediaProtocol', 'authMode', 'revision',
  ])) return false;
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
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
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
