import {
  hostApiFetch,
  resolveSingleCapabilityScope,
  waitForRuntimeJobResult,
  type RuntimeJobSubmission,
} from '@/lib/host-api';
import type { ProviderCredential, ProviderType } from '@/lib/providers';
import type { CapabilityTarget } from '../../runtime-host/shared/runtime-address';

const MODEL_PROVIDER_CAPABILITY_ID = 'model.provider';

async function modelProviderCapabilityExecute<TResult>(
  operationId: string,
  input: Record<string, unknown> = {},
  target: CapabilityTarget | null = null,
): Promise<TResult> {
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: MODEL_PROVIDER_CAPABILITY_ID,
      operationId,
      scope: await resolveSingleCapabilityScope(MODEL_PROVIDER_CAPABILITY_ID),
      target,
      input,
    }),
  });
}

async function submitProviderJob<TResult = { success: boolean; error?: string }>(
  operationId: string,
  input: Record<string, unknown>,
  target: CapabilityTarget | null,
): Promise<TResult> {
  const submission = await modelProviderCapabilityExecute<RuntimeJobSubmission<TResult>>(operationId, input, target);
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostProviderStartOAuth(input: {
  provider: string;
  flowId: string;
  accountId: string;
  label: string;
}): Promise<{ success: boolean }> {
  return await modelProviderCapabilityExecute<{ success: boolean }>(
    'providers.oauthStart',
    input,
    { kind: 'provider-oauth', flowId: input.flowId, accountId: input.accountId, vendorId: input.provider },
  );
}

export async function hostProviderCancelOAuth(input: {
  flowId: string;
  accountId: string;
  vendorId: string;
}): Promise<{ success: boolean }> {
  return await modelProviderCapabilityExecute<{ success: boolean }>(
    'providers.oauthCancel',
    input,
    { kind: 'provider-oauth', flowId: input.flowId, accountId: input.accountId, vendorId: input.vendorId },
  );
}

export async function hostProviderSubmitOAuthCode(input: {
  flowId: string;
  accountId: string;
  vendorId: string;
  code: string;
}): Promise<{ success: boolean }> {
  return await modelProviderCapabilityExecute<{ success: boolean }>(
    'providers.oauthSubmit',
    input,
    { kind: 'provider-oauth', flowId: input.flowId, accountId: input.accountId, vendorId: input.vendorId },
  );
}

export async function hostProviderReadAccount(
  accountId: string,
): Promise<{
  baseUrl?: string;
  apiProtocol?: ProviderCredential['apiProtocol'];
  headers?: Record<string, string>;
} | null> {
  return await modelProviderCapabilityExecute<{
    baseUrl?: string;
    apiProtocol?: ProviderCredential['apiProtocol'];
    headers?: Record<string, string>;
  } | null>('providers.getAccount', { accountId }, { kind: 'provider-account', accountId });
}

export async function hostProviderReadApiKey(accountId: string, vendorId: string): Promise<{ hasKey: boolean; keyMasked: string | null; last4: string | null }> {
  return await modelProviderCapabilityExecute<{ hasKey: boolean; keyMasked: string | null; last4: string | null }>(
    'providers.getApiKey',
    { accountId, vendorId },
    { kind: 'provider-credential', accountId, vendorId },
  );
}

export async function hostProviderValidate(
  input: {
    accountId?: string;
    vendorId: string;
    apiKey: string;
    options?: {
      baseUrl?: string;
      apiProtocol?: ProviderCredential['apiProtocol'];
      headers?: Record<string, string>;
    };
  },
): Promise<{ valid: boolean; error?: string }> {
  return await modelProviderCapabilityExecute<{ valid: boolean; error?: string }>(
    'providers.validate',
    input,
    input.accountId
      ? { kind: 'provider-credential', accountId: input.accountId, vendorId: input.vendorId }
      : { kind: 'provider-credential', accountId: input.vendorId, vendorId: input.vendorId },
  );
}

export async function hostProviderCreateAccount(
  account: ProviderCredential,
  apiKey?: string,
): Promise<{ success: boolean; error?: string }> {
  return await submitProviderJob<{ success: boolean; error?: string }>(
    'providers.createAccount',
    { account, apiKey },
    { kind: 'provider-account', accountId: account.id, vendorId: account.vendorId },
  );
}

export async function hostProviderUpdateAccount(
  accountId: string,
  updates: Partial<ProviderCredential>,
  apiKey?: string,
): Promise<{ success: boolean; error?: string }> {
  return await submitProviderJob<{ success: boolean; error?: string }>(
    'providers.updateAccount',
    { accountId, updates, apiKey },
    { kind: 'provider-account', accountId },
  );
}

export async function hostProviderDeleteAccount(accountId: string): Promise<{ success: boolean; error?: string }> {
  return await submitProviderJob<{ success: boolean; error?: string }>(
    'providers.deleteAccount',
    { accountId },
    { kind: 'provider-account', accountId },
  );
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
