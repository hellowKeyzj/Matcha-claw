import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { createTeamRunPluginRuntimeRegistry } from '../application/team-run-service-factory.js'

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
type TerminalTeamRunReason = 'team_run_not_found' | 'team_run_not_active' | 'team_run_terminal'

const workflowTaskPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'roleId', 'title', 'prompt'],
  properties: {
    taskId: { type: 'string', description: 'Stable workflow task id.' },
    roleId: { type: 'string', description: 'Team role id from the role roster, never the managed OpenClaw agent id.' },
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

const teamPlanWorkflowParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'title', 'groups', 'tasks', 'idempotencyKey'],
  properties: {
    runId: { type: 'string', description: 'TeamRun id.' },
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

const teamSubmitArtifactParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'stageId', 'roleId', 'kind', 'title', 'content', 'idempotencyKey'],
  properties: {
    runId: { type: 'string', description: 'TeamRun id.' },
    stageId: { type: 'string', description: 'Workflow taskId used as stageId for the assigned role artifact.' },
    roleId: { type: 'string', description: 'Team role id submitting the artifact.' },
    kind: { type: 'string', description: 'Artifact kind, for example design_report or source_patch.' },
    title: { type: 'string', description: 'Short artifact title.' },
    content: { type: 'string', description: 'Full artifact markdown content.' },
    summary: { type: 'string', description: 'Optional concise summary.' },
    idempotencyKey: { type: 'string', description: 'Stable key for retry-safe submission.' },
  },
} as const

const teamRequestApprovalParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'stageId', 'roleId', 'reason', 'requestedAction', 'risk', 'idempotencyKey'],
  properties: {
    runId: { type: 'string', description: 'TeamRun id.' },
    stageId: { type: 'string', description: 'Workflow taskId used as stageId for the approval request.' },
    roleId: { type: 'string', description: 'Role id requesting approval.' },
    reason: { type: 'string', description: 'Why approval is required.' },
    requestedAction: { type: 'string', description: 'The concrete action that must not proceed without approval.' },
    risk: { type: 'string', description: 'Risk summary for the user.' },
    idempotencyKey: { type: 'string', description: 'Stable key for retry-safe approval requests.' },
  },
} as const

const teamUpdateTaskParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'stageId', 'roleId', 'status', 'summary', 'idempotencyKey'],
  properties: {
    runId: { type: 'string', description: 'TeamRun id.' },
    stageId: { type: 'string', description: 'Workflow taskId used as stageId for the task update.' },
    roleId: { type: 'string', description: 'Team role id reporting progress.' },
    status: { type: 'string', enum: ['in_progress', 'waiting', 'blocked'], description: 'Progress status. Completion must use team_submit_artifact.' },
    summary: { type: 'string', description: 'Short progress or blocker summary.' },
    detail: { type: 'string', description: 'Optional detail for the update.' },
    progress: { type: 'number', description: 'Optional progress value from 0 to 1.' },
    metadata: { type: 'object', description: 'Optional JSON metadata for projection.' },
    idempotencyKey: { type: 'string', description: 'Stable key for audit correlation.' },
  },
} as const

const teamSendMessageParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'fromRoleId', 'toRoleId', 'summary', 'body', 'idempotencyKey'],
  properties: {
    runId: { type: 'string', description: 'TeamRun id.' },
    fromRoleId: { type: 'string', description: 'Sender Team role id from the emitting role child session; leader is not a valid sender.' },
    toRoleId: { type: 'string', description: 'Mailbox target Team role id, or leader for audited inbox delivery; never a managed OpenClaw agent id.' },
    summary: { type: 'string', description: 'Short message summary for routing and audit.' },
    body: { type: 'string', description: 'Full message body.' },
    idempotencyKey: { type: 'string', description: 'Stable key for retry-safe message delivery.' },
  },
} as const

