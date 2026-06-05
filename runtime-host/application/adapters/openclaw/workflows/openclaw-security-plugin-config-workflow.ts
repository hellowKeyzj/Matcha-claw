import type { SecurityPolicyPayload } from '../../security/security-policy-types';
import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';
import { applySecurityPolicyToOpenClawPluginConfig } from '../projections/openclaw-security-plugin-config-service';

export class OpenClawSecurityPluginConfigWorkflow {
  constructor(private readonly configRepository: OpenClawConfigRepositoryPort) {}

  async applyPolicy(policy: SecurityPolicyPayload): Promise<void> {
    await this.configRepository.updateDirty((config) => {
      replaceConfigContents(config, applySecurityPolicyToOpenClawPluginConfig(config, policy));
      return { result: undefined, changed: true };
    });
  }
}

function replaceConfigContents(target: Record<string, unknown>, source: Record<string, unknown>): void {
  if (target === source) {
    return;
  }
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}
