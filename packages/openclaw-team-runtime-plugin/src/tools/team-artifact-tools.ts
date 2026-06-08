import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { createTeamRunRuntimeServices } from '../application/team-run-service-factory.js'

export type TeamToolContext = {
  workspaceDir?: string
  sessionKey?: string
}

type ToolParams = Record<string, unknown>

const teamSubmitArtifactParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['runId', 'stageId', 'roleId', 'kind', 'title', 'content', 'idempotencyKey'],
  properties: {
    runId: { type: 'string', description: 'TeamRun id.' },
    stageId: { type: 'string', description: 'Workflow stage id that produced this artifact.' },
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
    stageId: { type: 'string', description: 'Workflow stage id that needs user approval.' },
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
    stageId: { type: 'string', description: 'Workflow stage id being updated.' },
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
    fromRoleId: { type: 'string', description: 'Sender role id.' },
    toRoleId: { type: 'string', description: 'Target role id, or leader.' },
    summary: { type: 'string', description: 'Short message summary for routing and audit.' },
    body: { type: 'string', description: 'Full message body.' },
    idempotencyKey: { type: 'string', description: 'Stable key for retry-safe message delivery.' },
  },
} as const

export function registerTeamArtifactTools(api: OpenClawPluginApi): void {
  const { runService } = createTeamRunRuntimeServices(api)

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_submit_artifact',
    label: 'Team Submit Artifact',
    description: 'Submit a TeamSkill stage artifact. Use only when your assigned role has produced a stage output matching the requested schema.',
    parameters: teamSubmitArtifactParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const result = await runService.submitArtifact({
        runId: readRequiredString(params, 'runId'),
        stageId: readRequiredString(params, 'stageId'),
        roleId: readRequiredString(params, 'roleId'),
        kind: readRequiredString(params, 'kind'),
        title: readRequiredString(params, 'title'),
        content: readRequiredString(params, 'content'),
        summary: readOptionalString(params, 'summary'),
        idempotencyKey: readRequiredString(params, 'idempotencyKey'),
        workspaceDir: toolCtx.workspaceDir,
        childSessionKey: toolCtx.sessionKey,
      })
      const payload = { success: true, artifact: result.artifact, created: result.created }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        rawResponse: payload,
        details: payload,
        renderer: { type: 'text' },
      }
    },
  }))

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_update_task',
    label: 'Team Update Task',
    description: 'Report TeamSkill role progress, waiting state, or blockers. This never completes a stage; use team_submit_artifact for completion.',
    parameters: teamUpdateTaskParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const result = await runService.updateTask({
        runId: readRequiredString(params, 'runId'),
        stageId: readRequiredString(params, 'stageId'),
        roleId: readRequiredString(params, 'roleId'),
        status: readTaskUpdateStatus(params),
        summary: readRequiredString(params, 'summary'),
        detail: readOptionalString(params, 'detail'),
        progress: readOptionalProgress(params),
        metadata: readOptionalRecord(params, 'metadata'),
        idempotencyKey: readRequiredString(params, 'idempotencyKey'),
        workspaceDir: toolCtx.workspaceDir,
      })
      const payload = { success: true, update: result }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        rawResponse: payload,
        details: payload,
        renderer: { type: 'text' },
      }
    },
  }))

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_request_approval',
    label: 'Team Request Approval',
    description: 'Pause a TeamRun and request user approval for actions such as live NPU testing, profiling, or other externally visible operations.',
    parameters: teamRequestApprovalParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const result = await runService.requestApproval({
        runId: readRequiredString(params, 'runId'),
        stageId: readRequiredString(params, 'stageId'),
        roleId: readRequiredString(params, 'roleId'),
        reason: readRequiredString(params, 'reason'),
        requestedAction: readRequiredString(params, 'requestedAction'),
        risk: readRequiredString(params, 'risk'),
        idempotencyKey: readRequiredString(params, 'idempotencyKey'),
        workspaceDir: toolCtx.workspaceDir,
      })
      const payload = { success: true, approval: result.approval, created: result.created }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        rawResponse: payload,
        details: payload,
        renderer: { type: 'text' },
      }
    },
  }))

  api.registerTool((toolCtx: TeamToolContext) => ({
    name: 'team_send_message',
    label: 'Team Send Message',
    description: 'Send an audited TeamSkill mailbox message to another role or the leader. Use summary for routing; do not use ordinary chat text for teammate communication.',
    parameters: teamSendMessageParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const result = await runService.sendMessage({
        runId: readRequiredString(params, 'runId'),
        fromRoleId: readRequiredString(params, 'fromRoleId'),
        toRoleId: readRequiredString(params, 'toRoleId'),
        summary: readRequiredString(params, 'summary'),
        body: readRequiredString(params, 'body'),
        idempotencyKey: readRequiredString(params, 'idempotencyKey'),
        workspaceDir: toolCtx.workspaceDir,
      })
      const payload = { success: true, message: result.message, created: result.created }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        rawResponse: payload,
        details: payload,
        renderer: { type: 'text' },
      }
    },
  }))
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

