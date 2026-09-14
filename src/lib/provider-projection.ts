import {
  decodeProviderMutationReceipt,
  type ProviderMutationReceipt,
} from '@/lib/host-api-transport-contract';
import { nativeProjectionError } from '@/lib/provider-projection-errors';
import { PROVIDER_TYPE_INFO, type ProviderCredential, type ProviderOAuthMode, type ProviderType } from '@/lib/providers';
import { summarizeIdentifier } from '@/lib/session-trace';

function invokePrivate<T>(channel: string, input: unknown): Promise<T> {
  return window.electron.ipcRenderer.invoke(channel, input) as Promise<T>;
}

type AccountIntent = Readonly<{
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  kind: 'chat' | 'media';
  endpoint?: string;
  protocol?: 'anthropicMessages' | 'googleGenerativeAi' | 'openAiCompletions' | 'openAiResponses';
  mediaProtocol?: 'google' | 'openAi' | 'openRouter';
  authMode: 'apiKey' | 'oauthBrowser' | 'oauthDevice' | 'token' | 'cliReuse' | 'local';
  revision: number;
}>;

type MutationOutcome = 'stored' | 'deleted' | 'rejected' | 'unknown' | 'unavailable';
type MutationResult = Readonly<{
  status: MutationOutcome;
  receipt?: ProviderMutationReceipt;
}>;
type ProjectionResult = Readonly<{
  success: boolean;
  error?: string;
  warning?: string;
  receipt?: ProviderMutationReceipt;
}>;

function authMode(authMode: ProviderCredential['authMode']): AccountIntent['authMode'] {
  switch (authMode) {
    case 'api_key': return 'apiKey';
    case 'oauth_browser': return 'oauthBrowser';
    case 'oauth_device': return 'oauthDevice';
    case 'token': return 'token';
    case 'cli_reuse': return 'cliReuse';
    case 'local': return 'local';
  }
}

function toAccount(account: ProviderCredential, revision: number): AccountIntent {
  const kind = account.providerKind ?? 'chat';
  return {
    id: account.id,
    provider: account.vendorId,
    label: account.label,
    enabled: account.enabled,
    kind,
    ...(account.baseUrl?.trim() ? { endpoint: account.baseUrl.trim() } : {}),
    ...(kind === 'media'
      ? { mediaProtocol: mediaProtocol(account.mediaApiProtocol) }
      : account.apiProtocol ? { protocol: apiProtocol(account.apiProtocol) } : {}),
    authMode: authMode(account.authMode),
    revision,
  };
}

function apiProtocol(protocol: NonNullable<ProviderCredential['apiProtocol']>): AccountIntent['protocol'] {
  switch (protocol) {
    case 'anthropic-messages': return 'anthropicMessages';
    case 'google-generative-ai': return 'googleGenerativeAi';
    case 'openai-completions': return 'openAiCompletions';
    case 'openai-responses': return 'openAiResponses';
  }
}

function mediaProtocol(protocol: ProviderCredential['mediaApiProtocol']): NonNullable<AccountIntent['mediaProtocol']> {
  switch (protocol) {
    case 'google': return 'google';
    case 'openai': return 'openAi';
    case 'openrouter': return 'openRouter';
    default: return 'openAi';
  }
}

export async function hostProviderStartOAuth(input: {
  provider: string;
  flowId: string;
  accountId: string;
  label: string;
  mode: ProviderOAuthMode;
}): Promise<{ flowId: string; status: 'started' }> {
  const provider = PROVIDER_TYPE_INFO.find((candidate) => candidate.id === input.provider);
  return await invokePrivate('providers:startOAuth', {
    provider: input.provider,
    flowId: input.flowId,
    account: {
      id: input.accountId,
      provider: input.provider,
      label: input.label,
      enabled: true,
      kind: 'chat',
      ...(provider?.defaultBaseUrl ? { endpoint: provider.defaultBaseUrl } : {}),
      ...(provider?.apiProtocol ? { protocol: apiProtocol(provider.apiProtocol) } : {}),
      authMode: authMode(input.mode),
      revision: 1,
    },
  });
}

export async function hostProviderCancelOAuth(input: {
  flowId: string;
  accountId: string;
  vendorId: string;
}): Promise<{ flowId: string; status: 'cancelled' }> {
  return await invokePrivate('providers:cancelOAuth', { flowId: input.flowId });
}

export async function hostProviderSubmitOAuthCode(input: {
  flowId: string;
  accountId: string;
  vendorId: string;
  code: string;
}): Promise<{ flowId: string; status: 'submitted' }> {
  return await invokePrivate('providers:submitOAuthCode', { flowId: input.flowId, code: input.code });
}

export async function hostProviderCreateAccount(
  account: ProviderCredential,
  apiKey?: string,
  token?: string,
): Promise<ProjectionResult> {
  return await mutate('providers:storeAccount', {
    account: toAccount(account, 1),
    ...(apiKey?.trim() ? { apiKey } : {}),
    ...(token?.trim() ? { token } : {}),
  }, 'stored');
}

