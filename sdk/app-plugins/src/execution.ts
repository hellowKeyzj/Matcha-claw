import { validateRuntimeEndpointRef, validateSessionIdentity, type RuntimeEndpointRef, type SessionIdentity } from './identity.js';
import { SUPPORTED_LANGUAGE_CODES, type SupportedLanguageCode } from './language.js';

export interface AppAgentTarget {
  readonly endpoint: RuntimeEndpointRef;
  readonly agentId: string;
}

export interface AppAgent extends AppAgentTarget {
  readonly name: string;
  readonly ready: boolean;
}

export interface AppSession {
  readonly identity: SessionIdentity;
  readonly endpointSessionId: string | null;
}

export type AppSessionCreated =
  | { readonly outcome: 'created'; readonly session: AppSession }
  | { readonly outcome: 'target_rejected' | 'unknown' };

export interface AppSessionSendRequest {
  readonly identity: SessionIdentity;
  readonly message: string;
  /** Persist before sending. An unknown response must not be retried as a new task. */
  readonly idempotencyKey: string;
}

export type AppSessionSendResult =
  | { readonly outcome: 'accepted'; readonly runId: string; readonly queued: boolean }
  | { readonly outcome: 'target_rejected' | 'unknown' };

export interface AppSessionRunRequest {
  readonly identity: SessionIdentity;
  readonly runId: string;
}

export type AppSessionPhase = 'queued' | 'started' | 'yielded' | 'waiting_for_approval'
  | 'cancellation_requested' | 'cancelled' | 'completed' | 'failed' | 'interrupted';

export interface AppSessionRun {
  readonly identity: SessionIdentity;
  readonly runId: string;
  /** Null when the full current runtime facts are unavailable; not evidence of completion. */
  readonly runtime: {
    readonly phase: AppSessionPhase;
    readonly activeRunId: string | null;
    readonly issue: 'unknown' | 'unavailable' | 'timeout' | 'rejected' | null;
  } | null;
  readonly messagesStatus: 'complete' | 'incomplete' | 'unknown' | 'unavailable';
  /** Outputs proven by the native runtime to belong to the requested run. */
  readonly messages: readonly {
    /** Native assistant item identity, or null when the runtime exposes only a run result. */
    readonly itemId: string | null;
    readonly text: string;
    readonly status: 'pending' | 'streaming' | 'waiting_for_tool' | 'final' | 'error' | 'aborted';
  }[];
  /** Completeness of the native final output (same scope as messagesStatus), not all run assistant history/text blocks, the whole SessionView, or business success. */
  readonly complete: boolean;
}

export type AppTeamScope =
  | { readonly kind: 'runtime-instance'; readonly endpoint: RuntimeEndpointRef }
  | { readonly kind: 'agent'; readonly endpoint: RuntimeEndpointRef; readonly agentId: string };

export interface AppTeam {
  readonly teamId: string;
  readonly name: string;
  readonly scope: AppTeamScope;
  readonly packagePath: string;
  readonly sourceType: 'teamskill' | 'manual';
}

export interface AppTeamRunTarget {
  readonly scope: AppTeamScope;
  readonly teamId: string;
  readonly runId: string;
}

export interface AppTeamRunCreateRequest {
  readonly scope: AppTeamScope;
  readonly teamId: string;
  readonly packagePath: string;
  readonly sourceType: 'teamskill' | 'manual';
  readonly sourceAgentId?: string;
  readonly runId: string;
  readonly idempotencyKey: string;
}

export type AppTeamRunStatus = 'created' | 'provisioning' | 'waiting_for_user' | 'running'
  | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export type AppTeamApprovalDecision = 'approve' | 'deny' | 'abort';
export interface AppTeamApproval {
  readonly approvalId: string;
  readonly runId: string;
  readonly subject: 'stage' | 'work_node' | 'human_decision';
  readonly nodeId: string | null;
  readonly stageId: string;
  readonly roleId: string;
  readonly reason: string;
  readonly requestedAction: string;
  readonly status: 'pending' | 'approved' | 'denied' | 'aborted';
  readonly decision: AppTeamApprovalDecision | null;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
}

