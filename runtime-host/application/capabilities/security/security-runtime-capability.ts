import type { SecurityRuntimeService } from '../../security/service';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const SECURITY_RUNTIME_CAPABILITY_ID = 'security.runtime';

export const securityRuntimeCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'security.writePolicy', title: 'Write security policy' },
  { id: 'security.syncCurrentPolicy', title: 'Sync current security policy' },
  { id: 'security.quickAudit', title: 'Run security quick audit' },
  { id: 'security.emergencyResponse', title: 'Run security emergency response' },
  { id: 'security.checkIntegrity', title: 'Check security integrity' },
  { id: 'security.rebaselineIntegrity', title: 'Rebaseline security integrity' },
  { id: 'security.scanSkills', title: 'Scan skills for security issues' },
  { id: 'security.checkAdvisories', title: 'Check security advisories' },
  { id: 'security.previewRemediation', title: 'Preview security remediation' },
  { id: 'security.applyRemediation', title: 'Apply security remediation' },
  { id: 'security.rollbackRemediation', title: 'Rollback security remediation' },
] as const;

export function createSecurityRuntimeCapabilityOperationRoutes(deps: {
  securityService: Pick<SecurityRuntimeService,
    | 'writePolicy'
    | 'syncCurrentPolicyToGatewayIfRunning'
    | 'runQuickAudit'
    | 'runEmergencyResponse'
    | 'checkIntegrity'
    | 'rebaselineIntegrity'
    | 'scanSkillsFromPayload'
    | 'checkAdvisories'
    | 'previewRemediation'
    | 'applyRemediationFromPayload'
    | 'rollbackRemediationFromPayload'
  >;
}): readonly CapabilityOperationRoute[] {
  return [
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.writePolicy',
      handle: (context) => deps.securityService.writePolicy(context.domainInput),
    },
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.syncCurrentPolicy',
      handle: () => deps.securityService.syncCurrentPolicyToGatewayIfRunning(),
    },
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.quickAudit',
      handle: () => ({ status: 202, data: deps.securityService.runQuickAudit() }),
    },
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.emergencyResponse',
      handle: () => ({ status: 202, data: deps.securityService.runEmergencyResponse() }),
    },
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.checkIntegrity',
      handle: () => ({ status: 202, data: deps.securityService.checkIntegrity() }),
    },
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.rebaselineIntegrity',
      handle: () => ({ status: 202, data: deps.securityService.rebaselineIntegrity() }),
    },
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.scanSkills',
      handle: (context) => ({ status: 202, data: deps.securityService.scanSkillsFromPayload(context.domainInput) }),
    },
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.checkAdvisories',
      handle: (context) => ({ status: 202, data: deps.securityService.checkAdvisories(readFeedUrl(context.domainInput)) }),
    },
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.previewRemediation',
      handle: () => ({ status: 202, data: deps.securityService.previewRemediation() }),
    },
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.applyRemediation',
      handle: (context) => ({ status: 202, data: deps.securityService.applyRemediationFromPayload(context.domainInput) }),
    },
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.rollbackRemediation',
      handle: (context) => ({ status: 202, data: deps.securityService.rollbackRemediationFromPayload(context.domainInput) }),
    },
  ];
}

function readFeedUrl(payload: Record<string, unknown>): string | null {
  return typeof payload.feedUrl === 'string' ? payload.feedUrl : null;
}

