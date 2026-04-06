import { createDefaultRuntimeHostHttpClient } from '../../main/runtime-host-client';
import type { ProviderConfig, ProviderType } from './provider-types';

function getRuntimeHostClient() {
  return createDefaultRuntimeHostHttpClient({
    timeoutMs: 8000,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toProviderConfig(account: unknown): ProviderConfig | null {
  const record = asRecord(account);
  if (!record) {
    return null;
  }
  const id = typeof record.id === 'string' ? record.id : '';
  const type = typeof record.vendorId === 'string'
    ? record.vendorId
    : (typeof record.type === 'string' ? record.type : '');
  if (!id || !type) {
    return null;
  }
  return {
    id,
    name: typeof record.label === 'string' ? record.label : id,
    type: type as ProviderType,
    ...(typeof record.baseUrl === 'string' ? { baseUrl: record.baseUrl } : {}),
    ...(typeof record.model === 'string' ? { model: record.model } : {}),
    ...(Array.isArray(record.fallbackModels)
      ? { fallbackModels: record.fallbackModels.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(Array.isArray(record.fallbackAccountIds)
      ? { fallbackProviderIds: record.fallbackAccountIds.filter((item): item is string => typeof item === 'string') }
      : {}),
    enabled: record.enabled !== false,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
  };
}

async function getProviderAccountsPayload(): Promise<{
  accounts: ProviderConfig[];
  defaultAccountId: string | null;
  statusesById: Map<string, { hasKey: boolean; keyMasked: string | null }>;
}> {
  const client = getRuntimeHostClient();
  const result = await client.request<{
    accounts?: unknown;
    statuses?: unknown;
    defaultAccountId?: unknown;
  }>('GET', '/api/provider-accounts');
  const accounts = Array.isArray(result.data?.accounts)
    ? result.data.accounts
      .map((entry) => toProviderConfig(entry))
      .filter((entry): entry is ProviderConfig => Boolean(entry))
    : [];
  const statusesById = new Map<string, { hasKey: boolean; keyMasked: string | null }>();
  if (Array.isArray(result.data?.statuses)) {
    for (const item of result.data.statuses) {
      const status = asRecord(item);
      if (!status || typeof status.id !== 'string') {
        continue;
      }
      statusesById.set(status.id, {
        hasKey: status.hasKey === true,
        keyMasked: typeof status.keyMasked === 'string' ? status.keyMasked : null,
      });
    }
  }
  return {
    accounts,
    defaultAccountId: typeof result.data?.defaultAccountId === 'string' ? result.data.defaultAccountId : null,
    statusesById,
  };
}

async function updateProviderApiKey(providerId: string, apiKey: string): Promise<boolean> {
  const client = getRuntimeHostClient();
  await client.request('PUT', `/api/provider-accounts/${encodeURIComponent(providerId)}`, {
    updates: {},
    apiKey,
  });
  return true;
}

export async function storeApiKey(providerId: string, apiKey: string): Promise<boolean> {
  try {
    return await updateProviderApiKey(providerId, apiKey);
  } catch (error) {
    console.error('Failed to store API key:', error);
    return false;
  }
}

export async function getApiKey(providerId: string): Promise<string | null> {
  try {
    const client = getRuntimeHostClient();
    const result = await client.request<{ apiKey?: unknown }>('GET', `/api/provider-accounts/${encodeURIComponent(providerId)}/api-key`);
    return typeof result.data?.apiKey === 'string' ? result.data.apiKey : null;
  } catch (error) {
    console.error('Failed to retrieve API key:', error);
    return null;
  }
}

export async function deleteApiKey(providerId: string): Promise<boolean> {
  try {
    const client = getRuntimeHostClient();
    await client.request('DELETE', `/api/provider-accounts/${encodeURIComponent(providerId)}?apiKeyOnly=1`);
    return true;
  } catch (error) {
    console.error('Failed to delete API key:', error);
    return false;
  }
}

export async function hasApiKey(providerId: string): Promise<boolean> {
  const client = getRuntimeHostClient();
  const result = await client.request<{ hasKey?: unknown }>(
    'GET',
    `/api/provider-accounts/${encodeURIComponent(providerId)}/has-api-key`,
  );
  return result.data?.hasKey === true;
}

export async function listStoredKeyIds(): Promise<string[]> {
  const payload = await getProviderAccountsPayload();
  return Array.from(payload.statusesById.entries())
    .filter((entry) => entry[1].hasKey)
    .map((entry) => entry[0]);
}

export async function saveProvider(config: ProviderConfig): Promise<void> {
  const client = getRuntimeHostClient();
  await client.request('POST', '/api/provider-accounts', {
    account: {
      id: config.id,
      vendorId: config.type,
      label: config.name,
      ...(typeof config.baseUrl === 'string' ? { baseUrl: config.baseUrl } : {}),
      ...(typeof config.model === 'string' ? { model: config.model } : {}),
      ...(Array.isArray(config.fallbackModels) ? { fallbackModels: config.fallbackModels } : {}),
      ...(Array.isArray(config.fallbackProviderIds) ? { fallbackAccountIds: config.fallbackProviderIds } : {}),
      enabled: config.enabled,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    },
  });
}

export async function getProvider(providerId: string): Promise<ProviderConfig | null> {
  const client = getRuntimeHostClient();
  const result = await client.request<unknown>('GET', `/api/provider-accounts/${encodeURIComponent(providerId)}`);
  return toProviderConfig(result.data);
}

export async function getAllProviders(): Promise<ProviderConfig[]> {
  const payload = await getProviderAccountsPayload();
  return payload.accounts;
}

export async function deleteProvider(providerId: string): Promise<boolean> {
  try {
    const client = getRuntimeHostClient();
    await client.request('DELETE', `/api/provider-accounts/${encodeURIComponent(providerId)}`);
    return true;
  } catch (error) {
    console.error('Failed to delete provider:', error);
    return false;
  }
}

export async function setDefaultProvider(providerId: string): Promise<void> {
  const client = getRuntimeHostClient();
  await client.request('PUT', '/api/provider-accounts/default', {
    accountId: providerId,
  });
}

export async function getDefaultProvider(): Promise<string | undefined> {
  const payload = await getProviderAccountsPayload();
  return payload.defaultAccountId ?? undefined;
}

export async function getProviderWithKeyInfo(
  providerId: string,
): Promise<(ProviderConfig & { hasKey: boolean; keyMasked: string | null }) | null> {
  const payload = await getProviderAccountsPayload();
  const provider = payload.accounts.find((entry) => entry.id === providerId);
  if (!provider) {
    return null;
  }
  const status = payload.statusesById.get(providerId);
  return {
    ...provider,
    hasKey: status?.hasKey === true,
    keyMasked: status?.keyMasked ?? null,
  };
}

export async function getAllProvidersWithKeyInfo(): Promise<
  Array<ProviderConfig & { hasKey: boolean; keyMasked: string | null }>
> {
  const payload = await getProviderAccountsPayload();
  return payload.accounts.map((provider) => {
    const status = payload.statusesById.get(provider.id);
    return {
      ...provider,
      hasKey: status?.hasKey === true,
      keyMasked: status?.keyMasked ?? null,
    };
  });
}