export interface AppTeamApprovalResolveRequest extends AppTeamRunTarget {
  readonly approvalId: string;
  /** Proposed decision; Main always requests a fresh trusted human confirmation. */
  readonly decision: AppTeamApprovalDecision;
  readonly note?: string;
  /** Persist before requesting review; unknown results must be read back, never blindly retried. */
  readonly idempotencyKey: string;
  /** Language of the Host-owned review, defaults to English. */
  readonly language?: SupportedLanguageCode;
}

export type AppTeamApprovalResolveResult =
  | { readonly outcome: 'recorded' | 'replayed' }
  | { readonly outcome: 'cancelled' | 'target_rejected' | 'unknown' };

export interface AppTeamRun extends AppTeamRunTarget {
  readonly status: AppTeamRunStatus;
  readonly revision: number;
  readonly designEpoch: string | null;
  readonly graphVersion: string | null;
  /** Native public records, including history; no attempt fence or private approval payload is exposed. */
  readonly approvals: readonly AppTeamApproval[];
  readonly artifacts: readonly { readonly id: string; readonly title: string; readonly contentRef: string; readonly summary?: string }[];
  /** Completeness of this result view, not execution success; incomplete bodies are never exposed. */
  readonly messagesStatus: 'complete' | 'incomplete' | 'unavailable';
  readonly messages: readonly { readonly id: string; readonly body: string }[];
}

export type AppSessionExecutionResult =
  | (AppSessionRun & { readonly terminal: 'completed' | 'failed' | 'cancelled' | 'interrupted' })
  | { readonly outcome: 'unknown'; readonly runId?: string };

export interface AppExecutionInputs {
  listAgents: Record<string, never>;
  createSession: AppAgentTarget;
  sendMessage: AppSessionSendRequest;
  sendAndWaitSession: AppSessionSendRequest;
  readSession: AppSessionRunRequest;
  cancelSession: AppSessionRunRequest;
  listTeams: Record<string, never>;
  createTeamRun: AppTeamRunCreateRequest;
  readTeamRun: AppTeamRunTarget;
  resolveTeamApproval: AppTeamApprovalResolveRequest;
  importTeamGraph: AppTeamRunTarget & { readonly yaml: string; readonly idempotencyKey: string };
  startTeamRun: AppTeamRunTarget & { readonly designEpoch: string | null; readonly expectedGraphVersion: string; readonly idempotencyKey: string };
  cancelTeamRun: AppTeamRunTarget & { readonly reason?: string; readonly idempotencyKey: string };
}

export interface AppExecutionResults {
  listAgents: { readonly agents: readonly AppAgent[] };
  createSession: AppSessionCreated;
  sendMessage: AppSessionSendResult;
  sendAndWaitSession: AppSessionExecutionResult;
  readSession: AppSessionRun;
  cancelSession: { readonly outcome: 'requested' | 'target_rejected' | 'unknown' };
  listTeams: { readonly teams: readonly AppTeam[] };
  createTeamRun: { readonly runId: string; readonly status: AppTeamRunStatus; readonly revision: number };
  readTeamRun: AppTeamRun;
  resolveTeamApproval: AppTeamApprovalResolveResult;
  importTeamGraph: { readonly runId: string; readonly imported: true };
  startTeamRun: { readonly outcome: 'started' };
  cancelTeamRun: { readonly outcome: 'requested' | 'target_rejected' | 'unknown' };
}

export type AppExecutionOperation = keyof AppExecutionInputs;
const executionOperations: { readonly [K in AppExecutionOperation]: true } = {
  listAgents: true, createSession: true, sendMessage: true, sendAndWaitSession: true, readSession: true, cancelSession: true,
  listTeams: true, createTeamRun: true, readTeamRun: true, resolveTeamApproval: true, importTeamGraph: true, startTeamRun: true, cancelTeamRun: true,
};
export const APP_EXECUTION_OPERATIONS: readonly AppExecutionOperation[] = Object.freeze(Object.keys(executionOperations) as AppExecutionOperation[]);
export function isAppExecutionOperation(value: unknown): value is AppExecutionOperation {
  return typeof value === 'string' && Object.hasOwn(executionOperations, value);
}

