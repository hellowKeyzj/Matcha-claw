import { badRequest } from '../../common/application-response';
import type { TeamRuntimeOperationId } from '../../team-runtime/team-runtime-operation-id';
import type { TeamRuntimePort } from '../../team-runtime/team-runtime-port';
import type { CapabilityTarget, RuntimeScope } from '../../agent-runtime/contracts/runtime-address';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const TEAM_RUNTIME_CAPABILITY_ID = 'team.runtime';

export const teamRuntimeCapabilityOperations = [
  { id: 'team.packageValidate', title: 'Validate TeamSkill package', targetKind: 'team' },
  { id: 'team.dependencyPlan', title: 'Plan TeamSkill dependencies', targetKind: 'team' },
  { id: 'team.provisionAgents', title: 'Provision Team managed agents', targetKind: 'team' },
  { id: 'team.delete', title: 'Delete Team', targetKind: 'team' },
  { id: 'team.runCreate', title: 'Create TeamRun', targetKind: 'team' },
  { id: 'team.runList', title: 'List TeamRuns', targetKind: 'team' },
  { id: 'team.triggerList', title: 'List TeamRun armed triggers', targetKind: 'team' },
  { id: 'team.webhookTriggerFire', title: 'Fire TeamRun webhook trigger by path', targetKind: 'team' },
  { id: 'team.runSnapshot', title: 'Read TeamRun snapshot', targetKind: 'team-run' },
  { id: 'team.graphSave', title: 'Save TeamRun graph config', targetKind: 'team-run' },
  { id: 'team.graphPatch', title: 'Submit TeamRun graph patch command', targetKind: 'team-run' },
  { id: 'team.graphContext', title: 'Read compact TeamRun graph context', targetKind: 'team-run' },
  { id: 'team.graphExportYaml', title: 'Export TeamRun graph YAML', targetKind: 'team-run' },
  { id: 'team.graphImportYaml', title: 'Import TeamRun graph YAML', targetKind: 'team-run' },
  { id: 'team.triggerFire', title: 'Fire TeamRun StartNode trigger', targetKind: 'team-run' },
  { id: 'team.roleMessageSubmit', title: 'Submit Team role chat message', targetKind: 'team-run' },
  { id: 'team.nodePromptRetryDue', title: 'Wake due TeamRun node prompt retries', targetKind: 'team-run' },
  { id: 'team.nodeEvent', title: 'Submit TeamRun node event command', targetKind: 'team-run' },
  { id: 'team.runDiagnostics', title: 'Read TeamRun diagnostics', targetKind: 'team-run' },
  { id: 'team.runDecisionSubmit', title: 'Submit TeamRun decision', targetKind: 'team-run' },
  { id: 'team.resume', title: 'Resume Team', targetKind: 'team' },
  { id: 'team.approvalResolve', title: 'Resolve Team approval', targetKind: 'team-approval' },
  { id: 'team.runCancel', title: 'Cancel TeamRun', targetKind: 'team-run' },
  { id: 'team.runDelete', title: 'Delete TeamRun', targetKind: 'team-run' },
] as const satisfies readonly CapabilityOperationDescriptor[];

const TEAM_RUNTIME_OPERATION_IDS = new Set<TeamRuntimeOperationId>(
  teamRuntimeCapabilityOperations.map((operation) => operation.id),
);

export function createTeamRuntimeCapabilityOperationRoutes(deps: {
  teamRuntimeService: TeamRuntimePort;
}): readonly CapabilityOperationRoute[] {
  return teamRuntimeCapabilityOperations.map((operation) => ({
    capabilityId: TEAM_RUNTIME_CAPABILITY_ID,
    operationId: operation.id,
    handle: (context) => {
      const operationId = readOperationId(context.operationId);
      const targetError = validateTeamRuntimeTargetInput(operationId, context.target, context.domainInput, context.scope);
      if (targetError) {
        return badRequest(targetError);
      }
      return deps.teamRuntimeService.invoke(operationId, context.domainInput, context.scope);
    },
  }));
}

