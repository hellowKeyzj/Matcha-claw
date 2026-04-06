import { hostApiFetch } from '@/lib/host-api';
import type { ProviderAccount, ProviderType } from '@/lib/providers';

export async function hostProviderSetDefaultAccount(accountId: string): Promise<{ success: boolean; error?: string }> {
  return await hostApiFetch<{ success: boolean; error?: string }>('/api/provider-accounts/default', {
    method: 'PUT',
    body: JSON.stringify({ accountId }),
  });
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

export async function hostProviderReadAccount(accountId: string): Promise<{ baseUrl?: string; model?: string } | null> {
  return await hostApiFetch<{ baseUrl?: string; model?: string } | null>(
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
    options?: { baseUrl?: string };
  },
): Promise<{ valid: boolean; error?: string }> {
  return await hostApiFetch<{ valid: boolean; error?: string }>('/api/provider-accounts/validate', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function hostProviderCreateAccount(
  account: ProviderAccount,
  apiKey?: string,
): Promise<{ success: boolean; error?: string }> {
  return await hostApiFetch<{ success: boolean; error?: string }>('/api/provider-accounts', {
    method: 'POST',
    body: JSON.stringify({ account, apiKey }),
  });
}

export async function hostProviderUpdateAccount(
  accountId: string,
  updates: Partial<ProviderAccount>,
  apiKey?: string,
): Promise<{ success: boolean; error?: string }> {
  return await hostApiFetch<{ success: boolean; error?: string }>(
    `/api/provider-accounts/${encodeURIComponent(accountId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ updates, apiKey }),
    },
  );
}

export async function hostProviderDeleteAccount(accountId: string): Promise<{ success: boolean; error?: string }> {
  return await hostApiFetch<{ success: boolean; error?: string }>(
    `/api/provider-accounts/${encodeURIComponent(accountId)}`,
    {
      method: 'DELETE',
    },
  );
}

export function buildProviderAccountPayload(input: {
  accountId: string;
  providerType: ProviderType;
  label: string;
  authMode: ProviderAccount['authMode'];
  baseUrl?: string;
  model?: string;
}): ProviderAccount {
  return {
    id: input.accountId,
    vendorId: input.providerType,
    label: input.label,
    authMode: input.authMode,
    baseUrl: input.baseUrl,
    model: input.model,
    enabled: true,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
