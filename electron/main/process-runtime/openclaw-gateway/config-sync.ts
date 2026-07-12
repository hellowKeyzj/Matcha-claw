import { app } from 'electron';
import path from 'path';
import { existsSync } from 'fs';
import { getOpenClawDir, getOpenClawEntryPath, isOpenClawPresent } from '../../../utils/paths';
import { getUvMirrorEnv } from '../../../utils/uv-env';
import { buildProxyEnv, resolveProxySettings } from '../../../utils/proxy';
import { prependPathEntry } from '../../../utils/env-path';
import { createDefaultRuntimeHostHttpClient } from '../../runtime-host-client';
import { stripSystemdSupervisorEnv } from './config-sync-env';
import { waitForRuntimeHostJob, type RuntimeHostJobSnapshot } from '../../runtime-host-jobs';
import type { RuntimeHostManager } from '../../runtime-host-manager';
import { createRuntimeHostCapabilityPayload, resolveRuntimeHostEndpoint } from '../../runtime-host-capabilities';

function createGatewayConfigRuntimeHostClient() {
  return createDefaultRuntimeHostHttpClient({
    timeoutMs: 8_000,
  });
}

export interface GatewayLaunchContext {
  openclawDir: string;
  entryScript: string;
  gatewayArgs: string[];
  forkEnv: Record<string, string | undefined>;
  mode: 'dev' | 'packaged';
  binPathExists: boolean;
  loadedProviderKeyCount: number;
  proxySummary: string;
  channelStartupSummary: string;
}

export type GatewayLaunchSettings = {
  gatewayToken: string;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;
};

export type GatewayLaunchPlan = {
  gatewayToken: string;
  providerEnv: Record<string, string>;
  loadedProviderKeyCount: number;
  skipChannels: boolean;
  channelStartupSummary: string;
};

type HostBootstrapSettings = GatewayLaunchSettings & {
  gatewayAutoStart: boolean;
  launchAtStartup: boolean;
};

type GatewayPrelaunchResult = {
  configuredChannels: string[];
  launchPlan: GatewayLaunchPlan;
};

export async function prepareGatewayRuntimeBeforeLaunch(
  runtimeHost: RuntimeHostManager,
  _appSettings?: GatewayLaunchSettings,
): Promise<GatewayLaunchPlan> {
  const runtimeHostClient = createGatewayConfigRuntimeHostClient();
  const endpoint = await resolveRuntimeHostEndpoint(runtimeHostClient);
  const response = await runtimeHostClient.request<{
    success?: boolean;
    job?: RuntimeHostJobSnapshot<GatewayPrelaunchResult>;
  }>(
    'POST',
    '/api/capabilities/execute',
    await createRuntimeHostCapabilityPayload(runtimeHostClient, 'runtimeHost.prepareGatewayLaunch', {}, { endpoint }),
  );
  const job = response.data?.job;
  if (!job?.id) {
    throw new Error('Runtime Host did not return a gateway prelaunch job');
  }
  const completedJob = await waitForRuntimeHostJob<GatewayPrelaunchResult>(runtimeHost, job.id, {
    timeoutMs: 120_000,
  });
  const launchPlan = completedJob.result?.launchPlan;
  if (!launchPlan || typeof launchPlan !== 'object') {
    throw new Error('Runtime Host prelaunch job did not return a gateway launch plan');
  }
  return {
    gatewayToken: typeof launchPlan.gatewayToken === 'string' ? launchPlan.gatewayToken : '',
    providerEnv: launchPlan.providerEnv && typeof launchPlan.providerEnv === 'object' && !Array.isArray(launchPlan.providerEnv)
      ? Object.fromEntries(
        Object.entries(launchPlan.providerEnv).filter((entry): entry is [string, string] => (
          typeof entry[0] === 'string' && typeof entry[1] === 'string'
        )),
      )
      : {},
    loadedProviderKeyCount: typeof launchPlan.loadedProviderKeyCount === 'number' ? launchPlan.loadedProviderKeyCount : 0,
    skipChannels: launchPlan.skipChannels === true,
    channelStartupSummary: typeof launchPlan.channelStartupSummary === 'string' ? launchPlan.channelStartupSummary : 'enabled(unknown)',
  };
}