export type AppExecutionRequest = {
  [K in AppExecutionOperation]: { readonly operation: K; readonly input: AppExecutionInputs[K] };
}[AppExecutionOperation];
export type AppExecutionResult = AppExecutionResults[AppExecutionOperation];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function text(value: unknown, maximum = 4096): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0');
}
function teamScope(value: unknown): value is AppTeamScope {
  return record(value) && validateRuntimeEndpointRef(value.endpoint) === null
    && ((value.kind === 'runtime-instance' && fields(value, ['kind', 'endpoint']))
      || (value.kind === 'agent' && fields(value, ['kind', 'endpoint', 'agentId']) && text(value.agentId)));
}
function teamTarget(value: Record<string, unknown>): boolean {
  return teamScope(value.scope) && text(value.teamId) && text(value.runId);
}

/** The same closed input contract is used by CJS, stdio and the Main execution boundary. */
export function isAppExecutionRequest(value: unknown): value is AppExecutionRequest {
  if (!record(value) || !fields(value, ['operation', 'input']) || !isAppExecutionOperation(value.operation) || !record(value.input)) return false;
  const input = value.input;
  switch (value.operation) {
    case 'listAgents':
    case 'listTeams': return fields(input, []);
    case 'createSession': return fields(input, ['endpoint', 'agentId']) && validateRuntimeEndpointRef(input.endpoint) === null && text(input.agentId);
    case 'sendAndWaitSession':
    case 'sendMessage': return fields(input, ['identity', 'message', 'idempotencyKey']) && validateSessionIdentity(input.identity) === null
      && text(input.message, 65536) && new TextEncoder().encode(input.message).byteLength <= 65536 && text(input.idempotencyKey);
    case 'readSession':
    case 'cancelSession': return fields(input, ['identity', 'runId']) && validateSessionIdentity(input.identity) === null && text(input.runId);
    case 'createTeamRun': return fields(input, ['scope', 'teamId', 'packagePath', 'sourceType', 'runId', 'idempotencyKey'], ['sourceAgentId'])
      && teamTarget(input) && text(input.packagePath) && text(input.idempotencyKey)
      && (input.sourceType === 'teamskill' || input.sourceType === 'manual')
      && (input.sourceAgentId === undefined || text(input.sourceAgentId))
      && (input.sourceType !== 'manual' || input.sourceAgentId === undefined);
    case 'readTeamRun': return fields(input, ['scope', 'teamId', 'runId']) && teamTarget(input);
    case 'resolveTeamApproval': return fields(input, ['scope', 'teamId', 'runId', 'approvalId', 'decision', 'idempotencyKey'], ['note', 'language'])
      && teamTarget(input) && typeof input.approvalId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input.approvalId)
      && typeof input.idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey)
      && (input.decision === 'approve' || input.decision === 'deny' || input.decision === 'abort')
      && (input.note === undefined || (text(input.note, 256) && new TextEncoder().encode(input.note).byteLength <= 256))
      && (input.language === undefined || (SUPPORTED_LANGUAGE_CODES as readonly unknown[]).includes(input.language));
    case 'importTeamGraph': return fields(input, ['scope', 'teamId', 'runId', 'yaml', 'idempotencyKey']) && teamTarget(input)
      && text(input.yaml, 768 * 1024) && new TextEncoder().encode(input.yaml).byteLength <= 768 * 1024 && text(input.idempotencyKey);
    case 'startTeamRun': return fields(input, ['scope', 'teamId', 'runId', 'designEpoch', 'expectedGraphVersion', 'idempotencyKey'])
      && teamTarget(input) && (input.designEpoch === null || text(input.designEpoch)) && text(input.expectedGraphVersion) && text(input.idempotencyKey);
    case 'cancelTeamRun': return fields(input, ['scope', 'teamId', 'runId', 'idempotencyKey'], ['reason']) && teamTarget(input)
      && text(input.idempotencyKey) && (input.reason === undefined || text(input.reason, 2000));
  }
}

/** Native runtimes keep execution and authorization ownership. This API never uses the active chat selection. */
export type AppExecutionApi = {
  readonly [K in AppExecutionOperation]: (input: AppExecutionInputs[K], signal?: AbortSignal) => Promise<AppExecutionResults[K]>;
};
