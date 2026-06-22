import { randomUUID } from 'node:crypto'
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { createTeamOutboxStore } from '../application/team-outbox-store-factory.js'
import type { RuntimeEndpointRef, TeamEvidenceRef, TeamFailureItem, TeamInboundEnvelope, TeamMessageKind, TeamWorkflowGroupPlan, TeamWorkflowTaskPlan } from '../domain/team-outbox.js'

export type TeamToolContext = {
  workspaceDir?: string
  agentId?: string
  sessionKey?: string
}

type ToolParams = Record<string, unknown>
type TeamToolResultPayload = Record<string, unknown>
type TeamToolResult = {
  content: { type: 'text'; text: string }[]
  rawResponse: TeamToolResultPayload
  details: TeamToolResultPayload
  renderer: { type: 'text' }
}

const OPENCLAW_LOCAL_ENDPOINT: RuntimeEndpointRef = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
}

const INLINE_TEXT_EVIDENCE_MAX_CHARS = 20000

const workflowTaskPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'roleId', 'title', 'prompt'],
  properties: {
    taskId: { type: 'string', description: 'Stable workflow task id.' },
    roleId: { type: 'string', description: 'Team role id from the role roster, never the managed runtime agent id.' },
    title: { type: 'string', description: 'Short task title.' },
    prompt: { type: 'string', description: 'Concrete instructions for the assigned role.' },
    dependsOnTaskIds: {
      type: 'array',
      description: 'Task ids that must complete before this task is dispatched.',
      items: { type: 'string' },
    },
    outputArtifactKind: { type: 'string', description: 'Expected artifact kind for the task output.' },
  },
} as const

const workflowGroupPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['groupId', 'title', 'taskIds', 'join'],
  properties: {
    groupId: { type: 'string', description: 'Stable dispatch group id.' },
    title: { type: 'string', description: 'Short group title.' },
    taskIds: {
      type: 'array',
      description: 'Workflow task ids included in this dispatch group.',
      items: { type: 'string' },
    },
    join: {
      type: 'object',
      additionalProperties: false,
      required: ['requireCompleted', 'allowFailed', 'retryLimit'],
      properties: {
        requireCompleted: { type: 'boolean', description: 'Whether downstream groups require all tasks to complete.' },
        allowFailed: { type: 'boolean', description: 'Whether the group may continue with failed tasks.' },
        retryLimit: { type: 'number', description: 'Non-negative integer retry limit.' },
      },
    },
  },
} as const

const teamSubmitWorkflowPlanParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'groups', 'tasks', 'idempotencyKey'],
  properties: {
    title: { type: 'string', description: 'Workflow plan title.' },
    summary: { type: 'string', description: 'Optional concise plan summary.' },
    groups: {
      type: 'array',
      description: 'Dispatch groups with join policy.',
      items: workflowGroupPlanSchema,
    },
    tasks: {
      type: 'array',
      description: 'Task plan entries. Every task must include taskId, roleId, title, and prompt.',
      items: workflowTaskPlanSchema,
    },
    idempotencyKey: { type: 'string', description: 'Stable key for retry-safe planning.' },
  },
} as const

const evidenceRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: { type: 'string', enum: ['workspacePath', 'uri', 'artifact', 'inlineText'] },
    path: { type: 'string' },
    uri: { type: 'string' },
    artifactId: { type: 'string' },
    text: { type: 'string' },
    label: { type: 'string' },
  },
} as const

const teamCompleteTaskParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['workflowTaskId', 'roleId', 'summary', 'idempotencyKey'],
  properties: {
    workflowTaskId: { type: 'string', description: 'Assigned workflow task id.' },
    roleId: { type: 'string', description: 'Team role id completing the task.' },
    summary: { type: 'string', description: 'Concise task completion summary.' },
    evidenceRefs: {
      type: 'array',
      description: 'Optional bounded evidence references. Long content must be referenced, not pasted inline.',
      items: evidenceRefSchema,
    },
    idempotencyKey: { type: 'string', description: 'Stable key for retry-safe completion.' },
  },
} as const

const teamRequestApprovalParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['workflowTaskId', 'roleId', 'reason', 'requestedAction', 'risk', 'idempotencyKey'],
  properties: {
    workflowTaskId: { type: 'string', description: 'Workflow task id requesting approval.' },
    roleId: { type: 'string', description: 'Role id requesting approval.' },
    reason: { type: 'string', description: 'Why approval is required.' },
    requestedAction: { type: 'string', description: 'The concrete action that must not proceed without approval.' },
    risk: { type: 'string', description: 'Risk summary for the user.' },
    idempotencyKey: { type: 'string', description: 'Stable key for retry-safe approval requests.' },
  },
} as const

const failureItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', description: 'Stable failure code.' },
    message: { type: 'string', description: 'Human-readable failure detail.' },
    severity: { type: 'string', enum: ['info', 'warning', 'blocker'] },
    evidenceRefs: {
      type: 'array',
      description: 'Optional bounded evidence references for this failure item.',
      items: evidenceRefSchema,
    },
  },
} as const

const teamSendMessageParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'fromRoleId', 'toRoleId', 'summary', 'body', 'idempotencyKey'],
  properties: {
    kind: { type: 'string', enum: ['note', 'question', 'kickback'], description: 'Message category. Use kickback for rework/failure routing.' },
    fromRoleId: { type: 'string', description: 'Sender Team role id.' },
    toRoleId: { type: 'string', description: 'Mailbox target Team role id, or leader for audited inbox delivery.' },
    summary: { type: 'string', description: 'Short message summary for routing and audit.' },
    body: { type: 'string', description: 'Full message body.' },
    relatedTaskId: { type: 'string', description: 'Optional workflow task id this message concerns.' },
    relatedArtifactId: { type: 'string', description: 'Optional artifact id this message concerns.' },
    relatedGateId: { type: 'string', description: 'Optional gate id this message concerns.' },
    failureItems: {
      type: 'array',
      description: 'Required for kind=kickback; optional otherwise. Each item describes a concrete failure to fix.',
      items: failureItemSchema,
    },
    idempotencyKey: { type: 'string', description: 'Stable key for retry-safe message delivery.' },
  },
} as const

export function registerTeamArtifactTools(api: OpenClawPluginApi): void {
  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_submit_workflow_plan',
    label: 'Team Submit Workflow Plan',
    description: 'Submit the structured TeamRun workflow plan. The runtime-host TeamRuntime owns state transitions after this tool records the plan envelope.',
    parameters: teamSubmitWorkflowPlanParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const envelope = buildEnvelope(toolCtx, {
        type: 'workflow.plan_submitted',
        title: readRequiredString(params, 'title'),
        summary: readOptionalString(params, 'summary'),
        groups: readWorkflowGroupPlans(params),
        tasks: readWorkflowTaskPlans(params),
        idempotencyKey: readRequiredString(params, 'idempotencyKey'),
      })
      const record = await createTeamOutboxStore(api).append(envelope)
      return formatTeamToolResult({ success: true, envelope: record.envelope, outbox: summarizeOutboxRecord(record) })
    },
  }), { name: 'team_submit_workflow_plan' })

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_complete_task',
    label: 'Team Complete Task',
    description: 'Report that the assigned workflow task is complete. Submit concise summary and bounded evidence references; the runtime-host TeamRuntime advances task state.',
    parameters: teamCompleteTaskParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const workflowTaskId = readRequiredString(params, 'workflowTaskId')
      const roleId = readRequiredString(params, 'roleId')
      assertToolContextRole(toolCtx, roleId)
      const envelope = buildEnvelope(toolCtx, {
        type: 'task.completed',
        workflowTaskId,
        roleId,
        sourceRoleId: roleId,
        summary: readRequiredString(params, 'summary'),
        evidenceRefs: readEvidenceRefs(params),
        idempotencyKey: readRequiredString(params, 'idempotencyKey'),
      })
      const record = await createTeamOutboxStore(api).append(envelope)
      return formatTeamToolResult({ success: true, envelope: record.envelope, outbox: summarizeOutboxRecord(record) })
    },
  }), { name: 'team_complete_task' })

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_request_approval',
    label: 'Team Request Approval',
    description: 'Request user approval for an action that must not proceed automatically. The runtime-host TeamRuntime owns approval state.',
    parameters: teamRequestApprovalParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const workflowTaskId = readRequiredString(params, 'workflowTaskId')
      const roleId = readRequiredString(params, 'roleId')
      assertToolContextRole(toolCtx, roleId)
      const envelope = buildEnvelope(toolCtx, {
        type: 'approval.requested',
        workflowTaskId,
        roleId,
        sourceRoleId: roleId,
        reason: readRequiredString(params, 'reason'),
        requestedAction: readRequiredString(params, 'requestedAction'),
        risk: readRequiredString(params, 'risk'),
        idempotencyKey: readRequiredString(params, 'idempotencyKey'),
      })
      const record = await createTeamOutboxStore(api).append(envelope)
      return formatTeamToolResult({ success: true, envelope: record.envelope, outbox: summarizeOutboxRecord(record) })
    },
  }), { name: 'team_request_approval' })

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_send_message',
    label: 'Team Send Message',
    description: 'Record an audited Team mailbox message. This does not dispatch tasks; runtime-host TeamRuntime decides delivery.',
    parameters: teamSendMessageParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const fromRoleId = readRequiredString(params, 'fromRoleId')
      assertToolContextRole(toolCtx, fromRoleId)
      const kind = readMessageKind(params)
      const failureItems = readFailureItems(params)
      const relatedTaskId = readOptionalString(params, 'relatedTaskId')
      const relatedArtifactId = readOptionalString(params, 'relatedArtifactId')
      const relatedGateId = readOptionalString(params, 'relatedGateId')
      if (kind === 'kickback') {
        assertKickbackMessageHasFailureContext(failureItems, { relatedTaskId, relatedArtifactId, relatedGateId })
      }
      const envelope = buildEnvelope(toolCtx, {
        type: 'message.sent',
        kind,
        fromRoleId,
        toRoleId: readRequiredString(params, 'toRoleId'),
        sourceRoleId: fromRoleId,
        summary: readRequiredString(params, 'summary'),
        body: readRequiredString(params, 'body'),
        relatedTaskId,
        relatedArtifactId,
        relatedGateId,
        failureItems,
        idempotencyKey: readRequiredString(params, 'idempotencyKey'),
      })
      const record = await createTeamOutboxStore(api).append(envelope)
      return formatTeamToolResult({ success: true, envelope: record.envelope, outbox: summarizeOutboxRecord(record) })
    },
  }), { name: 'team_send_message' })
}

