import type { OpenClawRuntimeConfigService } from '../openclaw/openclaw-runtime-config-service';
import { normalizeBrowserMode } from '../../shared/browser-mode';
import type { PrelaunchPluginMaintenanceService } from './prelaunch-plugin-maintenance';
import {
  getKeyableProviderTypes,
  getProviderEnvVar,
} from '../providers/provider-registry';
import type { RuntimePluginRepositoryPort } from '../plugins/runtime-plugin-service';
import type { ProviderRuntimeSyncService } from '../providers/store-sync';
import type { ProviderStoreRepository } from '../providers/provider-store-repository';
import type { SettingsRepository } from '../settings/store';
import type { GatewayPrelaunchInput, RuntimeHostBootstrapJobPort } from './bootstrap-jobs';
import type { OpenClawWorkspacePort } from '../openclaw/openclaw-workspace-service';
import type { ProviderStoreRecord } from '../providers/provider-store-repository';
import { normalizeProviderStoreForRuntime } from '../providers/provider-store-model';
import type { SecurityJobPort } from '../security/security-jobs';
import type { RuntimeIdGeneratorPort } from '../common/runtime-ports';

export interface GatewayPrelaunchResult {
  configuredChannels: string[];
}

export interface HostBootstrapSettings {
  launchAtStartup: boolean;
  gatewayAutoStart: boolean;
  gatewayToken: string;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;
}

export interface GatewayLaunchPlan {
  gatewayToken: string;
  providerEnv: Record<string, string>;
  loadedProviderKeyCount: number;
  skipChannels: boolean;
  channelStartupSummary: string;
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

export class RuntimeHostBootstrapService {
  constructor(
    private readonly deps: {
      settingsRepository: Pick<SettingsRepository, 'getAll' | 'setValue'>;
      providerStoreRepository: Pick<ProviderStoreRepository, 'read' | 'write'>;
      runtimeConfig: Pick<
        OpenClawRuntimeConfigService,
        'syncProxy' | 'syncGatewayToken' | 'sanitize' | 'syncBrowserMode' | 'syncSessionIdleMinutes'
      >;
      runtimePlugins: Pick<RuntimePluginRepositoryPort, 'ensureManagedPluginInstalled'>;
      prelaunchPluginMaintenance: Pick<
        PrelaunchPluginMaintenanceService,
        'cleanupStaleBuiltinExtensionsForGatewayLaunch' | 'reconcileConfiguredChannelPluginsForGatewayLaunch' | 'ensureConfiguredManagedPluginsForGatewayLaunch'
      >;
      providerRuntimeSync: Pick<ProviderRuntimeSyncService, 'syncProviderStore'>;
      workspace: Pick<
        OpenClawWorkspacePort,
        'ensureDefaultIdentity' | 'migrateMainAgentTemplatesIfNeeded' | 'mergeContextSnippets'
      >;
      securityJobs: Pick<SecurityJobPort, 'submitPolicySync'>;
      idGenerator: Pick<RuntimeIdGeneratorPort, 'randomHex'>;
      jobs: RuntimeHostBootstrapJobPort;
    },
  ) {}

  submitGatewayPrelaunch(input: GatewayPrelaunchInput) {
    return this.deps.jobs.submitGatewayPrelaunch(input);
  }

  submitProviderAuthBootstrap() {
    return this.deps.jobs.submitProviderAuthBootstrap();
  }

  submitWorkspaceTemplateMigration() {
    return this.deps.jobs.submitWorkspaceTemplateMigration();
  }

  async getHostBootstrapSettings(): Promise<HostBootstrapSettings> {
    const settings = await this.ensureGatewayToken(await this.deps.settingsRepository.getAll());
    return {
      launchAtStartup: settings.launchAtStartup === true,
      gatewayAutoStart: settings.gatewayAutoStart !== false,
      gatewayToken: typeof settings.gatewayToken === 'string' ? settings.gatewayToken : '',
      proxyEnabled: settings.proxyEnabled === true,
      proxyServer: typeof settings.proxyServer === 'string' ? settings.proxyServer : '',
      proxyBypassRules: typeof settings.proxyBypassRules === 'string' ? settings.proxyBypassRules : '',
    };
  }

  async buildGatewayLaunchPlan(): Promise<GatewayLaunchPlan> {
    const settings = await this.ensureGatewayToken(await this.deps.settingsRepository.getAll());
    const providerEnv = await this.buildGatewayProviderEnv();
    await this.deps.prelaunchPluginMaintenance.cleanupStaleBuiltinExtensionsForGatewayLaunch();
    const configuredChannels = await this.deps.prelaunchPluginMaintenance.reconcileConfiguredChannelPluginsForGatewayLaunch();
    return {
      gatewayToken: typeof settings.gatewayToken === 'string' ? settings.gatewayToken : '',
      providerEnv: providerEnv.providerEnv,
      loadedProviderKeyCount: providerEnv.loadedProviderKeyCount,
      skipChannels: configuredChannels.length === 0,
      channelStartupSummary: configuredChannels.length > 0
        ? `enabled(${configuredChannels.join(',')})`
        : 'skipped(no configured channels)',
    };
  }

