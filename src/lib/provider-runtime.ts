import {
  hostApiFetch,
  waitForRuntimeJobResult,
  type RuntimeJobSubmission,
} from '@/lib/host-api';
import type { ProviderCredential, ProviderType } from '@/lib/providers';

async function submitProviderJob<TResult = { success: boolean; error?: string }>(
  path: string,
  init: RequestInit,
): Promise<TResult> {
  const submission = await hostApiFetch<RuntimeJobSubmission<TResult>>(path, init);
  return await waitForRuntimeJobResult<TResult>(submission.job.id);
}

export async function hostProviderStartOAuth(input: {
  provider: string;
  accountId: string;
  label: string;
}): Promise<{ success: boolean }> {
  return await hostApiFetch<{ success: boolean }>('/api/provider-accounts/oauth/start', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function hostProviderCancelOAuth(): Promise<{ success: boolean }> {
  return await hostApiFetch<{ success: boolean }>('/api/provider-accounts/oauth/cancel', {
    method: 'POST',
  });
}

export async function hostProviderSubmitOAuthCode(code: string): Promise<{ success: boolean }> {
  return await hostApiFetch<{ success: boolean }>('/api/provider-accounts/oauth/submit', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export async function hostProviderReadAccount(
  accountId: string,
): Promise<{
  baseUrl?: string;
  apiProtocol?: ProviderCredential['apiProtocol'];
  headers?: Record<string, string>;
} | null> {
  return await hostApiFetch<{
    baseUrl?: string;
    apiProtocol?: ProviderCredential['apiProtocol'];
    headers?: Record<string, string>;
  } | null>(
    `/api/provider-accounts/${encodeURIComponent(accountId)}`,
  );
}

export async function hostProviderReadApiKey(accountId: string): Promise<{ apiKey: string | null }> {
  return await hostApiFetch<{ apiKey: string | null }>(
    `/api/provider-accounts/${encodeURIComponent(accountId)}/api-key`,
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
  return await hostApiFetch<{ valid: boolean; error?: string }>('/api/provider-accounts/validate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function hostProviderCreateAccount(
  account: ProviderCredential,
  apiKey?: string,
): Promise<{ success: boolean; error?: string }> {
  return await submitProviderJob<{ success: boolean; error?: string }>('/api/provider-accounts', {
    method: 'POST',
    body: JSON.stringify({ account, apiKey }),
  });
}

export async function hostProviderUpdateAccount(
  accountId: string,
  updates: Partial<ProviderCredential>,
  apiKey?: string,
): Promise<{ success: boolean; error?: string }> {
  return await submitProviderJob<{ success: boolean; error?: string }>(
    `/api/provider-accounts/${encodeURIComponent(accountId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ updates, apiKey }),
    },
  );
}

export async function hostProviderDeleteAccount(accountId: string): Promise<{ success: boolean; error?: string }> {
  return await submitProviderJob<{ success: boolean; error?: string }>(
    `/api/provider-accounts/${encodeURIComponent(accountId)}`,
    {
      method: 'DELETE',
    },
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