function validateTeamRuntimeTargetInput(
  operationId: TeamRuntimeOperationId,
  target: CapabilityTarget | null,
  input: Record<string, unknown>,
  scope: RuntimeScope,
): string | null {
  switch (operationId) {
    case 'team.packageValidate':
    case 'team.dependencyPlan':
      return validateMatchingRequiredString(target, 'packagePath', input, 'packagePath');
    case 'team.provisionAgents':
      return validateMatchingRequiredString(target, 'packagePath', input, 'packagePath')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateRequiredInputString(input, 'idempotencyKey')
        ?? validateManualTeamInput(input);
    case 'team.delete':
      return validateMatchingRequiredString(target, 'teamId', input, 'teamId');
    case 'team.resume':
      return validateMatchingRequiredString(target, 'teamId', input, 'teamId')
        ?? validateRequiredInputString(input, 'idempotencyKey');
    case 'team.runCreate':
      return validateMatchingRequiredString(target, 'packagePath', input, 'packagePath')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateRequiredInputString(input, 'idempotencyKey')
        ?? validateSourceTypeInput(input);
    case 'team.runList':
      return validateMatchingRequiredString(target, 'teamId', input, 'teamId');
    case 'team.triggerList':
      // Internal runtime-host cron scheduler enumerates armed triggers across all
      // non-terminal runs; this is not a renderer-targeted, per-team operation.
      return null;
    case 'team.webhookTriggerFire':
      return validateRequiredInputString(input, 'webhookPath');
    case 'team.runCancel':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateRequiredInputString(input, 'idempotencyKey')
        ?? validateTeamRunScope(target, scope);
    case 'team.graphSave':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateRequiredInputString(input, 'idempotencyKey')
        ?? validateRequiredInputObject(input, 'graph')
        ?? validateTeamRunScope(target, scope);
    case 'team.graphImportYaml':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateRequiredInputString(input, 'idempotencyKey')
        ?? validateRequiredInputString(input, 'yaml')
        ?? validateTeamRunScope(target, scope);
    case 'team.graphPatch':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateRequiredInputString(input, 'summary')
        ?? validateRequiredInputObject(input, 'patch')
        ?? validateRequiredInputString(input, 'idempotencyKey')
        ?? validateTeamRunScope(target, scope)
        ?? validateRequiredGraphPatchOperations(input);
    case 'team.triggerFire':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateRequiredInputString(input, 'startNodeId')
        ?? validateRequiredInputString(input, 'triggerSource')
        ?? validateRequiredInputString(input, 'idempotencyKey')
        ?? validateTeamRunScope(target, scope);
    case 'team.roleMessageSubmit':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateRequiredInputString(input, 'roleId')
        ?? validateRequiredInputString(input, 'text')
        ?? validateRequiredInputString(input, 'idempotencyKey')
        ?? validateTeamRunScope(target, scope);
    case 'team.nodeEvent':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateRequiredInputString(input, 'nodeExecutionId')
        ?? validateRequiredInputString(input, 'event')
        ?? validateRequiredInputString(input, 'summary')
        ?? validateRequiredInputString(input, 'idempotencyKey')
        ?? validateTeamRunScope(target, scope);
    case 'team.runDecisionSubmit':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateRequiredInputString(input, 'decision')
        ?? validateRequiredInputString(input, 'idempotencyKey')
        ?? validateTeamRunScope(target, scope);
    case 'team.runSnapshot':
    case 'team.graphContext':
    case 'team.graphExportYaml':
    case 'team.runDiagnostics':
    case 'team.nodePromptRetryDue':
    case 'team.runDelete':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateTeamRunScope(target, scope);
    case 'team.approvalResolve':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingRequiredString(target, 'approvalId', input, 'approvalId')
        ?? validateRequiredInputString(input, 'decision')
        ?? validateRequiredInputString(input, 'idempotencyKey');
  }
}

function validateMatchingRequiredString(
  target: CapabilityTarget | null,
  targetField: string,
  input: Record<string, unknown>,
  inputField: string,
): string | null {
  const targetValue = readStringField(target, targetField);
  const inputValue = readStringField(input, inputField);
  if (!targetValue || !inputValue) {
    return `Team runtime ${targetField}/${inputField} is required`;
  }
  return targetValue === inputValue ? null : `Team runtime target ${targetField} must match input ${inputField}`;
}

function validateMatchingOptionalString(
  target: CapabilityTarget | null,
  targetField: string,
  input: Record<string, unknown>,
  inputField: string,
): string | null {
  const targetValue = readStringField(target, targetField);
  const inputValue = readStringField(input, inputField);
  if (!targetValue && !inputValue) {
    return null;
  }
  if (!targetValue || !inputValue) {
    return `Team runtime target ${targetField} must match input ${inputField}`;
  }
  return targetValue === inputValue ? null : `Team runtime target ${targetField} must match input ${inputField}`;
}

function validateRequiredInputString(input: Record<string, unknown>, inputField: string): string | null {
  return readStringField(input, inputField) ? null : `Team runtime input ${inputField} is required`;
}

function validateRequiredInputObject(input: Record<string, unknown>, inputField: string): string | null {
  const value = input[inputField];
  return value && typeof value === 'object' && !Array.isArray(value) ? null : `Team runtime input ${inputField} is required`;
}

function validateRequiredGraphPatchOperations(input: Record<string, unknown>): string | null {
  const patch = input.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Team runtime input patch is required';
  const operations = (patch as Record<string, unknown>).operations;
  return Array.isArray(operations) && operations.length > 0 ? null : 'Team runtime input patch.operations must be a non-empty array';
}

function validateManualTeamInput(input: Record<string, unknown>): string | null {
  const sourceTypeError = validateSourceTypeInput(input);
  if (sourceTypeError) return sourceTypeError;
  if (readStringField(input, 'sourceType') !== 'manual') return null;
  const manualTeam = input.manualTeam;
  if (!manualTeam || typeof manualTeam !== 'object' || Array.isArray(manualTeam)) return 'Team runtime input manualTeam is required';
  const members = (manualTeam as Record<string, unknown>).members;
  return Array.isArray(members) && members.length > 0 ? null : 'Team runtime input manualTeam.members must be a non-empty array';
}

function validateSourceTypeInput(input: Record<string, unknown>): string | null {
  const sourceType = readStringField(input, 'sourceType');
  if (!sourceType || sourceType === 'teamskill' || sourceType === 'manual') return null;
  return 'Team runtime input sourceType must be teamskill or manual';
}

function validateTeamRunScope(target: CapabilityTarget | null, scope: RuntimeScope): string | null {
  if (scope.kind !== 'team-run') {
    return null;
  }
  const targetRunId = readStringField(target, 'runId');
  if (targetRunId !== scope.runId) {
    return 'Team runtime target runId must match scope runId';
  }
  const targetTeamId = readStringField(target, 'teamId');
  if (targetTeamId !== readStringField(scope, 'teamId')) {
    return 'Team runtime target teamId must match scope teamId';
  }
  return null;
}

function readStringField(input: unknown, field: string): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readOperationId(value: string): TeamRuntimeOperationId {
  if (TEAM_RUNTIME_OPERATION_IDS.has(value as TeamRuntimeOperationId)) {
    return value as TeamRuntimeOperationId;
  }
  throw new Error(`Unsupported Team runtime operation: ${value}`);
}