function buildEnvelope<T extends Omit<TeamInboundEnvelope, 'runId' | 'envelopeId' | 'sourceEndpoint' | 'sourceAgentId' | 'sourceSessionKey' | 'createdAt'>>(
  toolCtx: TeamToolContext,
  input: T,
): TeamInboundEnvelope {
  const sourceAgentId = toolCtx.agentId?.trim()
  if (!sourceAgentId) {
    throw new Error('Team tool caller agentId is required')
  }
  const teamRunSession = resolveTeamRunSessionFromToolContext(toolCtx)
  if (sourceAgentId !== teamRunSession.agentId) {
    throw new Error(`Team tool caller agentId must match the active Team role session agentId. Expected ${teamRunSession.agentId}, received ${sourceAgentId}. Retry from the active Team run role session.`)
  }
  return {
    ...input,
    runId: teamRunSession.runId,
    envelopeId: `team-envelope-${randomUUID()}`,
    sourceEndpoint: OPENCLAW_LOCAL_ENDPOINT,
    sourceAgentId,
    sourceSessionKey: teamRunSession.sourceSessionKey,
    createdAt: Date.now(),
  } as TeamInboundEnvelope
}

function resolveTeamRunSessionFromToolContext(toolCtx: TeamToolContext): { agentId: string; runId: string; roleId: string; sourceSessionKey: string } {
  const sourceSessionKey = toolCtx.sessionKey?.trim()
  if (!sourceSessionKey) {
    throw new Error('Team tools must be called from a Team run session. OpenClaw did not provide toolCtx.sessionKey; retry from the active Team run role session.')
  }

  const sessionKeyParts = sourceSessionKey.split(':')
  const hasTeamRunSessionShape = sessionKeyParts.length === 5 && sessionKeyParts[0] === 'agent' && sessionKeyParts[2] === 'team-role'
  if (!hasTeamRunSessionShape) {
    throw new Error('Team tools must be called from a Team run session. Expected toolCtx.sessionKey format agent:{agentId}:team-role:{runId}:{roleId}; retry from the active Team run role session.')
  }

  const agentId = sessionKeyParts[1]?.trim()
  if (!agentId) {
    throw new Error('Team tools must be called from a Team run session. toolCtx.sessionKey did not include an agentId; retry from the active Team run role session.')
  }
  const runId = sessionKeyParts[3]?.trim()
  if (!runId) {
    throw new Error('Team tools must be called from a Team run session. toolCtx.sessionKey did not include a TeamRun runId; retry from the active Team run role session.')
  }
  const roleId = sessionKeyParts[4]?.trim()
  if (!roleId) {
    throw new Error('Team tools must be called from a Team run session. toolCtx.sessionKey did not include a Team roleId; retry from the active Team run role session.')
  }

  return { agentId, runId, roleId, sourceSessionKey }
}

