import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';
import {
  cleanupPluginContainer,
  cloneConfig,
  cloneNormalizedPluginEntries,
  isRecord,
} from '../openclaw/openclaw-plugin-config-model';
import type { SecurityPolicyRepository } from './security-policy-store';

const SECURITY_CORE_PLUGIN_ID = 'security-core';

export class SecurityPluginConfigApplier {
  constructor(
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly policyRepository: Pick<SecurityPolicyRepository, 'read'>,
  ) {}

  async applySavedPolicyToPluginConfig(): Promise<void> {
    const policy = await this.policyRepository.read();
    await this.configRepository.update((config) => {
      const nextConfig = cloneConfig(config);
      const plugins = isRecord(nextConfig.plugins) ? { ...nextConfig.plugins } : {};
      const entries = cloneNormalizedPluginEntries(nextConfig);
      const currentEntry = entries[SECURITY_CORE_PLUGIN_ID] ?? {};
      const currentConfig = isRecord(currentEntry.config) ? currentEntry.config : {};

      entries[SECURITY_CORE_PLUGIN_ID] = {
        ...currentEntry,
        config: {
          ...currentConfig,
          ...policy.runtime,
        },
      };
      plugins.entries = entries;
      nextConfig.plugins = plugins;
      cleanupPluginContainer(nextConfig);

      if (config !== nextConfig) {
        for (const key of Object.keys(config)) {
          delete config[key];
        }
        Object.assign(config, nextConfig);
      }
    });
  }
}
