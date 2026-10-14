import type {} from '../call-log';

export interface OrganizationProvisionProgress {
  stage: 'reading_profiles' | 'generating_introductions' | 'configuring_team' | 'verifying_team' | 'saving_team' | 'rolling_back';
  members: Array<'queued' | 'running' | 'completed' | 'failed'>;
  memberErrors?: Record<string, 'credential_missing' | 'credential_unavailable' | 'unavailable' | 'unsupported' | 'invalid_output' | 'cancelled'
    | 'model_authentication' | 'model_permission_denied' | 'model_rate_limited' | 'model_deadline' | 'model_invalid_response'>;
}

const teamCreationStages = [
  'submitting', 'reading_profiles', 'generating_introductions', 'configuring_team',
  'verifying_team', 'saving_team', 'initializing_sessions', 'loading_team',
] as const;

const teamCreationFailureReasons = [
  'invalid_input', 'rejected', 'unavailable', 'unsupported', 'invalid_response',
  'outcome_unknown', 'observation_interrupted', 'rpc_unavailable', 'rpc_rejected',
  'rpc_protocol', 'rpc_deadline', 'rpc_authentication', 'agent_missing', 'agent_duplicate',
  'workspace_missing', 'invalid_config', 'invalid_description', 'invalid_content',
  'invalid_teamrun_blocks', 'credential_missing', 'credential_unavailable', 'invalid_output',
  'cancelled', 'native_read_failed', 'native_write_failed', 'native_readback_mismatch',
  'store_read_failed', 'store_write_failed', 'store_conflict', 'store_invalid',
  'team_missing', 'team_deleted', 'run_missing', 'run_deleted', 'run_team_mismatch',
  'authorization_invalid', 'permission_denied', 'rate_limited',
  'model_authentication', 'model_permission_denied', 'model_rate_limited', 'model_deadline', 'model_invalid_response',
] as const;

const teamCreationFiles = ['description', 'AGENTS.md', 'SOUL.md'] as const;

export type TeamCreationStage = typeof teamCreationStages[number];
export type TeamCreationFailureReason = typeof teamCreationFailureReasons[number];
export type TeamCreationFile = typeof teamCreationFiles[number];

export interface TeamCreationFailure {
  stage: TeamCreationStage;
  reason: TeamCreationFailureReason;
  /** Zero-based non-leader input order; absent for leader or whole-team failures. */
  memberIndex?: number;
  file?: TeamCreationFile;
}

type OrganizationCommit = {
  nativeInstalled: boolean | null;
  commit: 'committed' | 'failed' | 'outcome_unknown' | null;
};

export interface OrganizationCallDetail {
  teamId: string | null;
  runId: string | null;
  teamIdHash: string | null;
  runIdHash: string | null;
  commandId: string | null;
  graph: {
    status: 'pending' | 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
    nodes: number;
    edges: number;
  } | null;
  provision: (OrganizationCommit & { progress?: OrganizationProvisionProgress }) | null;
  creation: OrganizationCommit | null;
  creationFailure?: TeamCreationFailure;
  /** Operation completion is not native delivery or graph business completion. */
  outcome:
    | 'read' | 'command_committed' | 'materialized' | 'created' | 'started' | 'intake'
    | 'waiting_for_input' | 'approval_requested' | 'terminal_recorded' | 'terminal_receipt_required'
    | 'cancelling' | 'cancelled' | 'tombstoned' | 'purged'
    | 'rejected' | 'unavailable' | 'outcome_unknown' | null;
}

declare module '../call-log' {
  interface CallDetailByModule {
    organization: OrganizationCallDetail;
  }
}

export function decodeOrganizationCallDetail(value: unknown): OrganizationCallDetail | null {
  if (!isRecord(value) || !hasKeys(value, ['teamId', 'runId', 'teamIdHash', 'runIdHash', 'commandId', 'graph', 'outcome', 'provision', 'creation',
    ...(Object.hasOwn(value, 'creationFailure') ? ['creationFailure'] : [])])
    || !isReference(value.teamId) || !isRunReference(value.runId) || !isReference(value.commandId)
    || !isHash(value.teamIdHash) || !isHash(value.runIdHash)
    || (value.teamId !== null && value.teamIdHash !== null)
    || (value.runId !== null && value.runIdHash !== null)
    || ![null, 'read', 'command_committed', 'materialized', 'created', 'started', 'intake',
      'waiting_for_input', 'approval_requested', 'terminal_recorded', 'terminal_receipt_required',
      'cancelling', 'cancelled', 'tombstoned', 'purged', 'rejected', 'unavailable', 'outcome_unknown']
      .includes(value.outcome as string | null)) return null;
  let graph: OrganizationCallDetail['graph'] = null;
  if (value.graph !== null) {
    if (!isRecord(value.graph) || !hasKeys(value.graph, ['status', 'nodes', 'edges'])
      || !['pending', 'ready', 'running', 'waiting', 'completed', 'failed', 'cancelled']
        .includes(value.graph.status as string)
      || !isCount(value.graph.nodes) || !isCount(value.graph.edges)) return null;
    graph = {
      status: value.graph.status as NonNullable<OrganizationCallDetail['graph']>['status'],
      nodes: value.graph.nodes,
      edges: value.graph.edges,
    };
  }
  const provision = decodeProvision(value.provision);
  const creation = decodeCommit(value.creation);
  if (provision === undefined || creation === undefined) return null;
  const creationFailure = Object.hasOwn(value, 'creationFailure') ? decodeTeamCreationFailure(value.creationFailure) : undefined;
  if (creationFailure === null) return null;
  return {
    teamId: value.teamId,
    runId: value.runId,
    teamIdHash: value.teamIdHash,
    runIdHash: value.runIdHash,
    commandId: value.commandId,
    graph,
    provision,
    creation,
    ...(creationFailure === undefined ? {} : { creationFailure }),
    outcome: value.outcome as OrganizationCallDetail['outcome'],
  };
}

