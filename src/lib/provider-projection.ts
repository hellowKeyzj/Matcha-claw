import { invokeIpc } from '@/lib/api-client';
import { isTraceEnabled } from '@/lib/trace-logger';
import { isProviderMutationCommitted, waitForProviderMutation } from '@/lib/provider-call';
import type { ProviderCallDetail } from '@/types/call-log/provider';
import { nativeProjectionError } from '@/lib/provider-projection-errors';
import { PROVIDER_TYPE_INFO, type ProviderCredential, type ProviderOAuthMode, type ProviderType } from '@/lib/providers';
import { summarizeIdentifier } from '@/lib/session-trace';

function invokePrivate<T>(channel: string, input: unknown): Promise<T> {
  return invokeIpc<T>(channel, input);
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

type ProjectionResult = Readonly<{
  success: boolean;
  error?: string;
  warning?: string;
  receipt?: ProviderCallDetail;
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

function providerProjectionTrace(receipt: ProviderCallDetail): Record<string, unknown> {
  return {
    changed: receipt.native?.changed,
    applied: receipt.native?.applied,
    observed: receipt.native?.observed,
    diagnostic: receipt.diagnostic,
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

async function mutate(
  channel: string,
  input: { account: AccountIntent; apiKey?: string; token?: string } | { accountId: string; revision: number },
  success: 'stored' | 'deleted',
): Promise<ProjectionResult> {
  const target = 'account' in input
    ? { accountId: input.account.id, accountRevision: input.account.revision }
    : { accountId: input.accountId, accountRevision: input.revision };
  try {
    if (isTraceEnabled()) logProviderConfigTrace('request-start', { channel, ...providerMutationInputTrace(input) });
    const response = await invokePrivate<unknown>(channel, input);
    const admissionError = privateMutationError(response, success);
    if (admissionError) return { success: false, error: admissionError };
    const receipt = await waitForProviderMutation(
      response,
      success === 'stored' ? 'providerAccounts.replace' : 'providerAccounts.delete',
      target,
    );
    if (isTraceEnabled()) logProviderConfigTrace('request-finished', {
      channel,
      outcome: receipt.outcome,
      ...providerProjectionTrace(receipt),
    });
    if (isProviderMutationCommitted(receipt, success)) {
      const warning = nativeProjectionError(receipt);
      return { success: true, receipt, ...(warning ? { warning } : {}) };
    }
    return { success: false, error: outcomeError(receipt, success), receipt };
  } catch {
    if (isTraceEnabled()) logProviderConfigTrace('request-failed', { channel, outcome: 'unknown' });
    return { success: false, error: mutationUnknownError(success) };
  }
}

function mutationUnknownError(success: 'stored' | 'deleted'): string {
  const operation = success === 'stored' ? '保存' : '删除';
  return `${operation}结果暂时无法确认，操作可能已执行。请重新打开供应商设置核对状态，确认前不要重复操作。`;
}

function privateMutationError(value: unknown, success: 'stored' | 'deleted'): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'status') || !Object.hasOwn(value, 'reason')
    || !('status' in value) || !('reason' in value)) return undefined;
  if (value.status === 'unknown' && value.reason === 'outcome-unknown') return mutationUnknownError(success);
  if (value.status !== 'rejected') return undefined;
  const operation = success === 'stored' ? '保存' : '删除';
  switch (value.reason) {
    case 'not-admitted':
      return `服务暂时无法受理请求，本次${operation}未执行。请稍后重试；若持续失败，请重启应用。`;
    case 'invalid-request':
      return `请求参数无效，本次${operation}未执行。请重新打开供应商设置，核对账号信息后重试。`;
    case 'rejected':
      return `请求被拒绝，本次${operation}未执行。请核对账号信息和凭据后重试。`;
    default:
      return undefined;
  }
}

function outcomeError(receipt: ProviderCallDetail, success: 'stored' | 'deleted'): string {
  if (receipt.phase !== 'terminal' || receipt.outcome === 'unknown'
    || receipt.commit === 'unknown' || receipt.persisted === 'unknown'
    || receipt.diagnostic?.reason === 'private-transaction-settle-failed') return mutationUnknownError(success);
  if (receipt.outcome === 'rejected' || receipt.outcome === 'missing') {
    const operation = success === 'stored' ? '保存' : '删除';
    return `请求被拒绝，本次${operation}未执行。请重新打开供应商设置，核对账号信息和凭据后重试。`;
  }
  return mutationUnknownError(success);
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
