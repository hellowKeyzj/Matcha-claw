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
  ['team.proposalConfirm', 'Confirm TeamRun start proposal', 'team-run'],
  ['team.proposalContinue', 'Continue TeamRun start discussion', 'team-run'],
  ['team.proposalCancel', 'Cancel TeamRun start proposal', 'team-run'],
  ['team.nodePromptRetryDue', 'Wake due TeamRun node prompt retries', 'team-run'],
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
      return hasExactKeys(input, []) && isTriggerListTarget(target);
    case 'team.webhookTriggerFire':
      return hasExactKeys(input, ['webhookPath', 'idempotencyKey'])
        && isWebhookTriggerTarget(target)
        && isText(input.webhookPath)
        && isOpaque(input.idempotencyKey);
    case 'team.approvalResolve':
      return hasOnlyKeys(input, ['runId', 'approvalId', 'decision', 'note', 'idempotencyKey'])
        && hasRequiredKeys(input, ['runId', 'approvalId', 'decision', 'idempotencyKey'])
        && matchingString(target, 'team-approval', 'runId', input, 'runId')
        && matchingField(target, 'approvalId', input, 'approvalId')
        && (input.decision === 'approve' || input.decision === 'deny' || input.decision === 'abort')
        && (input.note === undefined || isText(input.note))
        && isOpaque(input.idempotencyKey);
    case 'team.runSnapshot':
    case 'team.graphExportYaml':
    case 'team.runDiagnostics':
    case 'team.nodePromptRetryDue':
      return matchingRunTarget(target, input) && optionalRunReadFields(operation, input);
    case 'team.runDelete':
      return hasExactKeys(input, ['runId']) && matchingRunTarget(target, input);
    case 'team.graphContext':
      return isGraphContextRequest(target, input);
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
      return hasExactKeys(input, ['runId', 'yaml', 'idempotencyKey'])
        && matchingRunTarget(target, input)
        && isNonEmptyString(input.yaml)
        && isOpaque(input.idempotencyKey);
    case 'team.triggerFire':
      return hasOnlyKeys(input, ['runId', 'teamId', 'startNodeId', 'triggerSource', 'payloadSummary', 'idempotencyKey'])
        && hasRequiredKeys(input, ['runId', 'startNodeId', 'triggerSource', 'idempotencyKey'])
        && matchingRunTarget(target, input)
        && isIdentifier(input.startNodeId)
        && (input.triggerSource === 'cron' || input.triggerSource === 'webhook')
        && (input.payloadSummary === undefined || typeof input.payloadSummary === 'string')
        && isOpaque(input.idempotencyKey);
    case 'team.proposalConfirm':
    case 'team.proposalContinue':
    case 'team.proposalCancel':
      return hasOnlyKeys(input, ['runId', 'teamId', 'proposalId', 'idempotencyKey'])
        && hasRequiredKeys(input, ['runId', 'proposalId', 'idempotencyKey'])
        && matchingRunTarget(target, input)
        && isOpaque(input.proposalId)
        && isOpaque(input.idempotencyKey);
    case 'team.nodeEvent':
      return isNodeEventRequest(target, input);
    case 'team.runDecisionSubmit':
      return hasOnlyKeys(input, ['runId', 'decision', 'note', 'idempotencyKey'])
        && hasRequiredKeys(input, ['runId', 'decision', 'idempotencyKey'])
        && matchingRunTarget(target, input)
        && (input.decision === 'retry' || input.decision === 'proceed_degraded' || input.decision === 'abort')
        && (input.note === undefined || isText(input.note))
        && isOpaque(input.idempotencyKey);
    case 'team.resume':
      return matchingString(target, 'team', 'teamId', input, 'teamId') && isOpaque(input.idempotencyKey);
    case 'team.runCancel':
      return hasOnlyKeys(input, ['runId', 'teamId', 'reason', 'idempotencyKey'])
        && hasRequiredKeys(input, ['runId', 'idempotencyKey'])
        && matchingRunTarget(target, input)
        && isOpaque(input.idempotencyKey)
        && (input.reason === undefined || typeof input.reason === 'string');
  }
}

function matchingRunTarget(target: unknown, input: Record<string, unknown>): boolean {
  return matchingString(target, 'team-run', 'runId', input, 'runId')
    && matchingOptionalString(target, 'teamId', input, 'teamId');
}

