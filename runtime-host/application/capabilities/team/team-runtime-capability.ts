import { badRequest } from '../../common/application-response';
import type { TeamSkillService } from '../../team-skill/team-skill-service';
import type { TeamRuntimeOperationId } from '../../workflows/team-skill/team-skill-gateway-workflow';
import type { CapabilityTarget, RuntimeScope } from '../../agent-runtime/contracts/runtime-address';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const TEAM_RUNTIME_CAPABILITY_ID = 'team.runtime';

export const teamRuntimeCapabilityOperations = [
  { id: 'team.packageValidate', title: 'Validate TeamSkill package', targetKind: 'team' },
  { id: 'team.dependencyPlan', title: 'Plan TeamSkill dependencies', targetKind: 'team' },
  { id: 'team.runCreate', title: 'Create TeamRun', targetKind: 'team' },
  { id: 'team.runStart', title: 'Start TeamRun', targetKind: 'team-run' },
  { id: 'team.runSnapshot', title: 'Read TeamRun snapshot', targetKind: 'team-run' },
  { id: 'team.runDiagnostics', title: 'Read TeamRun diagnostics', targetKind: 'team-run' },
  { id: 'team.runDecisionSubmit', title: 'Submit TeamRun decision', targetKind: 'team-run' },
  { id: 'team.planWorkflow', title: 'Plan TeamRun workflow', targetKind: 'team-run' },
  { id: 'team.runTick', title: 'Tick TeamRun', targetKind: 'team-run' },
  { id: 'team.approvalResolve', title: 'Resolve Team approval', targetKind: 'team-approval' },
  { id: 'team.runCancel', title: 'Cancel TeamRun', targetKind: 'team-run' },
  { id: 'team.runDelete', title: 'Delete TeamRun', targetKind: 'team-run' },
] as const satisfies readonly CapabilityOperationDescriptor[];

const TEAM_RUNTIME_OPERATION_IDS = new Set<TeamRuntimeOperationId>(
  teamRuntimeCapabilityOperations.map((operation) => operation.id),
);

export function createTeamRuntimeCapabilityOperationRoutes(deps: {
  teamSkillService: TeamSkillService;
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
      return deps.teamSkillService.invoke(operationId, context.domainInput, context.scope);
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
    case 'team.runCreate':
      return validateMatchingRequiredString(target, 'packagePath', input, 'packagePath');
    case 'team.runStart':
    case 'team.runSnapshot':
    case 'team.runDiagnostics':
    case 'team.runDecisionSubmit':
    case 'team.runTick':
    case 'team.runCancel':
    case 'team.runDelete':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingOptionalString(target, 'teamId', input, 'teamId')
        ?? validateTeamRunScope(target, scope);
    case 'team.planWorkflow':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateRequiredInputString(input, 'title')
        ?? validateRequiredInputArray(input, 'groups')
        ?? validateRequiredInputArray(input, 'tasks')
        ?? validateTeamRunScope(target, scope);
    case 'team.approvalResolve':
      return validateMatchingRequiredString(target, 'runId', input, 'runId')
        ?? validateMatchingRequiredString(target, 'approvalId', input, 'approvalId')
        ?? validateRequiredInputString(input, 'decision');
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

function validateRequiredInputArray(input: Record<string, unknown>, inputField: string): string | null {
  const value = input[inputField];
  return Array.isArray(value) ? null : `Team runtime input ${inputField} is required`;
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
