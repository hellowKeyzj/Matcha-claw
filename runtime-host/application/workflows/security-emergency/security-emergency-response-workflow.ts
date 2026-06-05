import type { GatewaySecurityPort } from '../../gateway/gateway-runtime-port';
import type { SecurityPolicyRepository } from '../../security/security-policy-store';
import { createSecurityEmergencyLockdownPayload } from '../../security/security-emergency-policy';

export interface SecurityEmergencyResponseWorkflowDeps {
  readonly gateway: Pick<GatewaySecurityPort, 'isGatewayRunning' | 'securityPolicySync' | 'securityEmergencyRun'>;
  readonly policyRepository: Pick<SecurityPolicyRepository, 'read' | 'write'>;
}

export class SecurityEmergencyResponseWorkflow {
  constructor(private readonly deps: SecurityEmergencyResponseWorkflowDeps) {}

  async execute() {
    const current = await this.deps.policyRepository.read();
    const emergencyPayload = createSecurityEmergencyLockdownPayload(current);
    const normalizedPolicy = await this.deps.policyRepository.write(emergencyPayload);
    const gatewayRunning = await this.deps.gateway.isGatewayRunning();

    const syncError = gatewayRunning
      ? await this.syncPolicy(normalizedPolicy)
      : null;
    const { emergency, emergencyError } = gatewayRunning
      ? await this.runEmergency()
      : { emergency: null, emergencyError: null };

    return {
      success: true,
      lockdownApplied: true,
      policy: normalizedPolicy,
      syncError,
      emergency,
      emergencyError,
    };
  }

  private async syncPolicy(policy: unknown): Promise<string | null> {
    try {
      await this.deps.gateway.securityPolicySync(policy);
      return null;
    } catch (error) {
      return String(error);
    }
  }

  private async runEmergency(): Promise<{ emergency: unknown; emergencyError: string | null }> {
    try {
      return {
        emergency: await this.deps.gateway.securityEmergencyRun(),
        emergencyError: null,
      };
    } catch (error) {
      return {
        emergency: null,
        emergencyError: String(error),
      };
    }
  }
}
