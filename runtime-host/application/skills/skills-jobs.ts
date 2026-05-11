import type { RuntimeLongTaskSubmission, RuntimeLongTaskSubmissionPort } from '../runtime-host/runtime-task-ports';

export const SYNC_SKILL_GATEWAY_UPDATE_JOB = 'skills.syncGatewayUpdate';
export const REFRESH_SKILL_STATUS_JOB = 'skills.refreshStatus';
export const IMPORT_LOCAL_SKILL_JOB = 'skills.importLocal';
export const ENSURE_PREINSTALLED_SKILLS_JOB = 'skills.ensurePreinstalled';

export type SkillsJobSubmission = RuntimeLongTaskSubmission;

export interface SkillsJobPort {
  submitRefreshStatus(): SkillsJobSubmission;
  submitGatewayUpdate(payload: {
    readonly skillKey: string;
    readonly updates: Record<string, unknown>;
  }): SkillsJobSubmission;
  submitImportLocal(payload: { readonly sourcePath: string }): SkillsJobSubmission;
  submitEnsurePreinstalled(): SkillsJobSubmission;
}

export function createSkillsJobPort(tasks: RuntimeLongTaskSubmissionPort): SkillsJobPort {
  return {
    submitRefreshStatus: () => tasks.submit(REFRESH_SKILL_STATUS_JOB, null, {
      dedupeKey: REFRESH_SKILL_STATUS_JOB,
    }),
    submitGatewayUpdate: (payload) => tasks.submit(SYNC_SKILL_GATEWAY_UPDATE_JOB, payload, {
      dedupeKey: `${SYNC_SKILL_GATEWAY_UPDATE_JOB}:${payload.skillKey}`,
    }),
    submitImportLocal: (payload) => tasks.submit(IMPORT_LOCAL_SKILL_JOB, payload, {
      queue: 'critical',
    }),
    submitEnsurePreinstalled: () => tasks.submit(ENSURE_PREINSTALLED_SKILLS_JOB, null, {
      queue: 'critical',
      dedupeKey: ENSURE_PREINSTALLED_SKILLS_JOB,
    }),
  };
}