export function registerTeamArtifactTools(api: OpenClawPluginApi): void {
  const runtimeRegistry = createTeamRunPluginRuntimeRegistry(api)

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_plan_workflow',
    label: 'Team Plan Workflow',
    description: 'Submit the structured TeamRun workflow plan before role sessions report artifacts, updates, messages, or approvals.',
    parameters: teamPlanWorkflowParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const runId = readRequiredString(params, 'runId')
      const result = await runtimeRegistry.serviceForRun(runId).planWorkflow({
        runId,
        title: readRequiredString(params, 'title'),
        summary: readOptionalString(params, 'summary'),
        groups: readRequiredRecordArray(params, 'groups'),
        tasks: readRequiredRecordArray(params, 'tasks'),
        idempotencyKey: readRequiredString(params, 'idempotencyKey'),
        workspaceDir: toolCtx.workspaceDir,
      })
      const payload = { success: true, plan: result.plan, created: result.created }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        rawResponse: payload,
        details: payload,
        renderer: { type: 'text' },
      }
    },
  }), { name: 'team_plan_workflow' })

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_submit_artifact',
    label: 'Team Submit Artifact',
    description: 'Submit a TeamSkill stage artifact. Use only when your assigned role has produced a stage output matching the requested schema.',
    parameters: teamSubmitArtifactParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return executeRoleTeamTool(async () => {
        const runId = readRequiredString(params, 'runId')
        const result = await runtimeRegistry.serviceForRun(runId).submitArtifact({
          runId,
          stageId: readRequiredString(params, 'stageId'),
          roleId: readRequiredString(params, 'roleId'),
          kind: readRequiredString(params, 'kind'),
          title: readRequiredString(params, 'title'),
          content: readRequiredString(params, 'content'),
          summary: readOptionalString(params, 'summary'),
          idempotencyKey: readRequiredString(params, 'idempotencyKey'),
          workspaceDir: toolCtx.workspaceDir,
          callerAgentId: toolCtx.agentId,
          childSessionKey: toolCtx.sessionKey,
        })
        return { success: true, artifact: result.artifact, created: result.created }
      })
    },
  }), { name: 'team_submit_artifact' })

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_update_task',
    label: 'Team Update Task',
    description: 'Report TeamSkill role progress, waiting state, or blockers. This never completes a stage; use team_submit_artifact for completion.',
    parameters: teamUpdateTaskParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return executeRoleTeamTool(async () => {
        const runId = readRequiredString(params, 'runId')
        const result = await runtimeRegistry.serviceForRun(runId).updateTask({
          runId,
          stageId: readRequiredString(params, 'stageId'),
          roleId: readRequiredString(params, 'roleId'),
          status: readTaskUpdateStatus(params),
          summary: readRequiredString(params, 'summary'),
          detail: readOptionalString(params, 'detail'),
          progress: readOptionalProgress(params),
          metadata: readOptionalRecord(params, 'metadata'),
          idempotencyKey: readRequiredString(params, 'idempotencyKey'),
          workspaceDir: toolCtx.workspaceDir,
          callerAgentId: toolCtx.agentId,
          childSessionKey: toolCtx.sessionKey,
        })
        return { success: true, update: result }
      })
    },
  }), { name: 'team_update_task' })

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_request_approval',
    label: 'Team Request Approval',
    description: 'Pause a TeamRun and request user approval for actions such as live NPU testing, profiling, or other externally visible operations.',
    parameters: teamRequestApprovalParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return executeRoleTeamTool(async () => {
        const runId = readRequiredString(params, 'runId')
        const result = await runtimeRegistry.serviceForRun(runId).requestApproval({
          runId,
          stageId: readRequiredString(params, 'stageId'),
          roleId: readRequiredString(params, 'roleId'),
          reason: readRequiredString(params, 'reason'),
          requestedAction: readRequiredString(params, 'requestedAction'),
          risk: readRequiredString(params, 'risk'),
          idempotencyKey: readRequiredString(params, 'idempotencyKey'),
          workspaceDir: toolCtx.workspaceDir,
          callerAgentId: toolCtx.agentId,
          childSessionKey: toolCtx.sessionKey,
        })
        return { success: true, approval: result.approval, created: result.created }
      })
    },
  }), { name: 'team_request_approval' })

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_send_message',
    label: 'Team Send Message',
    description: 'Send an audited TeamSkill mailbox message from a real role child session to another role or the leader. This is mailbox/audit only, not teammate dispatch; leaders dispatch tasks via team_plan_workflow and must not use this tool.',
    parameters: teamSendMessageParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return executeRoleTeamTool(async () => {
        const runId = readRequiredString(params, 'runId')
        const result = await runtimeRegistry.serviceForRun(runId).sendMessage({
          runId,
          fromRoleId: readRequiredString(params, 'fromRoleId'),
          toRoleId: readRequiredString(params, 'toRoleId'),
          summary: readRequiredString(params, 'summary'),
          body: readRequiredString(params, 'body'),
          idempotencyKey: readRequiredString(params, 'idempotencyKey'),
          workspaceDir: toolCtx.workspaceDir,
          callerAgentId: toolCtx.agentId,
          childSessionKey: toolCtx.sessionKey,
        })
        return { success: true, message: result.message, created: result.created }
      })
    },
  }), { name: 'team_send_message' })
}