export async function hostProviderUpdateAccount(
  account: ProviderCredential,
  revision: number,
  apiKey?: string,
  token?: string,
): Promise<ProjectionResult> {
  return await mutate('providers:storeAccount', {
    account: toAccount(account, revision),
    ...(apiKey?.trim() ? { apiKey } : {}),
    ...(token?.trim() ? { token } : {}),
  }, 'stored');
}

export async function hostProviderDeleteAccount(accountId: string, revision: number): Promise<ProjectionResult> {
  return await mutate('providers:deleteAccount', { accountId, revision }, 'deleted');
}

function logProviderConfigTrace(phase: string, payload: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({
    prefix: '[startup-trace]',
    source: 'provider-projection',
    phase,
    ...payload,
  }));
}

function providerProjectionTrace(receipt: ProviderMutationReceipt): Record<string, unknown> {
  return {
    changed: receipt.native.changed,
    applied: receipt.native.applied.status,
    observed: receipt.native.observed.status,
    diagnostic: receipt.native.diagnostic
      ? {
          phase: receipt.native.diagnostic.phase,
          reason: receipt.native.diagnostic.reason,
          configPath: receipt.native.diagnostic.configPath,
          method: receipt.native.diagnostic.method,
          expectedPath: receipt.native.diagnostic.expectedPath,
          detail: receipt.native.diagnostic.detail
            ? summarizeIdentifier(receipt.native.diagnostic.detail)
            : undefined,
        }
      : undefined,
  };
}

function providerMutationInputTrace(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const value = input as Record<string, unknown>;
  const account = value.account;
  if (account && typeof account === 'object' && !Array.isArray(account)) {
    const draft = account as Record<string, unknown>;
    return {
      operation: 'store',
      accountId: summarizeIdentifier(typeof draft.id === 'string' ? draft.id : undefined),
      provider: typeof draft.provider === 'string' ? draft.provider : undefined,
      authMode: typeof draft.authMode === 'string' ? draft.authMode : undefined,
      kind: typeof draft.kind === 'string' ? draft.kind : undefined,
      enabled: typeof draft.enabled === 'boolean' ? draft.enabled : undefined,
      revision: typeof draft.revision === 'number' ? draft.revision : undefined,
      endpoint: summarizeIdentifier(typeof draft.endpoint === 'string' ? draft.endpoint : undefined),
      protocol: typeof draft.protocol === 'string' ? draft.protocol : undefined,
      mediaProtocol: typeof draft.mediaProtocol === 'string' ? draft.mediaProtocol : undefined,
      privateAuthInputPresent: (typeof value.apiKey === 'string' && value.apiKey.trim().length > 0)
        || (typeof value.token === 'string' && value.token.trim().length > 0),
    };
  }
  return {
    operation: 'delete',
    accountId: summarizeIdentifier(typeof value.accountId === 'string' ? value.accountId : undefined),
    revision: typeof value.revision === 'number' ? value.revision : undefined,
  };
}

async function mutate(channel: string, input: unknown, success: 'stored' | 'deleted'): Promise<ProjectionResult> {
  const trace = providerMutationInputTrace(input);
  try {
    logProviderConfigTrace('request-start', { channel, ...trace });
    const result = await invokePrivate<MutationResult>(channel, input);
    const receipt = result.receipt
      ? decodeProviderMutationReceipt(result.receipt, result.status === 'unknown' ? 'commit-outcome-unknown' : 'committed')
      : undefined;
    if (receipt) {
      logProviderConfigTrace('request-finished', {
        channel,
        status: result.status,
        ...providerProjectionTrace(receipt),
      });
    } else {
      logProviderConfigTrace('request-finished', { channel, status: result.status, receipt: false });
    }
    if (result.status === success && receipt?.commit === 'committed' && receipt.persisted.status === 'confirmed') {
      const warning = nativeProjectionError(receipt);
      return {
        success: true,
        receipt,
        ...(warning ? { warning } : {}),
      };
    }
    return {
      success: false,
      error: outcomeError(result.status),
      ...(receipt ? { receipt } : {}),
    };
  } catch (error) {
    logProviderConfigTrace('request-failed', {
      channel,
      errorName: error instanceof Error ? error.name : typeof error,
      message: summarizeIdentifier(error instanceof Error ? error.message : String(error)),
    });
    if (error instanceof Error && error.name === 'ProviderMutationReceiptUnavailableError') {
      return { success: false, error: 'Provider accounts are unavailable' };
    }
    return { success: false, error: 'Provider account request was rejected' };
  }
}

function outcomeError(outcome: MutationOutcome): string {
  if (outcome === 'rejected') return 'Provider account request was rejected';
  if (outcome === 'unknown') return 'Provider account request outcome is unknown';
  return 'Provider accounts are unavailable';
}

export function buildProviderCredentialPayload(input: {
  accountId: string;
  providerType: ProviderType;
  label: string;
  authMode: ProviderCredential['authMode'];
  baseUrl?: string;
  apiProtocol?: ProviderCredential['apiProtocol'];
  headers?: Record<string, string>;
}): ProviderCredential {
  return {
    id: input.accountId,
    vendorId: input.providerType,
    label: input.label,
    authMode: input.authMode,
    baseUrl: input.baseUrl,
    apiProtocol: input.apiProtocol,
    headers: input.headers,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