function assertToolContextRole(toolCtx: TeamToolContext, roleId: string): void {
  const teamRunSession = resolveTeamRunSessionFromToolContext(toolCtx)
  if (teamRunSession.roleId !== roleId) {
    throw new Error(`Team tool roleId must match the active Team role session. Expected ${teamRunSession.roleId}, received ${roleId}.`)
  }
}

function assertKickbackMessageHasFailureContext(
  failureItems: readonly TeamFailureItem[] | undefined,
  relatedRefs: { readonly relatedTaskId?: string; readonly relatedArtifactId?: string; readonly relatedGateId?: string },
): void {
  if (!failureItems || failureItems.length === 0) {
    throw new Error('Field "failureItems" is required for kind="kickback". Fix: provide one or more concrete failure items to route rework.')
  }
  if (!relatedRefs.relatedTaskId && !relatedRefs.relatedArtifactId && !relatedRefs.relatedGateId) {
    throw new Error('kind="kickback" must identify the failed work. Fix: provide at least one of relatedTaskId, relatedArtifactId, or relatedGateId with the failureItems.')
  }
}

function summarizeOutboxRecord(record: { recordId: string; runId: string; sequence: number; status: string }) {
  return {
    recordId: record.recordId,
    runId: record.runId,
    sequence: record.sequence,
    status: record.status,
  }
}

function formatTeamToolResult(payload: TeamToolResultPayload): TeamToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'text' },
  }
}

function readRequiredString(params: ToolParams, key: string, fieldPath = key): string {
  const value = params[key]
  if (typeof value !== 'string') {
    throw new Error(`Field "${fieldPath}" must be a non-empty string. Fix: provide ${fieldPath} as a quoted string.`)
  }
  if (!value.trim()) {
    throw new Error(`Field "${fieldPath}" is required and cannot be blank. Fix: provide a non-empty ${fieldPath} string.`)
  }
  return value.trim()
}

function readOptionalString(params: ToolParams, key: string, fieldPath = key): string | undefined {
  const value = params[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`Field "${fieldPath}" must be a string when provided. Fix: remove it or provide ${fieldPath} as a quoted string.`)
  }
  return value.trim() ? value.trim() : undefined
}

