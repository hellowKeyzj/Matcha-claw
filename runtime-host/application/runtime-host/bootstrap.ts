import {
  sanitizeOpenClawConfig,
  setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride,
  syncBrowserConfigToOpenClaw,
  syncGatewayTokenToConfig,
  syncSessionIdleMinutesToOpenClaw,
} from '../openclaw/openclaw-provider-config-service';
import { syncProxyConfigToOpenClaw } from '../openclaw/openclaw-proxy-sync';
import { listConfiguredChannelsLocal } from '../channels/channel-runtime';
import {
  getKeyableProviderTypes,
  getProviderEnvVar,
} from '../providers/provider-registry';
import { getOpenClawProviderKey } from '../providers/provider-runtime-rules';
import { saveProviderKeyToOpenClaw } from '../openclaw/openclaw-auth-profile-store';
import { readProviderStoreLocal } from '../../api/storage/provider-store';

type GatewaySyncInput = {
  gatewayToken?: string;
  proxyEnabled?: boolean;
  proxyServer?: string;
  proxyBypassRules?: string;
};

type ProviderStoreAccount = {
  id?: unknown;
  vendorId?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  apiProtocol?: unknown;
  headers?: unknown;
  fallbackModels?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function normalizeFallbackModelRefs(providerKey: string, fallbackModels: unknown): string[] {
  const normalized: string[] = [];
  for (const model of toStringArray(fallbackModels)) {
    normalized.push(model.startsWith(`${providerKey}/`) ? model : `${providerKey}/${model}`);
  }
  return normalized;
}

function normalizeProviderProtocol(
  protocol: unknown,
): 'openai-completions' | 'openai-responses' | 'anthropic-messages' {
  if (protocol === 'openai-responses') {
    return 'openai-responses';
  }
  if (protocol === 'anthropic-messages') {
    return 'anthropic-messages';
  }
  return 'openai-completions';
}

function normalizeProviderHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(headers as Record<string, unknown>)
      .filter(
        ([key, value]): value is string =>
          typeof key === 'string'
          && key.trim().length > 0
          && typeof value === 'string'
          && value.trim().length > 0,
      )
      .map(([key, value]) => [key, value.trim()]),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeProviderBaseUrl(
  vendorId: string,
  baseUrl: unknown,
  apiProtocol: 'openai-completions' | 'openai-responses' | 'anthropic-messages',
): string | undefined {
  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    return undefined;
  }

  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (vendorId !== 'custom' && vendorId !== 'ollama') {
    return normalized;
  }

  if (apiProtocol === 'openai-responses') {
    return normalized.replace(/\/responses?$/i, '');
  }
  if (apiProtocol === 'anthropic-messages') {
    return normalized.replace(/\/v1\/messages$/i, '').replace(/\/messages$/i, '');
  }
  return normalized.replace(/\/chat\/completions$/i, '');
}

export async function syncGatewayConfigLocal(input: GatewaySyncInput): Promise<{
  configuredChannels: string[];
}> {
  await syncProxyConfigToOpenClaw({
    proxyEnabled: input.proxyEnabled === true,
    proxyServer: typeof input.proxyServer === 'string' ? input.proxyServer : '',
    proxyBypassRules: typeof input.proxyBypassRules === 'string' ? input.proxyBypassRules : '',
  }, {
    preserveExistingWhenDisabled: true,
  });

  if (typeof input.gatewayToken === 'string') {
    await syncGatewayTokenToConfig(input.gatewayToken);
  }

  await sanitizeOpenClawConfig();
  await syncBrowserConfigToOpenClaw();
  await syncSessionIdleMinutesToOpenClaw();

  return {
    configuredChannels: await listConfiguredChannelsLocal(),
  };
}

export function buildProviderEnvMap() {
  const envVarByProviderType: Record<string, string> = {};
  const keyableProviderTypes = getKeyableProviderTypes();
  for (const providerType of keyableProviderTypes) {
    const envVar = getProviderEnvVar(providerType);
    if (envVar) {
      envVarByProviderType[providerType] = envVar;
    }
  }
  return {
    keyableProviderTypes,
    envVarByProviderType,
  };
}

export async function syncProviderAuthBootstrapLocal(): Promise<{
  syncedApiKeyCount: number;
  defaultProviderId?: string;
}> {
  const store = await readProviderStoreLocal();
  const accounts = isRecord(store.accounts) ? store.accounts : {};
  const apiKeys = isRecord(store.apiKeys) ? store.apiKeys : {};
  let syncedApiKeyCount = 0;

  for (const [accountId, rawAccount] of Object.entries(accounts)) {
    if (!isRecord(rawAccount)) {
      continue;
    }
    const account = rawAccount as ProviderStoreAccount;
    const vendorId = typeof account.vendorId === 'string' ? account.vendorId : '';
    if (!vendorId) {
      continue;
    }
    const apiKey = typeof apiKeys[accountId] === 'string' ? apiKeys[accountId].trim() : '';
    if (!apiKey) {
      continue;
    }
    await saveProviderKeyToOpenClaw(getOpenClawProviderKey(vendorId, accountId), apiKey);
    syncedApiKeyCount += 1;
  }

  const defaultProviderId = typeof store.defaultAccountId === 'string'
    ? store.defaultAccountId
    : undefined;
  if (defaultProviderId && isRecord(accounts[defaultProviderId])) {
    const account = accounts[defaultProviderId] as ProviderStoreAccount;
    const vendorId = typeof account.vendorId === 'string' ? account.vendorId : '';
    if (vendorId) {
      const providerKey = getOpenClawProviderKey(vendorId, defaultProviderId);
      const model = typeof account.model === 'string' ? account.model : undefined;
      const fallbackModels = normalizeFallbackModelRefs(providerKey, account.fallbackModels);
      if (vendorId === 'custom' || vendorId === 'ollama') {
        const protocol = normalizeProviderProtocol(account.apiProtocol);
        await setOpenClawDefaultModelWithOverride(providerKey, model, {
          baseUrl: normalizeProviderBaseUrl(vendorId, account.baseUrl, protocol),
          api: protocol,
          headers: normalizeProviderHeaders(account.headers),
        }, fallbackModels);
      } else {
        await setOpenClawDefaultModel(providerKey, model, fallbackModels);
      }
    }
  }

  return {
    syncedApiKeyCount,
    ...(defaultProviderId ? { defaultProviderId } : {}),
  };
}
