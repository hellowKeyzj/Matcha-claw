import type {} from '../call-log';

export type SubagentsCallOutcome =
  | 'listed'
  | 'waitCompleted'
  | 'waitFailed'
  | 'waitTimeout'
  | 'waitPending'
  | 'waitUnknown'
  | 'created'
  | 'workspaceInitializationFailed'
  | 'nativeDeleteFailed'
  | 'sealedPurgeFailed'
  | 'packageInstallFailedCompensated'
  | 'packageInstallCompensationUnknown'
  | 'packageInstallCompensationFailed'
  | 'updated'
  | 'deleted'
  | 'filesListed'
  | 'fileReturned'
  | 'configurationRead'
  | 'configurationApplied'
  | 'skillConfigurationRead'
  | 'skillConfigurationUpdated'
  | 'toolConfigurationRead'
  | 'toolConfigurationUpdated'
  | 'packageExported'
  | 'packageInstalled'
  | 'staleRevision'
  | 'invalidSkillKeys'
  | 'invalidToolKeys'
  | 'unsupported'
  | 'rejected'
  | 'outcomeUnknown'
  | 'unexpectedOutcome'
  | 'unavailable';

export interface SubagentsCallDetail {
  endpoint: 'openclaw:local' | 'matcha-agent:local';
  agentId: string | null;
  runId: string | null;
  outcome: SubagentsCallOutcome | null;
  readFailure: 'unavailable' | 'rejected' | 'protocol' | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    subagents: SubagentsCallDetail;
  }
}

const OUTCOMES: ReadonlySet<string> = new Set<SubagentsCallOutcome>([
  'listed', 'waitCompleted', 'waitFailed', 'waitTimeout', 'waitPending', 'waitUnknown',
  'created', 'updated', 'deleted', 'filesListed', 'fileReturned', 'configurationRead',
  'configurationApplied', 'skillConfigurationRead', 'skillConfigurationUpdated',
  'toolConfigurationRead', 'toolConfigurationUpdated', 'packageExported', 'packageInstalled',
  'staleRevision', 'invalidSkillKeys', 'invalidToolKeys', 'unsupported', 'rejected',
  'outcomeUnknown', 'unexpectedOutcome', 'unavailable', 'workspaceInitializationFailed',
  'nativeDeleteFailed', 'sealedPurgeFailed', 'packageInstallFailedCompensated',
  'packageInstallCompensationUnknown', 'packageInstallCompensationFailed',
]);

export function decodeSubagentsCallDetail(value: unknown): SubagentsCallDetail | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const detail = value as Record<string, unknown>;
  const keys = ['endpoint', 'agentId', 'runId', 'outcome', 'readFailure'];
  if (Object.keys(detail).length !== keys.length || !keys.every((key) => Object.hasOwn(detail, key))) return null;
  if (detail.endpoint !== 'openclaw:local' && detail.endpoint !== 'matcha-agent:local') return null;
  if (!safeId(detail.agentId) || !safeId(detail.runId)) return null;
  if (detail.outcome !== null && (typeof detail.outcome !== 'string' || !OUTCOMES.has(detail.outcome))) return null;
  if (detail.readFailure !== null && detail.readFailure !== 'unavailable'
    && detail.readFailure !== 'rejected' && detail.readFailure !== 'protocol') return null;
  return {
    endpoint: detail.endpoint,
    agentId: detail.agentId,
    runId: detail.runId,
    outcome: detail.outcome as SubagentsCallOutcome | null,
    readFailure: detail.readFailure,
  };
}

function safeId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0
    && value.length <= 128 && !/[^a-zA-Z0-9_.:-]/.test(value));
}