export function decodeTeamCreationFailure(value: unknown): TeamCreationFailure | null {
  if (!isRecord(value) || !hasKeys(value, ['stage', 'reason',
    ...(Object.hasOwn(value, 'memberIndex') ? ['memberIndex'] : []),
    ...(Object.hasOwn(value, 'file') ? ['file'] : [])])
    || !teamCreationStages.includes(value.stage as TeamCreationStage)
    || !teamCreationFailureReasons.includes(value.reason as TeamCreationFailureReason)
    || (Object.hasOwn(value, 'memberIndex') && !isCount(value.memberIndex))
    || (Object.hasOwn(value, 'file') && !teamCreationFiles.includes(value.file as TeamCreationFile))) return null;
  return {
    stage: value.stage as TeamCreationStage,
    reason: value.reason as TeamCreationFailureReason,
    ...(Object.hasOwn(value, 'memberIndex') ? { memberIndex: value.memberIndex as number } : {}),
    ...(Object.hasOwn(value, 'file') ? { file: value.file as TeamCreationFile } : {}),
  };
}

function decodeProvision(value: unknown): OrganizationCallDetail['provision'] | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasKeys(value, Object.hasOwn(value, 'progress')
    ? ['nativeInstalled', 'commit', 'progress'] : ['nativeInstalled', 'commit'])) return undefined;
  const commit = decodeCommit({ nativeInstalled: value.nativeInstalled, commit: value.commit });
  if (!commit) return undefined;
  if (!Object.hasOwn(value, 'progress')) return commit;
  const progress = value.progress;
  if (!isRecord(progress) || !hasKeys(progress, Object.hasOwn(progress, 'memberErrors')
    ? ['stage', 'members', 'memberErrors'] : ['stage', 'members'])
    || !['reading_profiles', 'generating_introductions', 'configuring_team', 'verifying_team', 'saving_team', 'rolling_back']
      .includes(progress.stage as string)
    || !Array.isArray(progress.members)
    || !Array.from(progress.members).every((member) => ['queued', 'running', 'completed', 'failed'].includes(member))) return undefined;
  const members = progress.members;
  const memberErrors = progress.memberErrors;
  if (Object.hasOwn(progress, 'memberErrors') && (!isRecord(memberErrors)
    || !Object.entries(memberErrors).every(([index, error]) => /^(0|[1-9][0-9]*)$/.test(index)
      && Number(index) < members.length && members[Number(index)] === 'failed'
      && ['credential_missing', 'credential_unavailable', 'unavailable', 'unsupported', 'invalid_output', 'cancelled',
        'model_authentication', 'model_permission_denied', 'model_rate_limited', 'model_deadline', 'model_invalid_response'].includes(error as string)))) return undefined;
  return {
    ...commit,
    progress: {
      stage: progress.stage as OrganizationProvisionProgress['stage'], members: [...progress.members],
      ...(memberErrors === undefined ? {} : { memberErrors: { ...memberErrors as NonNullable<OrganizationProvisionProgress['memberErrors']> } }),
    },
  };
}

function decodeCommit(value: unknown): OrganizationCommit | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasKeys(value, ['nativeInstalled', 'commit'])
    || (value.nativeInstalled !== null && typeof value.nativeInstalled !== 'boolean')
    || ![null, 'committed', 'failed', 'outcome_unknown'].includes(value.commit as string | null)) return undefined;
  return { nativeInstalled: value.nativeInstalled, commit: value.commit as NonNullable<OrganizationCallDetail['provision']>['commit'] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isReference(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128
    && !/[^a-zA-Z0-9._:-]/.test(value));
}

function isRunReference(value: unknown): value is string | null {
  return isReference(value) || (typeof value === 'string' && value.startsWith('manual:')
    && isReference(value.slice(7)) && value.length > 7);
}

function isHash(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
}

export async function matchesOrganizationIdentity(
  reference: string | null,
  hash: string | null,
  identity: string,
): Promise<boolean> {
  if (reference !== null) return hash === null && reference === identity;
  if (hash === null) return false;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') === hash;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