export async function loadHostBootstrapSettings(): Promise<HostBootstrapSettings> {
  const runtimeHostClient = createGatewayConfigRuntimeHostClient();
  const response = await runtimeHostClient.request<{
    success?: boolean;
    settings?: Partial<HostBootstrapSettings>;
  }>('GET', '/api/runtime-host/host-bootstrap-settings');
  const settings = response.data?.settings;
  if (!settings || typeof settings !== 'object') {
    throw new Error('Runtime Host did not return host bootstrap settings');
  }
  return {
    launchAtStartup: settings.launchAtStartup === true,
    gatewayAutoStart: settings.gatewayAutoStart !== false,
    gatewayToken: typeof settings.gatewayToken === 'string' ? settings.gatewayToken : '',
    proxyEnabled: settings.proxyEnabled === true,
    proxyServer: typeof settings.proxyServer === 'string' ? settings.proxyServer : '',
    proxyBypassRules: typeof settings.proxyBypassRules === 'string' ? settings.proxyBypassRules : '',
  };
}

export async function createGatewayLaunchContext(
  port: number,
  launchPlan: GatewayLaunchPlan,
  appSettings: GatewayLaunchSettings,
): Promise<GatewayLaunchContext> {
  const openclawDir = getOpenClawDir();
  const entryScript = getOpenClawEntryPath();

  if (!isOpenClawPresent()) {
    throw new Error(`OpenClaw package not found at: ${openclawDir}`);
  }

  if (!existsSync(entryScript)) {
    throw new Error(`OpenClaw entry script not found at: ${entryScript}`);
  }

  const gatewayToken = launchPlan.gatewayToken;
  if (!gatewayToken) {
    throw new Error('Runtime Host prelaunch job did not return a gateway token');
  }
  const gatewayArgs = ['gateway', '--port', String(port), '--token', gatewayToken, '--allow-unconfigured'];
  const mode = app.isPackaged ? 'packaged' : 'dev';

  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const binPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(process.cwd(), 'resources', 'bin', target);
  const binPathExists = existsSync(binPath);

  const { providerEnv, loadedProviderKeyCount, skipChannels, channelStartupSummary } = launchPlan;
  const uvEnv = await getUvMirrorEnv();
  const proxyEnv = buildProxyEnv(appSettings);
  const resolvedProxy = resolveProxySettings(appSettings);
  const proxySummary = appSettings.proxyEnabled
    ? `http=${resolvedProxy.httpProxy || '-'}, https=${resolvedProxy.httpsProxy || '-'}, all=${resolvedProxy.allProxy || '-'}`
    : 'disabled';

  const { NODE_OPTIONS: _nodeOptions, ...baseEnv } = process.env;
  const baseEnvRecord = baseEnv as Record<string, string | undefined>;
  const baseEnvPatched = binPathExists
    ? prependPathEntry(baseEnvRecord, binPath).env
    : baseEnvRecord;
  const forkEnv: Record<string, string | undefined> = {
    ...stripSystemdSupervisorEnv(baseEnvPatched),
    ...providerEnv,
    ...uvEnv,
    ...proxyEnv,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(port),
    MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: gatewayToken,
    OPENCLAW_SKIP_CHANNELS: skipChannels ? '1' : '',
    CLAWDBOT_SKIP_CHANNELS: skipChannels ? '1' : '',
    OPENCLAW_NO_RESPAWN: '1',
  };

  return {
    openclawDir,
    entryScript,
    gatewayArgs,
    forkEnv,
    mode,
    binPathExists,
    loadedProviderKeyCount,
    proxySummary,
    channelStartupSummary,
  };
}