function readOptionalNonEmptyString(params: ToolParams, key: string, fieldPath = key): string | undefined {
  const value = params[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Field "${fieldPath}" must be a non-empty string when provided. Fix: remove it or provide ${fieldPath} as a non-empty quoted string.`)
  }
  return value.trim()
}

function readWorkflowGroupPlans(params: ToolParams): TeamWorkflowGroupPlan[] {
  const value = params.groups
  if (!Array.isArray(value)) {
    throw new Error('Field "groups" must be an array of canonical workflow group objects. Fix: provide groups with groupId, title, taskIds, and join.')
  }
  return value.map((group, index) => readWorkflowGroupPlan(group, `groups[${index}]`))
}

function readWorkflowGroupPlan(value: unknown, fieldPath: string): TeamWorkflowGroupPlan {
  assertCanonicalObject(value, fieldPath, ['groupId', 'title', 'taskIds', 'join'])
  const taskIds = readRequiredStringArray(value, 'taskIds', `${fieldPath}.taskIds`, { allowEmpty: false })
  const join = readWorkflowJoinPolicy(value.join, `${fieldPath}.join`)
  return {
    groupId: readRequiredString(value, 'groupId', `${fieldPath}.groupId`),
    title: readRequiredString(value, 'title', `${fieldPath}.title`),
    taskIds,
    join,
  }
}

function readWorkflowJoinPolicy(value: unknown, fieldPath: string): TeamWorkflowGroupPlan['join'] {
  assertCanonicalObject(value, fieldPath, ['requireCompleted', 'allowFailed', 'retryLimit'])
  return {
    requireCompleted: readRequiredBoolean(value, 'requireCompleted', `${fieldPath}.requireCompleted`),
    allowFailed: readRequiredBoolean(value, 'allowFailed', `${fieldPath}.allowFailed`),
    retryLimit: readRequiredNonNegativeInteger(value, 'retryLimit', `${fieldPath}.retryLimit`),
  }
}

function readWorkflowTaskPlans(params: ToolParams): TeamWorkflowTaskPlan[] {
  const value = params.tasks
  if (!Array.isArray(value)) {
    throw new Error('Field "tasks" must be an array of canonical workflow task objects. Fix: provide tasks with taskId, roleId, title, and prompt.')
  }
  return value.map((task, index) => readWorkflowTaskPlan(task, `tasks[${index}]`))
}

function readWorkflowTaskPlan(value: unknown, fieldPath: string): TeamWorkflowTaskPlan {
  assertCanonicalObject(value, fieldPath, ['taskId', 'roleId', 'title', 'prompt'], ['dependsOnTaskIds', 'outputArtifactKind'])
  const dependsOnTaskIds = readOptionalStringArray(value, 'dependsOnTaskIds', `${fieldPath}.dependsOnTaskIds`)
  const outputArtifactKind = readOptionalNonEmptyString(value, 'outputArtifactKind', `${fieldPath}.outputArtifactKind`)
  return {
    taskId: readRequiredString(value, 'taskId', `${fieldPath}.taskId`),
    roleId: readRequiredString(value, 'roleId', `${fieldPath}.roleId`),
    title: readRequiredString(value, 'title', `${fieldPath}.title`),
    prompt: readRequiredString(value, 'prompt', `${fieldPath}.prompt`),
    ...(dependsOnTaskIds ? { dependsOnTaskIds } : {}),
    ...(outputArtifactKind ? { outputArtifactKind } : {}),
  }
}

function assertCanonicalObject(value: unknown, fieldPath: string, requiredKeys: readonly string[], optionalKeys: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Field "${fieldPath}" must be an object. Fix: provide the canonical object shape for ${fieldPath}.`)
  }
  for (const requiredKey of requiredKeys) {
    if (!(requiredKey in value)) {
      throw new Error(`Field "${fieldPath}.${requiredKey}" is required. Fix: provide ${fieldPath}.${requiredKey} using the canonical workflow plan schema.`)
    }
  }
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys])
  const extraKey = Object.keys(value).find(key => !allowedKeys.has(key))
  if (extraKey) {
    throw new Error(`Field "${fieldPath}.${extraKey}" is not supported. Fix: remove extra properties and use only the canonical workflow plan schema.`)
  }
}

function readRequiredBoolean(params: ToolParams, key: string, fieldPath = key): boolean {
  const value = params[key]
  if (typeof value !== 'boolean') {
    throw new Error(`Field "${fieldPath}" must be a boolean. Fix: provide ${fieldPath} as true or false.`)
  }
  return value
}

function readRequiredNonNegativeInteger(params: ToolParams, key: string, fieldPath = key): number {
  const value = params[key]
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Field "${fieldPath}" must be a non-negative integer. Fix: provide ${fieldPath} as 0 or a positive whole number.`)
  }
  return value
}

function readOptionalStringArray(params: ToolParams, key: string, fieldPath = key): string[] | undefined {
  const value = params[key]
  if (value === undefined) {
    return undefined
  }
  return readStringArray(value, fieldPath, { allowEmpty: true })
}

function readRequiredStringArray(params: ToolParams, key: string, fieldPath = key, options: { allowEmpty: boolean }): string[] {
  if (!(key in params)) {
    throw new Error(`Field "${fieldPath}" is required. Fix: provide ${fieldPath} as an array of non-empty strings.`)
  }
  return readStringArray(params[key], fieldPath, options)
}

function readStringArray(value: unknown, fieldPath: string, options: { allowEmpty: boolean }): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Field "${fieldPath}" must be an array of strings. Fix: provide ${fieldPath} as ["..."] with string ids.`)
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new Error(`Field "${fieldPath}" must include at least one task id. Fix: add one or more task id strings.`)
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`Field "${fieldPath}[${index}]" must be a non-empty string. Fix: provide a quoted string id.`)
    }
    return item.trim()
  })
}

