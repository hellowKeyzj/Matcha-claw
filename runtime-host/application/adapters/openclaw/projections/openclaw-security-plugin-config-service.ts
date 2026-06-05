import type { SecurityPluginConfigProjectionPort } from '../../../security/security-plugin-config-applier';
import type { SecurityPolicyPayload } from '../../../security/security-policy-types';
import type { OpenClawSecurityPluginConfigWorkflow } from '../workflows/openclaw-security-plugin-config-workflow';
import {
  cleanupPluginContainer,
  cloneConfig,
  cloneNormalizedPluginEntries,
  isRecord,
} from './openclaw-plugin-config-model';

const SECURITY_CORE_PLUGIN_ID = 'security-core';

export function applySecurityPolicyToOpenClawPluginConfig(
  config: Record<string, unknown>,
  policy: SecurityPolicyPayload,
): Record<string, unknown> {
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
  return nextConfig;
}

export class OpenClawSecurityPluginConfigService implements SecurityPluginConfigProjectionPort {
  constructor(
    private readonly configWorkflow: Pick<OpenClawSecurityPluginConfigWorkflow, 'applyPolicy'>,
  ) {}

  async applyPolicy(policy: SecurityPolicyPayload): Promise<void> {
    await this.configWorkflow.applyPolicy(policy);
  }
}
