import type { RuntimeTimerPort } from '../../common/runtime-ports';
import type { GatewaySecurityPort } from '../../gateway/gateway-runtime-port';
import type { SecurityPolicyRepository } from '../../security/security-policy-store';

const POLICY_SYNC_MAX_ATTEMPTS = 5;
const POLICY_SYNC_RETRY_DELAY_MS = 1000;

export interface SecurityPolicySyncWorkflowDeps {
  readonly gateway: Pick<GatewaySecurityPort, 'securityPolicySync'>;
  readonly policyRepository: Pick<SecurityPolicyRepository, 'read'>;
  readonly timer: Pick<RuntimeTimerPort, 'sleep'>;
}

export class SecurityPolicySyncWorkflow {
  constructor(private readonly deps: SecurityPolicySyncWorkflowDeps) {}

  async execute() {
    const policy = await this.deps.policyRepository.read();
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= POLICY_SYNC_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.deps.gateway.securityPolicySync(policy);
        return { synced: true, policy, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt < POLICY_SYNC_MAX_ATTEMPTS) {
          await this.deps.timer.sleep(POLICY_SYNC_RETRY_DELAY_MS);
        }
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Security policy sync failed after ${POLICY_SYNC_MAX_ATTEMPTS} attempts: ${reason}`);
  }
}