function readMessageKind(params: ToolParams): TeamMessageKind {
  const kind = readRequiredString(params, 'kind')
  if (kind === 'note' || kind === 'question' || kind === 'kickback') {
    return kind
  }
  throw new Error('Field "kind" must be one of note, question, or kickback. Fix: choose the message category that matches the routing intent.')
}

function readFailureItems(params: ToolParams): TeamFailureItem[] | undefined {
  const value = params.failureItems
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new Error('Field "failureItems" must be an array. Fix: provide failureItems as [] or an array of { code, message } objects.')
  }
  return value.map((failureItem, index) => readFailureItem(failureItem, `failureItems[${index}]`))
}

function readFailureItem(value: unknown, fieldPath: string): TeamFailureItem {
  if (!isRecord(value)) {
    throw new Error(`Field "${fieldPath}" must be an object. Fix: use { code: "...", message: "..." }.`)
  }
  const severity = readOptionalString(value, 'severity', `${fieldPath}.severity`)
  if (severity && severity !== 'info' && severity !== 'warning' && severity !== 'blocker') {
    throw new Error(`Field "${fieldPath}.severity" must be one of info, warning, or blocker. Fix: remove it or choose a supported severity.`)
  }
  const evidenceRefs = readEvidenceRefsFromValue(value.evidenceRefs, `${fieldPath}.evidenceRefs`)
  return {
    code: readRequiredString(value, 'code', `${fieldPath}.code`),
    message: readRequiredString(value, 'message', `${fieldPath}.message`),
    ...(severity ? { severity } : {}),
    ...(evidenceRefs ? { evidenceRefs } : {}),
  }
}

function readEvidenceRefs(params: ToolParams): TeamEvidenceRef[] | undefined {
  return readEvidenceRefsFromValue(params.evidenceRefs, 'evidenceRefs')
}

function readEvidenceRefsFromValue(value: unknown, fieldPath: string): TeamEvidenceRef[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value)) {
    throw new Error(`Field "${fieldPath}" must be an array. Fix: provide ${fieldPath} as [] or an array of workspacePath/uri/artifact/inlineText objects.`)
  }
  return value.map((evidenceRef, index) => readEvidenceRef(evidenceRef, `${fieldPath}[${index}]`))
}

function readEvidenceRef(value: unknown, fieldPath: string): TeamEvidenceRef {
  if (!isRecord(value)) {
    throw new Error(`Field "${fieldPath}" must be an object. Fix: use { type: "workspacePath", path: "..." }, { type: "uri", uri: "..." }, { type: "artifact", artifactId: "..." }, or { type: "inlineText", text: "..." }.`)
  }
  const type = readRequiredString(value, 'type', `${fieldPath}.type`)
  const label = readOptionalString(value, 'label', `${fieldPath}.label`)
  if (type === 'workspacePath') {
    return { type, path: readRequiredString(value, 'path', `${fieldPath}.path`), ...(label ? { label } : {}) }
  }
  if (type === 'uri') {
    return { type, uri: readRequiredString(value, 'uri', `${fieldPath}.uri`), ...(label ? { label } : {}) }
  }
  if (type === 'artifact') {
    return { type, artifactId: readRequiredString(value, 'artifactId', `${fieldPath}.artifactId`), ...(label ? { label } : {}) }
  }
  if (type === 'inlineText') {
    const text = readRequiredString(value, 'text', `${fieldPath}.text`)
    if (text.length > INLINE_TEXT_EVIDENCE_MAX_CHARS) {
      throw new Error(`Field "${fieldPath}.text" is ${text.length} characters, exceeding the ${INLINE_TEXT_EVIDENCE_MAX_CHARS} character inlineText limit. Fix: use a workspacePath, uri, or artifact evidence reference for long content.`)
    }
    return { type, text, ...(label ? { label } : {}) }
  }
  throw new Error(`Field "${fieldPath}.type" must be one of workspacePath, uri, artifact, or inlineText. Fix: choose a supported evidence reference type and include its matching field.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