function matchingRequiredTeamRunTarget(target: unknown, input: Record<string, unknown>): boolean {
  return isRecord(target)
    && hasExactKeys(target, ['kind', 'runId', 'teamId'])
    && target.kind === 'team-run'
    && matchingField(target, 'runId', input, 'runId')
    && matchingField(target, 'teamId', input, 'teamId');
}

function optionalRunReadFields(operation: TeamRuntimeOperationId, input: Record<string, unknown>): boolean {
  if (operation !== 'team.runSnapshot') return true;
  return (input.eventCursor === undefined || isNonNegativeInteger(input.eventCursor))
    && (input.eventLimit === undefined || isNonNegativeInteger(input.eventLimit));
}

function isTriggerListTarget(target: unknown): boolean {
  return target === null
    || (isRecord(target) && hasExactKeys(target, ['kind']) && target.kind === 'team')
    || (isRecord(target) && hasExactKeys(target, ['kind', 'teamId']) && target.kind === 'team' && isIdentifier(target.teamId));
}

function isWebhookTriggerTarget(target: unknown): boolean {
  return target === null
    || (isRecord(target) && hasExactKeys(target, ['kind']) && target.kind === 'team');
}

function isGraphContextRequest(target: unknown, input: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(input, ['runId', 'teamId', 'view', 'nodeExecutionId'])
    || !hasRequiredKeys(input, ['runId', 'teamId', 'view'])
    || !matchingRequiredTeamRunTarget(target, input)) {
    return false;
  }

  if (input.view === 'graph_summary' || input.view === 'graphSummary') {
    return !Object.hasOwn(input, 'nodeExecutionId');
  }
  if (input.view === 'current_node' || input.view === 'currentNode') {
    return isIdentifier(input.nodeExecutionId);
  }
  return false;
}

function isNodeEventRequest(target: unknown, input: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(input, [
    'runId',
    'nodeExecutionId',
    'event',
    'summary',
    'idempotencyKey',
    'roleId',
    'outputPort',
    'evidenceRefs',
    'requestedAction',
    'risk',
    'metadata',
    'result',
    'deliveryId',
    'receipt',
    'nodeId',
    'attemptNumber',
  ]) || !matchingRunTarget(target, input)
    || !isOpaque(input.nodeExecutionId)
    || !isOpaque(input.idempotencyKey)
    || !isText(input.summary)
    || !areValidNodeEventOptionalFields(input)) {
    return false;
  }

  switch (input.event) {
    case 'progress':
    case 'request_input':
      return hasExactKeys(input, ['runId', 'nodeExecutionId', 'event', 'summary', 'idempotencyKey']);
    case 'request_approval':
      return hasRequiredKeys(input, ['runId', 'nodeExecutionId', 'event', 'summary', 'idempotencyKey', 'requestedAction'])
        && isApprovalAction(input.requestedAction);
    case 'complete':
    case 'reject':
      return hasRequiredKeys(input, [
        'runId',
        'nodeExecutionId',
        'event',
        'summary',
        'idempotencyKey',
        'deliveryId',
        'receipt',
        'nodeId',
        'attemptNumber',
        'outputPort',
      ])
        && isText(input.deliveryId)
        && isText(input.receipt)
        && isIdentifier(input.nodeId)
        && isPositiveInteger(input.attemptNumber)
        && isText(input.outputPort);
    default:
      return false;
  }
}

function areValidNodeEventOptionalFields(input: Record<string, unknown>): boolean {
  return (input.roleId === undefined || isOpaque(input.roleId))
    && (input.outputPort === undefined || isText(input.outputPort))
    && (input.evidenceRefs === undefined || Array.isArray(input.evidenceRefs))
    && (input.requestedAction === undefined || isApprovalAction(input.requestedAction))
    && (input.risk === undefined || isText(input.risk))
    && (input.metadata === undefined || isRecord(input.metadata))
    && (input.result === undefined || isNodeEventResult(input.result));
}

function isNodeEventResult(value: unknown): boolean {
  return isRecord(value) && (value.summary === undefined || isText(value.summary));
}

function isApprovalAction(value: unknown): boolean {
  return value === 'continue_node'
    || value === 'execute_tool'
    || value === 'publish_result'
    || value === 'external_action';
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const allowed = new Set(expected);
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasRequiredKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return expected.every((key) => Object.hasOwn(value, key));
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