  async executeGatewayPrelaunch(input: GatewayPrelaunchInput): Promise<GatewayPrelaunchResult> {
    const incoming = input && typeof input === 'object' ? input : {};
    let settings = await this.ensureGatewayToken(await this.deps.settingsRepository.getAll());
    if (typeof incoming.gatewayToken === 'string' && incoming.gatewayToken.trim()) {
      await this.deps.settingsRepository.setValue('gatewayToken', incoming.gatewayToken.trim());
      settings = {
        ...settings,
        gatewayToken: incoming.gatewayToken.trim(),
      };
    }
    const proxyEnabled = typeof incoming.proxyEnabled === 'boolean'
      ? incoming.proxyEnabled
      : settings.proxyEnabled === true;
    const proxyServer = typeof incoming.proxyServer === 'string'
      ? incoming.proxyServer
      : (typeof settings.proxyServer === 'string' ? settings.proxyServer : '');
    const proxyBypassRules = typeof incoming.proxyBypassRules === 'string'
      ? incoming.proxyBypassRules
      : (typeof settings.proxyBypassRules === 'string' ? settings.proxyBypassRules : '');
    await this.deps.runtimeConfig.syncProxy({
      proxyEnabled,
      proxyServer,
      proxyBypassRules,
    }, {
      preserveExistingWhenDisabled: true,
    });

    await this.deps.runtimeConfig.syncGatewayToken(String(settings.gatewayToken));

    await this.deps.workspace.ensureDefaultIdentity();
    await this.deps.runtimeConfig.sanitize();
    const browserMode = normalizeBrowserMode(settings.browserMode);
    if (browserMode === 'relay') {
      await this.deps.runtimePlugins.ensureManagedPluginInstalled('browser-relay');
    }
    await this.deps.runtimeConfig.syncBrowserMode(browserMode);
    await this.deps.runtimeConfig.syncSessionIdleMinutes();
    await this.deps.prelaunchPluginMaintenance.cleanupStaleBuiltinExtensionsForGatewayLaunch();
    const configuredChannels = await this.deps.prelaunchPluginMaintenance.reconcileConfiguredChannelPluginsForGatewayLaunch();
    await this.deps.prelaunchPluginMaintenance.ensureConfiguredManagedPluginsForGatewayLaunch();

    return {
      configuredChannels,
    };
  }

  buildProviderEnvMap() {
    return buildProviderEnvMap();
  }

  async executeProviderAuthBootstrap(): Promise<{
    syncedApiKeyCount: number;
    defaultProviderId?: string;
  }> {
    const store = await this.deps.providerStoreRepository.read();
    const result = await this.deps.providerRuntimeSync.syncProviderStore(store);
    if (result.storeModified) {
      await this.deps.providerStoreRepository.write(store);
    }
    return result;
  }

  async executeWorkspaceTemplateMigration() {
    await this.deps.workspace.ensureDefaultIdentity();
    const migration = await this.deps.workspace.migrateMainAgentTemplatesIfNeeded();
    await this.deps.workspace.mergeContextSnippets();
    return migration;
  }

  onGatewayLifecycle(payload: unknown) {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    if (body.state === 'running') {
      return this.deps.securityJobs.submitPolicySync();
    }
    return null;
  }

  private async buildGatewayProviderEnv(): Promise<{
    providerEnv: Record<string, string>;
    loadedProviderKeyCount: number;
  }> {
    const providerEnv: Record<string, string> = {};
    const store = await this.deps.providerStoreRepository.read();
    const { accounts, storeModified } = normalizeProviderStoreForRuntime(store);
    if (storeModified) {
      await this.deps.providerStoreRepository.write(store);
    }

    const envMap = buildProviderEnvMap().envVarByProviderType;
    let loadedProviderKeyCount = 0;
    const assignKey = (
      providerType: string,
      accountId: string,
      source: ProviderStoreRecord,
    ) => {
      const envVar = envMap[providerType];
      const key = source.apiKeys[accountId];
      if (!envVar || typeof key !== 'string' || !key.trim()) {
        return;
      }
      providerEnv[envVar] = key;
      loadedProviderKeyCount++;
    };

    if (store.defaultAccountId) {
      const defaultAccount = accounts.find((account) => account.accountId === store.defaultAccountId);
      if (defaultAccount) {
        assignKey(defaultAccount.vendorId, defaultAccount.accountId, store);
      }
    }

    for (const account of accounts) {
      assignKey(account.vendorId, account.accountId, store);
    }

    return {
      providerEnv,
      loadedProviderKeyCount,
    };
  }

  private async ensureGatewayToken(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof settings.gatewayToken === 'string' && settings.gatewayToken.trim()) {
      return settings;
    }
    const gatewayToken = `matchaclaw-${this.deps.idGenerator.randomHex(16)}`;
    await this.deps.settingsRepository.setValue('gatewayToken', gatewayToken);
    return {
      ...settings,
      gatewayToken,
    };
  }
}
