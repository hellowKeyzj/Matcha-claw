import {
  hostCapabilityExecute,
  waitForRuntimeJobResult,
  type RuntimeJobSubmission,
} from '@/lib/host-api';
import type { ProviderCredential, ProviderType } from '@/lib/providers';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';

const MODEL_PROVIDER_CAPABILITY_ID = 'model.provider';

async function modelProviderCapabilityExecute<TResult>(
  operationId: string,
  runtimeAddress: RuntimeAddress,
  input: Record<string, unknown> = {},
): Promise<TResult> {
  return await hostCapabilityExecute<TResult>({
    id: MODEL_PROVIDER_CAPABILITY_ID,
    operationId,
    runtimeAddress,
    input: {
      ...input,
      runtimeAddress,
    },
  });
}

async function submitProviderJob<TResult = { success: boolean; error?: string }>(
  operationId: string,
  runtimeAddress: RuntimeAddress,
  input: Record<string, unknown>,
): Promise<TResult> {
  const submission = await modelProviderCapabilityExecute<RuntimeJobSubmission<TResult>>(operationId, runtimeAddress, input);
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostProviderStartOAuth(input: {
  provider: string;
  accountId: string;
  label: string;
}, runtimeAddress: RuntimeAddress): Promise<{ success: boolean }> {
  return await modelProviderCapabilityExecute<{ success: boolean }>('providers.oauthStart', runtimeAddress, input);
}

export async function hostProviderCancelOAuth(runtimeAddress: RuntimeAddress): Promise<{ success: boolean }> {
  return await modelProviderCapabilityExecute<{ success: boolean }>('providers.oauthCancel', runtimeAddress);
}

export async function hostProviderSubmitOAuthCode(code: string, runtimeAddress: RuntimeAddress): Promise<{ success: boolean }> {
  return await modelProviderCapabilityExecute<{ success: boolean }>('providers.oauthSubmit', runtimeAddress, { code });
}

export async function hostProviderReadAccount(
  accountId: string,
  runtimeAddress: RuntimeAddress,
): Promise<{
  baseUrl?: string;
  apiProtocol?: ProviderCredential['apiProtocol'];
  headers?: Record<string, string>;
} | null> {
  return await modelProviderCapabilityExecute<{
    baseUrl?: string;
    apiProtocol?: ProviderCredential['apiProtocol'];
    headers?: Record<string, string>;
  } | null>('providers.getAccount', runtimeAddress, { accountId });
}

export async function hostProviderReadApiKey(accountId: string, runtimeAddress: RuntimeAddress): Promise<{ apiKey: string | null }> {
  return await modelProviderCapabilityExecute<{ apiKey: string | null }>('providers.getApiKey', runtimeAddress, { accountId });
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
  runtimeAddress: RuntimeAddress,
): Promise<{ valid: boolean; error?: string }> {
  return await modelProviderCapabilityExecute<{ valid: boolean; error?: string }>('providers.validate', runtimeAddress, input);
}

export async function hostProviderCreateAccount(
  account: ProviderCredential,
  runtimeAddress: RuntimeAddress,
  apiKey?: string,
): Promise<{ success: boolean; error?: string }> {
  return await submitProviderJob<{ success: boolean; error?: string }>('providers.createAccount', runtimeAddress, { account, apiKey });
}

export async function hostProviderUpdateAccount(
  accountId: string,
  updates: Partial<ProviderCredential>,
  runtimeAddress: RuntimeAddress,
  apiKey?: string,
): Promise<{ success: boolean; error?: string }> {
  return await submitProviderJob<{ success: boolean; error?: string }>(
    'providers.updateAccount',
    runtimeAddress,
    { accountId, updates, apiKey },
  );
}

export async function hostProviderDeleteAccount(accountId: string, runtimeAddress: RuntimeAddress): Promise<{ success: boolean; error?: string }> {
  return await submitProviderJob<{ success: boolean; error?: string }>(
    'providers.deleteAccount',
    runtimeAddress,
    { accountId },
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
