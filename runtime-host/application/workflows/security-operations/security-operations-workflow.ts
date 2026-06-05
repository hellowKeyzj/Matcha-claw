import { accepted, type ApplicationResponse } from '../../common/application-response';
import type { SecurityJobPort } from '../../security/security-jobs';
import type { SecurityPolicyRepository } from '../../security/security-policy-store';
import type { SecurityEmergencyResponseWorkflow } from '../security-emergency/security-emergency-response-workflow';
import type { SecurityGatewayOperationsWorkflow } from './security-gateway-operations-workflow';
import type { SecurityPolicySyncWorkflow } from '../security-policy/security-policy-sync-workflow';

export interface SecurityOperationsWorkflowDeps {
  readonly policyRepository: SecurityPolicyRepository;
  readonly jobs: SecurityJobPort;
  readonly policySyncWorkflow: Pick<SecurityPolicySyncWorkflow, 'execute'>;
  readonly emergencyResponseWorkflow: Pick<SecurityEmergencyResponseWorkflow, 'execute'>;
  readonly gatewayOperationsWorkflow: Pick<SecurityGatewayOperationsWorkflow,
    | 'queryAudit'
    | 'executeQuickAudit'
    | 'executeIntegrityCheck'
    | 'executeIntegrityRebaseline'
    | 'executeSkillsScan'
    | 'executeAdvisoriesCheck'
    | 'executeRemediationPreview'
    | 'executeRemediationApply'
    | 'executeRemediationRollback'
  >;
}

export class SecurityOperationsWorkflow {
  constructor(private readonly deps: SecurityOperationsWorkflowDeps) {}

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
    return await this.deps.policySyncWorkflow.execute();
  }

  async queryAudit(routeUrl: URL) {
    return await this.deps.gatewayOperationsWorkflow.queryAudit(routeUrl);
  }

  runQuickAudit() {
    return this.deps.jobs.submitQuickAudit();
  }

  async executeQuickAudit() {
    return await this.deps.gatewayOperationsWorkflow.executeQuickAudit();
  }

  runEmergencyResponse() {
    return this.deps.jobs.submitEmergencyResponse();
  }

  async executeEmergencyResponse() {
    return await this.deps.emergencyResponseWorkflow.execute();
  }

  checkIntegrity() {
    return this.deps.jobs.submitIntegrityCheck();
  }

  async executeIntegrityCheck() {
    return await this.deps.gatewayOperationsWorkflow.executeIntegrityCheck();
  }

  rebaselineIntegrity() {
    return this.deps.jobs.submitIntegrityRebaseline();
  }

  async executeIntegrityRebaseline() {
    return await this.deps.gatewayOperationsWorkflow.executeIntegrityRebaseline();
  }

  async executeSkillsScan(scanPath?: string) {
    return await this.deps.gatewayOperationsWorkflow.executeSkillsScan(scanPath);
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
    return await this.deps.gatewayOperationsWorkflow.executeAdvisoriesCheck(feedUrl);
  }

  checkAdvisoriesFromUrl(routeUrl: URL) {
    return this.checkAdvisories(routeUrl.searchParams.get('feedUrl'));
  }

  previewRemediation() {
    return this.deps.jobs.submitRemediationPreview();
  }

  async executeRemediationPreview() {
    return await this.deps.gatewayOperationsWorkflow.executeRemediationPreview();
  }

  applyRemediation(actions: string[]) {
    return this.deps.jobs.submitRemediationApply(actions);
  }

  async executeRemediationApply(actions: string[]) {
    return await this.deps.gatewayOperationsWorkflow.executeRemediationApply(actions);
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
    return await this.deps.gatewayOperationsWorkflow.executeRemediationRollback(snapshotId);
  }

  rollbackRemediationFromPayload(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const snapshotId = typeof body.snapshotId === 'string' ? body.snapshotId : undefined;
    return this.rollbackRemediation(snapshotId);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
