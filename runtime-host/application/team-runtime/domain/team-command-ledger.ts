import type { RuntimeEndpointRef } from '../../agent-runtime/contracts/runtime-address';
import type { TeamNodeResult } from '../graph/run-state';
import type { TeamEvidenceRef } from './team-evidence';

export type TeamAgentCommandType = 'team.node_event' | 'team.graph_patch';

export type TeamAgentCommandStatus = 'accepted' | 'rejected';

export type TeamNodeEventKind =
  | 'progress'
  | 'request_input'
  | 'request_approval'
  | 'reject'
  | 'complete';

export interface TeamAgentCommandBase {
  readonly type: TeamAgentCommandType;
  readonly commandId: string;
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly sourceEndpoint: RuntimeEndpointRef;
  readonly sourceAgentId: string;
  readonly sourceRuntimeAdapterId?: string;
  readonly sourceRoleId?: string;
  readonly sourceLocalSessionId?: string;
  readonly sourceEndpointSessionId?: string;
  readonly createdAt: number;
}

export interface TeamNodeEventCommand extends TeamAgentCommandBase {
  readonly type: 'team.node_event';
  readonly nodeExecutionId: string;
  readonly event: TeamNodeEventKind;
  readonly roleId?: string;
  readonly summary: string;
  readonly outputPort?: string;
  readonly result?: TeamNodeResult;
  readonly evidenceRefs?: readonly TeamEvidenceRef[];
  readonly requestedAction?: string;
  readonly risk?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface TeamGraphPatchCommand extends TeamAgentCommandBase {
  readonly type: 'team.graph_patch';
  readonly summary: string;
  readonly patch: TeamGraphPatch;
  readonly metadata?: Record<string, unknown>;
}

export type TeamGraphPatchOperation =
  | { readonly op: 'add_node' | 'replace_node'; readonly node: Record<string, unknown> }
  | { readonly op: 'remove_node'; readonly nodeId: string }
  | { readonly op: 'add_edge' | 'replace_edge'; readonly edge: Record<string, unknown> }
  | { readonly op: 'remove_edge'; readonly edgeId: string }
  | { readonly op: 'set_metadata'; readonly metadata: Record<string, unknown> };

export interface TeamGraphPatch {
  readonly baseGraphId?: string;
  readonly baseWorkflowPlanId?: string;
  readonly operations: readonly TeamGraphPatchOperation[];
}

export type TeamAgentCommand = TeamNodeEventCommand | TeamGraphPatchCommand;

export interface TeamAgentCommandLedgerRecord {
  readonly recordId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly commandId: string;
  readonly type: TeamAgentCommandType;
  readonly idempotencyKey: string;
  readonly command: TeamAgentCommand;
  readonly status: TeamAgentCommandStatus;
  readonly rejectionReason?: string;
  readonly createdAt: number;
  readonly acceptedAt?: number;
  readonly rejectedAt?: number;
}
