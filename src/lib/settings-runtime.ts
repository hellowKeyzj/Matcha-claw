import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';

const SETTINGS_UNAVAILABLE = 'Settings are unavailable';
const SETTINGS_DESIRED_UNAVAILABLE = 'Settings desired is unavailable';
const SETTINGS_DESIRED_OUTCOME_UNKNOWN = 'Settings desired outcome is unknown; the change may still be applying. Refresh settings before retrying.';

let settingsDesiredQueue: Promise<void> = Promise.resolve();

type SettingsBrowserMode = 'native' | 'relay' | 'off';

type SettingsDesiredInput = Readonly<{
  browserMode: SettingsBrowserMode;
  launchAtStartup: boolean;
  gatewayAutoStart: boolean;
  proxy: Readonly<{
    enabled: boolean;
    server: string;
    bypassRules: string;
  }>;
}>;

export type SettingsDesiredReceipt = Readonly<{
  desired: Readonly<{
    revision: number;
    outcome: 'confirmed' | 'outcome_unknown';
  }>;
}>;

type SanitizedProxyIntent = Readonly<{
  enabled: boolean;
  server: string;
  bypassRules: string;
  credentialReference?: unknown;
}>;

type SettingsPublicSnapshot = Readonly<{
  browserMode: SettingsBrowserMode;
  launchAtStartup: boolean;
  gatewayAutoStart: boolean;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;
}>;

async function submitSettingsDesired(input: SettingsDesiredInput): Promise<SettingsDesiredReceipt> {
  const proxy = await invokeIpc<SanitizedProxyIntent>('settings:splitProxyIntent', input.proxy);
  return await hostApiFetch<SettingsDesiredReceipt>('/api/settings/desired', {
    method: 'POST',
    body: JSON.stringify({
      browserMode: input.browserMode,
      launchAtStartup: input.launchAtStartup,
      gatewayAutoStart: input.gatewayAutoStart,
      proxyEnabled: proxy.enabled,
      proxyServer: proxy.server,
      proxyBypassRules: proxy.bypassRules,
    }),
  });
}

export async function hostSettingsFetchAll<TSettings extends Record<string, unknown>>() {
  return await hostApiFetch<TSettings>('/api/settings');
}

export function hostSettingsPutPatch(patch: Record<string, unknown>): Promise<SettingsDesiredReceipt> {
  const operation = settingsDesiredQueue.then(async () => {
    const current = await hostSettingsFetchAll<SettingsPublicSnapshot>().catch(() => {
      throw new Error(SETTINGS_UNAVAILABLE);
    });
    const input: SettingsDesiredInput = {
      browserMode: patch.browserMode === undefined ? current.browserMode : patch.browserMode as SettingsBrowserMode,
      launchAtStartup: patch.launchAtStartup === undefined ? current.launchAtStartup : patch.launchAtStartup as boolean,
      gatewayAutoStart: patch.gatewayAutoStart === undefined ? current.gatewayAutoStart : patch.gatewayAutoStart as boolean,
      proxy: {
        enabled: patch.proxyEnabled === undefined ? current.proxyEnabled : patch.proxyEnabled as boolean,
        server: patch.proxyServer === undefined ? current.proxyServer : patch.proxyServer as string,
        bypassRules: patch.proxyBypassRules === undefined ? current.proxyBypassRules : patch.proxyBypassRules as string,
      },
    };
    if (!isSettingsDesiredInput(input)) {
      throw new Error(SETTINGS_DESIRED_UNAVAILABLE);
    }
    const receipt = await submitSettingsDesired(input);
    if (receipt.desired.outcome !== 'confirmed') {
      throw new Error(SETTINGS_DESIRED_OUTCOME_UNKNOWN);
    }
    return receipt;
  });
  settingsDesiredQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

function isSettingsDesiredInput(value: SettingsDesiredInput): value is SettingsDesiredInput {
  return (value.browserMode === 'native' || value.browserMode === 'relay' || value.browserMode === 'off')
    && typeof value.launchAtStartup === 'boolean'
    && typeof value.gatewayAutoStart === 'boolean'
    && typeof value.proxy.enabled === 'boolean'
    && typeof value.proxy.server === 'string'
    && typeof value.proxy.bypassRules === 'string';
}
