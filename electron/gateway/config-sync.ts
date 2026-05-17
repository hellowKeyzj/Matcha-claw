import { app } from 'electron';
import path from 'path';
import { existsSync } from 'fs';
import { getOpenClawDir, getOpenClawEntryPath, isOpenClawPresent } from '../utils/paths';
import { getUvMirrorEnv } from '../utils/uv-env';
import { buildProxyEnv, resolveProxySettings } from '../utils/proxy';
import { prependPathEntry } from '../utils/env-path';
import { createDefaultRuntimeHostHttpClient } from '../main/runtime-host-client';
import { stripSystemdSupervisorEnv } from './config-sync-env';
import { waitForRuntimeHostJob, type RuntimeHostJobSnapshot } from '../main/runtime-host-jobs';
import type { RuntimeHostManager } from '../main/runtime-host-manager';

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

type GatewayLaunchSettings = {
  gatewayToken: string;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;
};

type GatewayLaunchPlan = {
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

export async function prepareGatewayRuntimeBeforeLaunch(
  runtimeHost: RuntimeHostManager,
  _appSettings?: GatewayLaunchSettings,
): Promise<void> {
  const runtimeHostClient = createGatewayConfigRuntimeHostClient();
  const response = await runtimeHostClient.request<{
    success?: boolean;
    job?: RuntimeHostJobSnapshot;
  }>('POST', '/api/runtime-host/prepare-gateway-launch');
  const job = response.data?.job;
  if (!job?.id) {
    throw new Error('Runtime Host did not return a gateway prelaunch job');
  }
  await waitForRuntimeHostJob(runtimeHost, job.id, {
    timeoutMs: 120_000,
  });
}

async function loadGatewayLaunchPlan(): Promise<GatewayLaunchPlan> {
  const runtimeHostClient = createGatewayConfigRuntimeHostClient();
  const response = await runtimeHostClient.request<{
    success?: boolean;
    plan?: Partial<GatewayLaunchPlan>;
  }>('GET', '/api/runtime-host/gateway-launch-plan');
  const plan = response.data?.plan;
  if (!plan || typeof plan !== 'object') {
    throw new Error('Runtime Host did not return gateway launch plan');
  }
  return {
    gatewayToken: typeof plan.gatewayToken === 'string' ? plan.gatewayToken : '',
    providerEnv: plan.providerEnv && typeof plan.providerEnv === 'object' && !Array.isArray(plan.providerEnv)
      ? Object.fromEntries(
        Object.entries(plan.providerEnv).filter((entry): entry is [string, string] => (
          typeof entry[0] === 'string' && typeof entry[1] === 'string'
        )),
      )
      : {},
    loadedProviderKeyCount: typeof plan.loadedProviderKeyCount === 'number' ? plan.loadedProviderKeyCount : 0,
    skipChannels: plan.skipChannels === true,
    channelStartupSummary: typeof plan.channelStartupSummary === 'string' ? plan.channelStartupSummary : 'enabled(unknown)',
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

export async function prepareGatewayLaunchContext(
  port: number,
  runtimeHost: RuntimeHostManager,
): Promise<GatewayLaunchContext> {
  const openclawDir = getOpenClawDir();
  const entryScript = getOpenClawEntryPath();

  if (!isOpenClawPresent()) {
    throw new Error(`OpenClaw package not found at: ${openclawDir}`);
  }

  const appSettings = await loadHostBootstrapSettings();
  await prepareGatewayRuntimeBeforeLaunch(runtimeHost, appSettings);
  const launchPlan = await loadGatewayLaunchPlan();

  if (!existsSync(entryScript)) {
    throw new Error(`OpenClaw entry script not found at: ${entryScript}`);
  }

  const gatewayArgs = ['gateway', '--port', String(port), '--token', appSettings.gatewayToken, '--allow-unconfigured'];
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
    OPENCLAW_GATEWAY_TOKEN: appSettings.gatewayToken,
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