async function executeRoleTeamTool(operation: () => Promise<TeamToolResultPayload>): Promise<TeamToolResult> {
  try {
    return formatTeamToolResult(await operation())
  } catch (error) {
    const reason = classifyTerminalTeamRunError(error)
    if (!reason) {
      throw error
    }
    return terminalTeamToolResult(reason, error instanceof Error ? error.message : String(error))
  }
}

function classifyTerminalTeamRunError(error: unknown): TerminalTeamRunReason | undefined {
  if (!(error instanceof Error)) {
    return undefined
  }
  if (/^TeamRun not found:/.test(error.message)) {
    return 'team_run_not_found'
  }
  if (error.message.includes('TeamRun cannot accept messages from terminal status')) {
    return 'team_run_terminal'
  }
  if (error.message.includes('TeamRun is not running:') || error.message.includes('TeamRun is not active:')) {
    return 'team_run_not_active'
  }
  return undefined
}

function terminalTeamToolResult(reason: TerminalTeamRunReason, message: string): TeamToolResult {
  return formatTeamToolResult({
    success: false,
    teamRunState: 'terminal',
    reason,
    retryPolicy: 'do_not_retry_team_tools',
    message,
    instruction: 'The TeamRun is no longer active. Stop using TeamRun tools for this session.',
  })
}

function formatTeamToolResult(payload: TeamToolResultPayload): TeamToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'text' },
  }
}

function readRequiredString(params: ToolParams, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} is required`)
  }
  return value.trim()
}

function readOptionalString(params: ToolParams, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readRequiredRecordArray(params: ToolParams, key: string): Record<string, unknown>[] {
  const value = params[key]
  if (!Array.isArray(value) || !value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    throw new Error(`${key} must be an array of objects`)
  }
  return value as Record<string, unknown>[]
}

function readTaskUpdateStatus(params: ToolParams): 'in_progress' | 'waiting' | 'blocked' {
  const value = readRequiredString(params, 'status')
  if (value === 'in_progress' || value === 'waiting' || value === 'blocked') {
    return value
  }
  throw new Error('team_update_task status must be in_progress, waiting, or blocked; submit completion with team_submit_artifact')
}

function readOptionalProgress(params: ToolParams): number | undefined {
  const value = params.progress
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('progress must be a number between 0 and 1')
  }
  return value
}

function readOptionalRecord(params: ToolParams, key: string): Record<string, unknown> | undefined {
  const value = params[key]
  if (value === undefined) {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${key} must be an object`)
  }
  return value as Record<string, unknown>
}
