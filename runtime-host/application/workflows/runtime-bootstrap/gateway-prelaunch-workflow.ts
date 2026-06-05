import { normalizeBrowserMode } from '../../../shared/browser-mode';
import type { PrelaunchPluginMaintenanceService } from '../../runtime-host/prelaunch-plugin-maintenance';
import {
  getKeyableProviderTypes,
  getProviderEnvVar,
} from '../../providers/provider-registry';
import type { RuntimePluginRepositoryPort } from '../../plugins/runtime-plugin-service';
import type { ProviderProjectionSyncService } from '../../providers/store-sync';
import type { ProviderModelsApplicationService } from '../../providers/provider-models-service';
import type { CapabilityRoutingApplicationService } from '../../providers/capability-routing-service';
import type { ProviderStoreRepository, ProviderStoreRecord } from '../../providers/provider-store-repository';
import type { SettingsRepository } from '../../settings/store';
import type { GatewayPrelaunchInput } from '../../runtime-host/bootstrap-jobs';
import { normalizeProviderStoreForProjection, type ProviderProjectionKeyResolverPort } from '../../providers/provider-store-model';
import type { SecurityPluginConfigApplier } from '../../security/security-plugin-config-applier';
import type { RuntimeIdGeneratorPort } from '../../common/runtime-ports';
import type { RuntimeHostRuntimeConfigPort, RuntimeHostWorkspaceBootstrapPort } from '../../runtime-host/bootstrap';

export interface GatewayPrelaunchResult {
  configuredChannels: string[];
  launchPlan: GatewayLaunchPlan;
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

export interface GatewayPrelaunchWorkflowDeps {
  readonly settingsRepository: Pick<SettingsRepository, 'getAll' | 'setValue'>;
  readonly providerStoreRepository: Pick<ProviderStoreRepository, 'read' | 'write'>;
  readonly runtimeConfig: RuntimeHostRuntimeConfigPort;
  readonly runtimePlugins: Pick<RuntimePluginRepositoryPort, 'ensureManagedPluginInstalled'>;
  readonly prelaunchPluginMaintenance: Pick<
    PrelaunchPluginMaintenanceService,
    'cleanupStaleBuiltinExtensionsForGatewayLaunch' | 'reconcileConfiguredChannelPluginsForGatewayLaunch' | 'ensureConfiguredManagedPluginsForGatewayLaunch'
  >;
  readonly providerProjectionSync: Pick<ProviderProjectionSyncService, 'syncProviderStore'>;
  readonly providerProjectionKeys: ProviderProjectionKeyResolverPort;
  readonly providerModels: Pick<ProviderModelsApplicationService, 'syncRuntimeProjection'>;
  readonly capabilityRouting: Pick<CapabilityRoutingApplicationService, 'syncRuntimeProjection'>;
  readonly workspace: RuntimeHostWorkspaceBootstrapPort;
  readonly securityPluginConfig: Pick<SecurityPluginConfigApplier, 'applySavedPolicyToPluginConfig'>;
  readonly idGenerator: Pick<RuntimeIdGeneratorPort, 'randomHex'>;
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

export class GatewayPrelaunchWorkflow {
  constructor(private readonly deps: GatewayPrelaunchWorkflowDeps) {}

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
    await this.deps.prelaunchPluginMaintenance.cleanupStaleBuiltinExtensionsForGatewayLaunch();
    const configuredChannels = await this.deps.prelaunchPluginMaintenance.reconcileConfiguredChannelPluginsForGatewayLaunch();
    return await this.buildGatewayLaunchPlanFromState(settings, configuredChannels);
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
    await this.syncRuntimeConfigForLaunch(incoming, settings);
    await this.deps.workspace.ensureDefaultIdentity();
    await this.deps.runtimeConfig.sanitize();
    await this.syncBrowserMode(settings);
    await this.deps.runtimeConfig.syncSessionIdleMinutes();
    await this.deps.prelaunchPluginMaintenance.cleanupStaleBuiltinExtensionsForGatewayLaunch();
    const configuredChannels = await this.deps.prelaunchPluginMaintenance.reconcileConfiguredChannelPluginsForGatewayLaunch();
    await this.deps.prelaunchPluginMaintenance.ensureConfiguredManagedPluginsForGatewayLaunch();
    await this.syncProviderStackToRuntime();
    await this.deps.securityPluginConfig.applySavedPolicyToPluginConfig();

    return {
      configuredChannels,
      launchPlan: await this.buildGatewayLaunchPlanFromState(settings, configuredChannels),
    };
  }

  async executeProviderAuthBootstrap(): Promise<{ syncedApiKeyCount: number }> {
    return await this.syncProviderStackToRuntime();
  }

  async executeWorkspaceTemplateMigration() {
    await this.deps.workspace.ensureDefaultIdentity();
    const migration = await this.deps.workspace.migrateMainAgentTemplatesIfNeeded();
    await this.deps.workspace.mergeContextSnippets();
    return migration;
  }

  private async syncRuntimeConfigForLaunch(
    incoming: GatewayPrelaunchInput,
    settings: Record<string, unknown>,
  ): Promise<void> {
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
  }

  private async syncBrowserMode(settings: Record<string, unknown>): Promise<void> {
    const browserMode = normalizeBrowserMode(settings.browserMode);
    if (browserMode === 'relay') {
      await this.deps.runtimePlugins.ensureManagedPluginInstalled('browser-relay');
    }
    await this.deps.runtimeConfig.syncBrowserMode(browserMode);
  }

  private async buildGatewayLaunchPlanFromState(
    settings: Record<string, unknown>,
    configuredChannels: string[],
  ): Promise<GatewayLaunchPlan> {
    const providerEnv = await this.buildGatewayProviderEnv();
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

  private async buildGatewayProviderEnv(): Promise<{
    providerEnv: Record<string, string>;
    loadedProviderKeyCount: number;
  }> {
    const providerEnv: Record<string, string> = {};
    const store = await this.deps.providerStoreRepository.read();
    const { accounts, storeModified } = normalizeProviderStoreForProjection(store, this.deps.providerProjectionKeys);
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

    for (const account of accounts) {
      assignKey(account.vendorId, account.accountId, store);
    }

    return { providerEnv, loadedProviderKeyCount };
  }

  private async syncProviderStackToRuntime(): Promise<{ syncedApiKeyCount: number }> {
    const store = await this.deps.providerStoreRepository.read();
    const result = await this.deps.providerProjectionSync.syncProviderStore(store);
    if (result.storeModified) {
      await this.deps.providerStoreRepository.write(store);
    }
    await this.deps.providerModels.syncRuntimeProjection();
    await this.deps.capabilityRouting.syncRuntimeProjection();
    return { syncedApiKeyCount: result.syncedApiKeyCount };
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
