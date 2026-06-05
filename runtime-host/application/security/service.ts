import {
  listSecurityRuleCatalog,
} from './security-rule-catalog';
import type { SecurityOperationsWorkflow } from '../workflows/security-operations/security-operations-workflow';

export interface SecurityRuntimeServiceDeps {
  operationsWorkflow: Pick<SecurityOperationsWorkflow,
    | 'readPolicy'
    | 'writePolicy'
    | 'syncCurrentPolicyToGatewayIfRunning'
    | 'executePolicySync'
    | 'queryAudit'
    | 'runQuickAudit'
    | 'executeQuickAudit'
    | 'runEmergencyResponse'
    | 'executeEmergencyResponse'
    | 'checkIntegrity'
    | 'executeIntegrityCheck'
    | 'rebaselineIntegrity'
    | 'executeIntegrityRebaseline'
    | 'executeSkillsScan'
    | 'scanSkillsFromPayload'
    | 'checkAdvisories'
    | 'executeAdvisoriesCheck'
    | 'checkAdvisoriesFromUrl'
    | 'previewRemediation'
    | 'executeRemediationPreview'
    | 'applyRemediation'
    | 'executeRemediationApply'
    | 'applyRemediationFromPayload'
    | 'rollbackRemediation'
    | 'executeRemediationRollback'
    | 'rollbackRemediationFromPayload'
  >;
}

export class SecurityRuntimeService {
  constructor(private readonly deps: SecurityRuntimeServiceDeps) {}

  async readPolicy() {
    return await this.deps.operationsWorkflow.readPolicy();
  }

  async writePolicy(payload: unknown) {
    return await this.deps.operationsWorkflow.writePolicy(payload);
  }

  syncCurrentPolicyToGatewayIfRunning() {
    return this.deps.operationsWorkflow.syncCurrentPolicyToGatewayIfRunning();
  }

  async executePolicySync() {
    return await this.deps.operationsWorkflow.executePolicySync();
  }

  listRuleCatalog(platform?: string | null) {
    return listSecurityRuleCatalog(platform);
  }

  async queryAudit(routeUrl: URL) {
    return await this.deps.operationsWorkflow.queryAudit(routeUrl);
  }

  runQuickAudit() {
    return this.deps.operationsWorkflow.runQuickAudit();
  }

  async executeQuickAudit() {
    return await this.deps.operationsWorkflow.executeQuickAudit();
  }

  runEmergencyResponse() {
    return this.deps.operationsWorkflow.runEmergencyResponse();
  }

  async executeEmergencyResponse() {
    return await this.deps.operationsWorkflow.executeEmergencyResponse();
  }

  checkIntegrity() {
    return this.deps.operationsWorkflow.checkIntegrity();
  }

  async executeIntegrityCheck() {
    return await this.deps.operationsWorkflow.executeIntegrityCheck();
  }

  rebaselineIntegrity() {
    return this.deps.operationsWorkflow.rebaselineIntegrity();
  }

  async executeIntegrityRebaseline() {
    return await this.deps.operationsWorkflow.executeIntegrityRebaseline();
  }

  async executeSkillsScan(scanPath?: string) {
    return await this.deps.operationsWorkflow.executeSkillsScan(scanPath);
  }

  scanSkillsFromPayload(payload: unknown) {
    return this.deps.operationsWorkflow.scanSkillsFromPayload(payload);
  }

  checkAdvisories(feedUrl?: string | null) {
    return this.deps.operationsWorkflow.checkAdvisories(feedUrl);
  }

  async executeAdvisoriesCheck(feedUrl?: string | null) {
    return await this.deps.operationsWorkflow.executeAdvisoriesCheck(feedUrl);
  }

  checkAdvisoriesFromUrl(routeUrl: URL) {
    return this.deps.operationsWorkflow.checkAdvisoriesFromUrl(routeUrl);
  }

  previewRemediation() {
    return this.deps.operationsWorkflow.previewRemediation();
  }

  async executeRemediationPreview() {
    return await this.deps.operationsWorkflow.executeRemediationPreview();
  }

  applyRemediation(actions: string[]) {
    return this.deps.operationsWorkflow.applyRemediation(actions);
  }

  async executeRemediationApply(actions: string[]) {
    return await this.deps.operationsWorkflow.executeRemediationApply(actions);
  }

  applyRemediationFromPayload(payload: unknown) {
    return this.deps.operationsWorkflow.applyRemediationFromPayload(payload);
  }

  rollbackRemediation(snapshotId?: string) {
    return this.deps.operationsWorkflow.rollbackRemediation(snapshotId);
  }

  async executeRemediationRollback(snapshotId?: string) {
    return await this.deps.operationsWorkflow.executeRemediationRollback(snapshotId);
  }

  rollbackRemediationFromPayload(payload: unknown) {
    return this.deps.operationsWorkflow.rollbackRemediationFromPayload(payload);
  }
}
