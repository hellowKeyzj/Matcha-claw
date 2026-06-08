import {
  ok,
  type ApplicationResponse,
} from '../common/application-response';
import type { SettingsRuntimeConfigSyncWorkflow } from '../workflows/settings-runtime-config/settings-runtime-config-sync-workflow';
import type { SettingsRuntimeConfigSyncPayload } from './settings-jobs';
import type { SettingsRepository } from './store';

export interface SettingsRuntimeConfigPort {
  syncProxy(input: {
    proxyEnabled: boolean;
    proxyServer: string;
    proxyBypassRules: string;
  }, options: { preserveExistingWhenDisabled?: boolean }): Promise<void>;
  syncBrowserMode(browserMode: string): Promise<void>;
}

interface SettingsServiceDeps {
  repository: Pick<SettingsRepository, 'getAll' | 'reset'>;
  runtimeConfigSyncWorkflow: Pick<SettingsRuntimeConfigSyncWorkflow, 'patch' | 'setValue' | 'execute' | 'reset'>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class SettingsService {
  constructor(private readonly deps: SettingsServiceDeps) {}

  async getAll() {
    return await this.deps.repository.getAll();
  }

  async patch(payload: unknown): Promise<ApplicationResponse> {
    return await this.deps.runtimeConfigSyncWorkflow.patch(payload);
  }

  async reset(): Promise<ApplicationResponse> {
    const settings = await this.deps.repository.reset();
    await this.deps.runtimeConfigSyncWorkflow.reset(settings);
    return ok({ success: true, settings });
  }

  async getValue(key: string) {
    const settings = await this.deps.repository.getAll();
    return { value: settings[key] };
  }

  async setValue(key: string, payload: unknown): Promise<ApplicationResponse> {
    const body = isRecord(payload) ? payload : {};
    return await this.deps.runtimeConfigSyncWorkflow.setValue(key, body.value);
  }

  async executeRuntimeConfigSync(payload: SettingsRuntimeConfigSyncPayload): Promise<{ success: true }> {
    return await this.deps.runtimeConfigSyncWorkflow.execute(payload);
  }
}
