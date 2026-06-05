import {
  getProviderEnvVar,
} from '../../../providers/provider-registry';
import type { OpenClawProviderConfigWorkflow } from '../workflows/openclaw-provider/openclaw-provider-config-workflow';
import type { RuntimeConfigProviderOverride } from './openclaw-provider-entry-builder';

export class OpenClawProviderConfigService {
  constructor(
    private readonly configWorkflow: Pick<OpenClawProviderConfigWorkflow, 'syncProviderConfig' | 'removeProvider'>,
  ) {}

  async syncProviderConfig(
    provider: string,
    override: RuntimeConfigProviderOverride,
  ): Promise<void> {
    await this.configWorkflow.syncProviderConfig(provider, override);
  }

  async removeProvider(provider: string): Promise<void> {
    await this.configWorkflow.removeProvider(provider);
  }
}

export function buildProviderEnvVars(providers: Array<{ type: string; apiKey: string }>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { type, apiKey } of providers) {
    const envVar = getProviderEnvVar(type);
    if (envVar && apiKey) {
      env[envVar] = apiKey;
    }
  }
  return env;
}

export { getProviderEnvVar } from '../../../providers/provider-registry';
