import {
  buildCapabilityScopeKey,
  validateRuntimeScope,
  type RuntimeScope,
} from '../../desktop-contract/runtime-address';

export const TEAM_RUNTIME_CAPABILITY_ID = 'team.runtime';

const TEAM_RUNTIME_SCOPE: RuntimeScope = {
  kind: 'runtime-instance',
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
};

const TEAM_RUNTIME_OPERATIONS = [
  ['team.packageValidate', 'Validate TeamSkill package', 'team'],
  ['team.dependencyPlan', 'Plan TeamSkill dependencies', 'team'],
  ['team.provisionAgents', 'Provision Team managed agents', 'team'],
  ['team.delete', 'Delete Team', 'team'],
  ['team.runCreate', 'Create TeamRun', 'team'],
  ['team.runList', 'List TeamRuns', 'team'],
  ['team.triggerList', 'List TeamRun armed triggers', 'team'],
  ['team.webhookTriggerFire', 'Fire TeamRun webhook trigger by path', 'team'],
  ['team.runSnapshot', 'Read TeamRun snapshot', 'team-run'],
  ['team.graphSave', 'Save TeamRun graph config', 'team-run'],
  ['team.graphPatch', 'Submit TeamRun graph patch command', 'team-run'],
  ['team.graphContext', 'Read compact TeamRun graph context', 'team-run'],
  ['team.graphExportYaml', 'Export TeamRun graph YAML', 'team-run'],
  ['team.graphImportYaml', 'Import TeamRun graph YAML', 'team-run'],
  ['team.triggerFire', 'Fire TeamRun StartNode trigger', 'team-run'],
  ['team.roleMessageSubmit', 'Submit Team role chat message', 'team-run'],
  ['team.nodePromptRetryDue', 'Wake due TeamRun node prompt retries', 'team-run'],
  ['team.nodePromptSettled', 'Wake TeamRun after a node prompt session turn settles', 'none'],
  ['team.nodeEvent', 'Submit TeamRun node event command', 'team-run'],
  ['team.runDiagnostics', 'Read TeamRun diagnostics', 'team-run'],
  ['team.runDecisionSubmit', 'Submit TeamRun decision', 'team-run'],
  ['team.resume', 'Resume Team', 'team'],
  ['team.approvalResolve', 'Resolve Team approval', 'team-approval'],
  ['team.runCancel', 'Cancel TeamRun', 'team-run'],
  ['team.runDelete', 'Delete TeamRun', 'team-run'],
] as const;

type TeamRuntimeOperationId = typeof TEAM_RUNTIME_OPERATIONS[number][0];
type TeamRuntimeTargetKind = typeof TEAM_RUNTIME_OPERATIONS[number][2];


export function isTeamRuntimeCapabilityRequest(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== TEAM_RUNTIME_CAPABILITY_ID
    || !isRuntimeScope(value.scope)
    || !sameRuntimeScope(value.scope, TEAM_RUNTIME_SCOPE)
    || !isRecord(value.input)) {
    return false;
  }

  const operation = readOperation(value.operationId);
  return operation !== null && validateOperation(operation, value.target, value.input);
}

