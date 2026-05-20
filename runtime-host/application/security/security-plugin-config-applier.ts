import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';
import {
  cleanupPluginContainer,
  cloneConfig,
  cloneNormalizedPluginEntries,
  isRecord,
} from '../openclaw/openclaw-plugin-config-model';
import { withOpenClawConfigLock } from '../openclaw/openclaw-config-mutex';
import type { SecurityPolicyRepository } from './security-policy-store';

const SECURITY_CORE_PLUGIN_ID = 'security-core';

export class SecurityPluginConfigApplier {
  constructor(
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly policyRepository: Pick<SecurityPolicyRepository, 'read'>,
  ) {}

  async applySavedPolicyToPluginConfig(): Promise<void> {
    const policy = await this.policyRepository.read();
    await withOpenClawConfigLock(async () => {
      const config = cloneConfig(await this.configRepository.read());
      const plugins = isRecord(config.plugins) ? { ...config.plugins } : {};
      const entries = cloneNormalizedPluginEntries(config);
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
      config.plugins = plugins;
      cleanupPluginContainer(config);

      await this.configRepository.write(config);
    });
  }
}
