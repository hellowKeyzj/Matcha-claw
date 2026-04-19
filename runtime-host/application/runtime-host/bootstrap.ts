import {
  sanitizeOpenClawConfig,
  normalizeBrowserMode,
  syncBrowserModeToOpenClaw,
  syncGatewayTokenToConfig,
  syncSessionIdleMinutesToOpenClaw,
} from '../openclaw/openclaw-provider-config-service';
import { syncProxyConfigToOpenClaw } from '../openclaw/openclaw-proxy-sync';
import { listConfiguredChannelsLocal } from '../channels/channel-runtime';
import {
  getKeyableProviderTypes,
  getProviderEnvVar,
} from '../providers/provider-registry';
import { syncProviderStoreToOpenClaw } from '../providers/store-sync';
import { readProviderStoreLocal, writeProviderStoreLocal } from '../../api/storage/provider-store';
import { getAllSettingsLocal } from '../settings/store';

type GatewaySyncInput = {
  gatewayToken?: string;
  proxyEnabled?: boolean;
  proxyServer?: string;
  proxyBypassRules?: string;
};

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
  const settings = await getAllSettingsLocal();
  await syncBrowserModeToOpenClaw(normalizeBrowserMode(settings.browserMode));
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
  const result = await syncProviderStoreToOpenClaw(store);
  if (result.storeModified) {
    await writeProviderStoreLocal(store);
  }
  return result;
}
