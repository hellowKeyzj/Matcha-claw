import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';

export const SECURITY_POLICY_SYNC_JOB = 'security.policySync';
export const SECURITY_SKILLS_SCAN_JOB = 'security.skillsScan';
export const SECURITY_QUICK_AUDIT_JOB = 'security.quickAudit';
export const SECURITY_EMERGENCY_RESPONSE_JOB = 'security.emergencyResponse';
export const SECURITY_INTEGRITY_CHECK_JOB = 'security.integrityCheck';
export const SECURITY_INTEGRITY_REBASELINE_JOB = 'security.integrityRebaseline';
export const SECURITY_ADVISORIES_CHECK_JOB = 'security.advisoriesCheck';
export const SECURITY_REMEDIATION_PREVIEW_JOB = 'security.remediationPreview';
export const SECURITY_REMEDIATION_APPLY_JOB = 'security.remediationApply';
export const SECURITY_REMEDIATION_ROLLBACK_JOB = 'security.remediationRollback';

export type SecurityJobSubmission = RuntimeLongTaskSubmission;

export interface SecurityJobPort {
  submitPolicySync(): SecurityJobSubmission;
  submitQuickAudit(): SecurityJobSubmission;
  submitEmergencyResponse(): SecurityJobSubmission;
  submitIntegrityCheck(): SecurityJobSubmission;
  submitIntegrityRebaseline(): SecurityJobSubmission;
  submitSkillsScan(scanPath?: string): SecurityJobSubmission;
  submitAdvisoriesCheck(feedUrl?: string | null): SecurityJobSubmission;
  submitRemediationPreview(): SecurityJobSubmission;
  submitRemediationApply(actions: string[]): SecurityJobSubmission;
  submitRemediationRollback(snapshotId?: string): SecurityJobSubmission;
}

export function createSecurityJobPort(tasks: RuntimeLongTaskSubmissionPort): SecurityJobPort {
  return {
    submitPolicySync: () => tasks.submit(SECURITY_POLICY_SYNC_JOB, null, {
      dedupeKey: SECURITY_POLICY_SYNC_JOB,
    }),
    submitQuickAudit: () => tasks.submit(SECURITY_QUICK_AUDIT_JOB, null, {
      dedupeKey: SECURITY_QUICK_AUDIT_JOB,
    }),
    submitEmergencyResponse: () => tasks.submit(SECURITY_EMERGENCY_RESPONSE_JOB, null, {
      dedupeKey: SECURITY_EMERGENCY_RESPONSE_JOB,
    }),
    submitIntegrityCheck: () => tasks.submit(SECURITY_INTEGRITY_CHECK_JOB, null, {
      dedupeKey: SECURITY_INTEGRITY_CHECK_JOB,
    }),
    submitIntegrityRebaseline: () => tasks.submit(SECURITY_INTEGRITY_REBASELINE_JOB, null, {
      dedupeKey: SECURITY_INTEGRITY_REBASELINE_JOB,
    }),
    submitSkillsScan: (scanPath) => tasks.submit(SECURITY_SKILLS_SCAN_JOB, { scanPath }, {
      dedupeKey: `${SECURITY_SKILLS_SCAN_JOB}:${scanPath ?? ''}`,
    }),
    submitAdvisoriesCheck: (feedUrl) => tasks.submit(SECURITY_ADVISORIES_CHECK_JOB, { feedUrl: feedUrl ?? null }, {
      dedupeKey: `${SECURITY_ADVISORIES_CHECK_JOB}:${feedUrl ?? ''}`,
    }),
    submitRemediationPreview: () => tasks.submit(SECURITY_REMEDIATION_PREVIEW_JOB, null, {
      dedupeKey: SECURITY_REMEDIATION_PREVIEW_JOB,
    }),
    submitRemediationApply: (actions) => tasks.submit(SECURITY_REMEDIATION_APPLY_JOB, { actions }, {
      dedupeKey: `${SECURITY_REMEDIATION_APPLY_JOB}:${actions.join('\u001f')}`,
    }),
    submitRemediationRollback: (snapshotId) => tasks.submit(SECURITY_REMEDIATION_ROLLBACK_JOB, { snapshotId }, {
      dedupeKey: `${SECURITY_REMEDIATION_ROLLBACK_JOB}:${snapshotId ?? ''}`,
    }),
  };
}
