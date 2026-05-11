import type { GatewaySecurityPort } from '../gateway/gateway-runtime-port';
import { accepted, type ApplicationResponse } from '../common/application-response';
import {
  createSecurityEmergencyLockdownPayload,
} from './security-emergency-policy';
import {
  listSecurityRuleCatalog,
} from './security-rule-catalog';
import type { SecurityPolicyRepository } from './security-policy-store';
import type { SecurityJobPort } from './security-jobs';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface SecurityRuntimeServiceDeps {
  gateway: GatewaySecurityPort;
  policyRepository: SecurityPolicyRepository;
  jobs: SecurityJobPort;
}

export class SecurityRuntimeService {
  constructor(private readonly deps: SecurityRuntimeServiceDeps) {}

  async readPolicy() {
    return await this.deps.policyRepository.read();
  }

  async writePolicy(payload: unknown): Promise<ApplicationResponse> {
    const normalized = await this.deps.policyRepository.write(payload);
    return accepted({
      success: true,
      policy: normalized,
      sync: this.deps.jobs.submitPolicySync(),
    });
  }

  syncCurrentPolicyToGatewayIfRunning(): ApplicationResponse {
    return accepted(this.deps.jobs.submitPolicySync());
  }

  async executePolicySync() {
    const gatewayRunning = await this.deps.gateway.isGatewayRunning();
    if (!gatewayRunning) {
      return { synced: false, policy: null as unknown };
    }

    const policy = await this.deps.policyRepository.read();
    await this.deps.gateway.securityPolicySync(policy);
    return { synced: true, policy };
  }

  listRuleCatalog(platform?: string | null) {
    return listSecurityRuleCatalog(platform);
  }

  async queryAudit(routeUrl: URL) {
    return await this.deps.gateway.securityAuditQueryFromUrl(routeUrl);
  }

  runQuickAudit() {
    return this.deps.jobs.submitQuickAudit();
  }

  async executeQuickAudit() {
    return await this.deps.gateway.securityQuickAuditRun();
  }

  runEmergencyResponse() {
    return this.deps.jobs.submitEmergencyResponse();
  }

  async executeEmergencyResponse() {
    const current = await this.deps.policyRepository.read();
    const emergencyPayload = createSecurityEmergencyLockdownPayload(current);
    const normalizedPolicy = await this.deps.policyRepository.write(emergencyPayload);
    const gatewayRunning = await this.deps.gateway.isGatewayRunning();

    let syncError: string | null = null;
    if (gatewayRunning) {
      try {
        await this.deps.gateway.securityPolicySync(normalizedPolicy);
      } catch (error) {
        syncError = String(error);
      }
    }

    let emergency: unknown = null;
    let emergencyError: string | null = null;
    if (gatewayRunning) {
      try {
        emergency = await this.deps.gateway.securityEmergencyRun();
      } catch (error) {
        emergencyError = String(error);
      }
    }

    return {
      success: true,
      lockdownApplied: true,
      policy: normalizedPolicy,
      syncError,
      emergency,
      emergencyError,
    };
  }

  checkIntegrity() {
    return this.deps.jobs.submitIntegrityCheck();
  }

  async executeIntegrityCheck() {
    return await this.deps.gateway.securityIntegrityCheck();
  }

  rebaselineIntegrity() {
    return this.deps.jobs.submitIntegrityRebaseline();
  }

  async executeIntegrityRebaseline() {
    return await this.deps.gateway.securityIntegrityRebaseline();
  }

  async executeSkillsScan(scanPath?: string) {
    return await this.deps.gateway.securitySkillsScan(scanPath);
  }

  scanSkillsFromPayload(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const scanPath = typeof body.scanPath === 'string' ? body.scanPath : undefined;
    return this.deps.jobs.submitSkillsScan(scanPath);
  }

  checkAdvisories(feedUrl?: string | null) {
    return this.deps.jobs.submitAdvisoriesCheck(feedUrl);
  }

  async executeAdvisoriesCheck(feedUrl?: string | null) {
    return await this.deps.gateway.securityAdvisoriesCheck(feedUrl);
  }

  checkAdvisoriesFromUrl(routeUrl: URL) {
    return this.checkAdvisories(routeUrl.searchParams.get('feedUrl'));
  }

  previewRemediation() {
    return this.deps.jobs.submitRemediationPreview();
  }

  async executeRemediationPreview() {
    return await this.deps.gateway.securityRemediationPreview();
  }

  applyRemediation(actions: string[]) {
    return this.deps.jobs.submitRemediationApply(actions);
  }

  async executeRemediationApply(actions: string[]) {
    return await this.deps.gateway.securityRemediationApply(actions);
  }

  applyRemediationFromPayload(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const actions = Array.isArray(body.actions)
      ? body.actions.filter((item) => typeof item === 'string')
      : [];
    return this.applyRemediation(actions);
  }

  rollbackRemediation(snapshotId?: string) {
    return this.deps.jobs.submitRemediationRollback(snapshotId);
  }

  async executeRemediationRollback(snapshotId?: string) {
    return await this.deps.gateway.securityRemediationRollback(snapshotId);
  }

  rollbackRemediationFromPayload(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const snapshotId = typeof body.snapshotId === 'string' ? body.snapshotId : undefined;
    return this.rollbackRemediation(snapshotId);
  }
}
