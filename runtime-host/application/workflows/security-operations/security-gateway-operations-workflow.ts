import type { GatewaySecurityPort } from '../../gateway/gateway-runtime-port';

export interface SecurityGatewayOperationsWorkflowDeps {
  readonly gateway: Pick<GatewaySecurityPort,
    | 'securityAuditQueryFromUrl'
    | 'securityQuickAuditRun'
    | 'securityIntegrityCheck'
    | 'securityIntegrityRebaseline'
    | 'securitySkillsScan'
    | 'securityAdvisoriesCheck'
    | 'securityRemediationPreview'
    | 'securityRemediationApply'
    | 'securityRemediationRollback'
  >;
}

export class SecurityGatewayOperationsWorkflow {
  constructor(private readonly deps: SecurityGatewayOperationsWorkflowDeps) {}

  async queryAudit(routeUrl: URL) {
    return await this.deps.gateway.securityAuditQueryFromUrl(routeUrl);
  }

  async executeQuickAudit() {
    return await this.deps.gateway.securityQuickAuditRun();
  }

  async executeIntegrityCheck() {
    return await this.deps.gateway.securityIntegrityCheck();
  }

  async executeIntegrityRebaseline() {
    return await this.deps.gateway.securityIntegrityRebaseline();
  }

  async executeSkillsScan(scanPath?: string) {
    return await this.deps.gateway.securitySkillsScan(scanPath);
  }

  async executeAdvisoriesCheck(feedUrl?: string | null) {
    return await this.deps.gateway.securityAdvisoriesCheck(feedUrl);
  }

  async executeRemediationPreview() {
    return await this.deps.gateway.securityRemediationPreview();
  }

  async executeRemediationApply(actions: string[]) {
    return await this.deps.gateway.securityRemediationApply(actions);
  }

  async executeRemediationRollback(snapshotId?: string) {
    return await this.deps.gateway.securityRemediationRollback(snapshotId);
  }
}
