import type { SecurityPolicyRepository } from './security-policy-store';
import type { SecurityPolicyPayload } from './security-policy-types';

export interface SecurityPluginConfigProjectionPort {
  applyPolicy(policy: SecurityPolicyPayload): Promise<void>;
}

export class SecurityPluginConfigApplier {
  constructor(
    private readonly pluginConfig: SecurityPluginConfigProjectionPort,
    private readonly policyRepository: Pick<SecurityPolicyRepository, 'read'>,
  ) {}

  async applySavedPolicyToPluginConfig(): Promise<void> {
    await this.pluginConfig.applyPolicy(await this.policyRepository.read());
  }
}
