import { normalizeBrowserMode } from '../../shared/browser-mode';
import type { OpenClawRuntimeConfigService } from '../openclaw/openclaw-runtime-config-service';
import {
  accepted,
  ok,
  type ApplicationResponse,
} from '../common/application-response';
import type { RuntimePluginRepositoryPort } from '../plugins/runtime-plugin-service';
import type { GatewayControlPort } from '../runtime-host/parent-shell-port';
import type { SettingsJobPort, SettingsRuntimeConfigSyncPayload } from './settings-jobs';
import type { SettingsRepository } from './store';

interface SettingsServiceDeps {
  repository: Pick<SettingsRepository, 'getAll' | 'patch' | 'reset' | 'setValue'>;
  runtimeConfig?: Pick<OpenClawRuntimeConfigService, 'syncProxy' | 'syncBrowserMode'>;
  runtimePlugins?: Pick<RuntimePluginRepositoryPort, 'ensureManagedPluginInstalled'>;
  gatewayControl?: GatewayControlPort;
  jobs: SettingsJobPort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExplicitProxyPatch(payload: unknown): boolean {
  if (!isRecord(payload)) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(payload, 'proxyEnabled')
    || Object.prototype.hasOwnProperty.call(payload, 'proxyServer')
    || Object.prototype.hasOwnProperty.call(payload, 'proxyBypassRules');
}

function hasExplicitBrowserModePatch(payload: unknown): boolean {
  return isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, 'browserMode');
}

function hasRuntimeConfigSyncWork(payload: Pick<SettingsRuntimeConfigSyncPayload, 'syncProxy' | 'syncBrowserMode'>): boolean {
  return payload.syncProxy || payload.syncBrowserMode;
}

function toProxySettings(settings: Record<string, unknown>): {
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;
} {
  return {
    proxyEnabled: settings.proxyEnabled === true,
    proxyServer: typeof settings.proxyServer === 'string' ? settings.proxyServer : '',
    proxyBypassRules: typeof settings.proxyBypassRules === 'string' ? settings.proxyBypassRules : '',
  };
}

export class SettingsService {
  constructor(private readonly deps: SettingsServiceDeps) {}

  async getAll() {
    return await this.deps.repository.getAll();
  }

  async patch(payload: unknown): Promise<ApplicationResponse> {
    const patch = isRecord(payload) ? payload : {};
    const shouldSyncProxy = hasExplicitProxyPatch(patch);
    const shouldSyncBrowserMode = hasExplicitBrowserModePatch(patch);
    await this.deps.repository.patch(patch);
    const latestSettings = shouldSyncProxy || shouldSyncBrowserMode
      ? await this.deps.repository.getAll()
      : null;
    const syncPayload = {
      settings: latestSettings ?? {},
      syncProxy: shouldSyncProxy,
      syncBrowserMode: shouldSyncBrowserMode,
    };
    if (hasRuntimeConfigSyncWork(syncPayload)) {
      return accepted(this.deps.jobs.submitRuntimeConfigSync(syncPayload));
    }
    return ok({ success: true });
  }

  async reset(): Promise<ApplicationResponse> {
    const settings = await this.deps.repository.reset();
    return ok({ success: true, settings });
  }

  async getValue(key: string) {
    const settings = await this.deps.repository.getAll();
    return { value: settings[key] };
  }

  async setValue(key: string, payload: unknown): Promise<ApplicationResponse> {
    const body = isRecord(payload) ? payload : {};
    await this.deps.repository.setValue(key, body.value);
    const shouldSyncProxy = key === 'proxyEnabled' || key === 'proxyServer' || key === 'proxyBypassRules';
    const shouldSyncBrowserMode = key === 'browserMode';
    if (shouldSyncProxy || shouldSyncBrowserMode) {
      const latestSettings = await this.deps.repository.getAll();
      return accepted(this.deps.jobs.submitRuntimeConfigSync({
          settings: latestSettings,
          syncProxy: shouldSyncProxy,
          syncBrowserMode: shouldSyncBrowserMode,
        }));
    }
    return ok({ success: true });
  }

  async executeRuntimeConfigSync(payload: SettingsRuntimeConfigSyncPayload): Promise<{ success: true }> {
    if (payload.syncProxy && this.deps.runtimeConfig) {
      await this.deps.runtimeConfig.syncProxy(
        toProxySettings(payload.settings),
        { preserveExistingWhenDisabled: false },
      );
    }
    if (payload.syncBrowserMode) {
      await this.syncBrowserModeAndRestart(payload.settings);
    }
    return { success: true };
  }

  private async syncBrowserModeAndRestart(settings: Record<string, unknown>): Promise<void> {
    if (!this.deps.runtimeConfig) {
      return;
    }
    const browserMode = normalizeBrowserMode(settings.browserMode);
    if (browserMode === 'relay') {
      await this.deps.runtimePlugins?.ensureManagedPluginInstalled('browser-relay');
    }
    await this.deps.runtimeConfig.syncBrowserMode(browserMode);
    if (!this.deps.gatewayControl) {
      return;
    }
    const restartResponse = await this.deps.gatewayControl.restartGateway();
    if (!restartResponse.success) {
      throw new Error(restartResponse.error?.message ?? 'gateway restart failed');
    }
  }
}
