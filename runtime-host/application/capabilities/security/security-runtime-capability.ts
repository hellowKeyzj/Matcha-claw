import type { SecurityRuntimeService } from '../../security/service';
import { badRequest } from '../../common/application-response';
import type { SecurityRemediationTarget } from '../../agent-runtime/contracts/runtime-address';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute, CapabilityOperationContext } from '../contracts/capability-router';

export const SECURITY_RUNTIME_CAPABILITY_ID = 'security.runtime';

export const securityRuntimeCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'security.writePolicy', title: 'Write security policy', targetKind: 'security-policy' },
  { id: 'security.syncCurrentPolicy', title: 'Sync current security policy', targetKind: 'security-policy' },
  { id: 'security.quickAudit', title: 'Run security quick audit', targetKind: 'security-policy' },
  { id: 'security.emergencyResponse', title: 'Run security emergency response', targetKind: 'security-policy' },
  { id: 'security.checkIntegrity', title: 'Check security integrity', targetKind: 'security-policy' },
  { id: 'security.rebaselineIntegrity', title: 'Rebaseline security integrity', targetKind: 'security-policy' },
  { id: 'security.scanSkills', title: 'Scan skills for security issues', targetKind: 'security-policy' },
  { id: 'security.checkAdvisories', title: 'Check security advisories', targetKind: 'security-policy' },
  { id: 'security.previewRemediation', title: 'Preview security remediation', targetKind: 'security-remediation' },
  { id: 'security.applyRemediation', title: 'Apply security remediation', targetKind: 'security-remediation' },
  { id: 'security.rollbackRemediation', title: 'Rollback security remediation', targetKind: 'security-remediation' },
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
      handle: (context) => {
        const targetError = validateRemediationTargetInput(context, ['remediationId']);
        return targetError
          ? badRequest(targetError)
          : { status: 202, data: deps.securityService.applyRemediationFromPayload(context.domainInput) };
      },
    },
    {
      capabilityId: SECURITY_RUNTIME_CAPABILITY_ID,
      operationId: 'security.rollbackRemediation',
      handle: (context) => {
        const targetError = validateRemediationTargetInput(context, ['snapshotId']);
        return targetError
          ? badRequest(targetError)
          : { status: 202, data: deps.securityService.rollbackRemediationFromPayload(context.domainInput) };
      },
    },
  ];
}

function validateRemediationTargetInput(
  context: CapabilityOperationContext,
  keys: Array<keyof Pick<SecurityRemediationTarget, 'remediationId' | 'snapshotId'>>,
): string | null {
  if (context.target?.kind !== 'security-remediation') {
    return 'Capability target kind must be security-remediation';
  }
  for (const key of keys) {
    const targetValue = typeof context.target[key] === 'string' && context.target[key]?.trim()
      ? context.target[key]
      : '';
    const inputValue = typeof context.domainInput[key] === 'string' && context.domainInput[key].trim()
      ? context.domainInput[key]
      : '';
    if (!targetValue || !inputValue) {
      return `Capability target ${key} and input ${key} are required`;
    }
    if (inputValue !== targetValue) {
      return `Capability target ${key} must match input ${key}`;
    }
  }
  return null;
}

function readFeedUrl(payload: Record<string, unknown>): string | null {
  return typeof payload.feedUrl === 'string' ? payload.feedUrl : null;
}