function validateOperation(
  operation: TeamRuntimeOperationId,
  target: unknown,
  input: Record<string, unknown>,
): boolean {
  switch (operation) {
    case 'team.packageValidate':
    case 'team.dependencyPlan':
      return matchingString(target, 'team', 'packagePath', input, 'packagePath');
    case 'team.provisionAgents':
      return matchingString(target, 'team', 'packagePath', input, 'packagePath')
        && matchingOptionalString(target, 'teamId', input, 'teamId')
        && isOpaque(input.idempotencyKey)
        && validSourceType(input.sourceType)
        && (input.sourceType !== 'manual' || isRecord(input.manualTeam));
    case 'team.delete':
      return matchingString(target, 'team', 'teamId', input, 'teamId');
    case 'team.runCreate':
      return matchingOptionalString(target, 'teamId', input, 'teamId')
        && matchingString(target, 'team', 'packagePath', input, 'packagePath')
        && isOpaque(input.idempotencyKey)
        && validSourceType(input.sourceType)
        && (input.runId === undefined || isIdentifier(input.runId));
    case 'team.runList':
      return matchingString(target, 'team', 'teamId', input, 'teamId');
    case 'team.triggerList':
      return target === null || target === undefined || targetKind(target) === 'team';
    case 'team.webhookTriggerFire':
      return optionalTeamTarget(target) && isIdentifier(input.webhookPath);
    case 'team.nodePromptSettled':
      return optionalNoneTarget(target)
        && isIdentifier(input.sessionKey)
        && isIdentifier(input.promptRunId)
        && (input.phase === 'final' || input.phase === 'error' || input.phase === 'aborted');
    case 'team.approvalResolve':
      return matchingString(target, 'team-approval', 'runId', input, 'runId')
        && matchingField(target, 'approvalId', input, 'approvalId')
        && isIdentifier(input.decision)
        && isOpaque(input.idempotencyKey);
    case 'team.runSnapshot':
    case 'team.graphContext':
    case 'team.graphExportYaml':
    case 'team.runDiagnostics':
    case 'team.nodePromptRetryDue':
    case 'team.runDelete':
      return matchingRunTarget(target, input) && optionalRunReadFields(operation, input);
    case 'team.graphSave':
      return matchingRunTarget(target, input)
        && isOpaque(input.idempotencyKey)
        && isRecord(input.graph);
    case 'team.graphPatch':
      return matchingRunTarget(target, input)
        && isIdentifier(input.summary)
        && isRecord(input.patch)
        && Array.isArray(input.patch.operations)
        && input.patch.operations.length > 0
        && isOpaque(input.idempotencyKey);
    case 'team.graphImportYaml':
      return matchingRunTarget(target, input)
        && isIdentifier(input.yaml)
        && isOpaque(input.idempotencyKey);
    case 'team.triggerFire':
      return matchingRunTarget(target, input)
        && isIdentifier(input.startNodeId)
        && (input.triggerSource === 'cron' || input.triggerSource === 'webhook')
        && isOpaque(input.idempotencyKey);
    case 'team.roleMessageSubmit':
      return matchingRunTarget(target, input)
        && isIdentifier(input.roleId)
        && isText(input.text)
        && isOpaque(input.idempotencyKey);
    case 'team.nodeEvent':
      return matchingRunTarget(target, input)
        && isIdentifier(input.nodeExecutionId)
        && isIdentifier(input.event)
        && isIdentifier(input.summary)
        && isOpaque(input.idempotencyKey);
    case 'team.runDecisionSubmit':
      return matchingRunTarget(target, input)
        && isIdentifier(input.decision)
        && isOpaque(input.idempotencyKey);
    case 'team.resume':
      return matchingString(target, 'team', 'teamId', input, 'teamId') && isOpaque(input.idempotencyKey);
    case 'team.runCancel':
      return matchingRunTarget(target, input) && isOpaque(input.idempotencyKey)
        && (input.reason === undefined || isText(input.reason));
  }
}

function matchingRunTarget(target: unknown, input: Record<string, unknown>): boolean {
  return matchingString(target, 'team-run', 'runId', input, 'runId')
    && matchingOptionalString(target, 'teamId', input, 'teamId');
}

function optionalRunReadFields(operation: TeamRuntimeOperationId, input: Record<string, unknown>): boolean {
  if (operation !== 'team.runSnapshot') return true;
  return (input.eventCursor === undefined || isNonNegativeInteger(input.eventCursor))
    && (input.eventLimit === undefined || isNonNegativeInteger(input.eventLimit));
}

function matchingString(
  target: unknown,
  expectedKind: TeamRuntimeTargetKind,
  targetField: string,
  input: Record<string, unknown>,
  inputField: string,
): boolean {
  return targetKind(target) === expectedKind
    && matchingField(target, targetField, input, inputField);
}

function matchingField(
  target: unknown,
  targetField: string,
  input: Record<string, unknown>,
  inputField: string,
): boolean {
  const targetValue = readField(target, targetField);
  const inputValue = input[inputField];
  return isIdentifier(targetValue) && isIdentifier(inputValue) && targetValue === inputValue;
}

function matchingOptionalString(
  target: unknown,
  targetField: string,
  input: Record<string, unknown>,
  inputField: string,
): boolean {
  const targetValue = readField(target, targetField);
  const inputValue = input[inputField];
  return (targetValue === undefined && inputValue === undefined)
    || (isIdentifier(targetValue) && isIdentifier(inputValue) && targetValue === inputValue);
}

function optionalTeamTarget(target: unknown): boolean {
  return target === null || target === undefined || targetKind(target) === 'team';
}

function optionalNoneTarget(target: unknown): boolean {
  return target === null || target === undefined || targetKind(target) === 'none';
}

function targetKind(value: unknown): string | null {
  return isRecord(value) && typeof value.kind === 'string' ? value.kind : null;
}

function readField(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}

function readOperation(value: unknown): TeamRuntimeOperationId | null {
  return typeof value === 'string' && TEAM_RUNTIME_OPERATIONS.some(([id]) => id === value)
    ? value as TeamRuntimeOperationId
    : null;
}

function validSourceType(value: unknown): boolean {
  return value === undefined || value === 'teamskill' || value === 'manual';
}

function isRuntimeScope(value: unknown): value is RuntimeScope {
  return validateRuntimeScope(value) === null;
}

function sameRuntimeScope(left: RuntimeScope, right: RuntimeScope): boolean {
  return buildCapabilityScopeKey(left) === buildCapabilityScopeKey(right);
}

function isOpaque(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\p{Cc}]/u.test(value);
}

function isText(value: unknown): value is string {
  return isIdentifier(value) && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
