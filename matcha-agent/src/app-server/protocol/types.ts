import type { SDKMessage } from '../../entrypoints/sdk/coreTypes.generated.js'
import type { PermissionDecision } from '../../types/permissions.js'

export const APP_SERVER_PROTOCOL_VERSION = 'matcha-agent-app-server-v1'

export type JsonObject = Record<string, unknown>
export type JsonRpcId = string | number

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcSuccess = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export type JsonRpcFailure = {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: JsonRpcError
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification
export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

export type JsonRpcError = {
  code: number
  message: string
  data?: unknown
}

export type AppServerConfig = {
  host: string
  port: number
  storageRoot: string
  authToken?: string
  workerCommand: string
  workerArgs: string[]
  workerReadyTimeoutMs: number
  workerHeartbeatTimeoutMs: number
  maxClientQueueSize: number
}

export type InitializeParams = {
  clientName?: string
  protocolVersion?: string
  authToken?: string
}

export type InitializeResult = {
  protocolVersion: typeof APP_SERVER_PROTOCOL_VERSION
  serverVersion: string
  capabilities: {
    eventReplay: true
    snapshots: true
    approvals: true
    sdkMessageEnvelope: true
    blobStore: true
    sessionTranscript: true
  }
}

export type SessionCreateParams = {
  cwd: string
  sessionId?: string
  title?: string
  model?: string
  permissionMode?: string
}

export type SessionLoadParams = {
  sessionId: string
}

export type SessionPromptParams = {
  sessionId: string
  prompt: string
  runId?: string
  payload?: unknown
}

export type SessionCancelParams = {
  sessionId: string
  runId?: string
  reason?: string
}

export type SessionSnapshotParams = {
  sessionId: string
}

export type SessionTranscriptParams = {
  sessionId: string
}

export type EventsReplayParams = {
  sessionId: string
  afterSeq?: number
  limit?: number
}

export type EventsSubscribeParams = {
  sessionId: string
  afterSeq?: number
}

export type ApprovalRespondParams = {
  sessionId: string
  approvalId: string
  optionId: string
  reason?: string
}

export type SessionCloseParams = {
  sessionId: string
}

export type ModelsListParams = {
  sessionId?: string
}

export type SessionSetModelParams = {
  sessionId: string
  model: string
}

export type SessionSetModeParams = {
  sessionId: string
  mode: string
}

export type WorkerRuntimeState =
  | { state: 'unloaded'; reason: 'idleTimeout' | 'notStarted' }
  | { state: 'spawning'; workerId: string; startedAt: string }
  | { state: 'ready'; workerId: string; pid: number; lastHeartbeatAt: string }
  | { state: 'running'; workerId: string; runId: string; startedAt: string }
  | {
      state: 'waitingForApproval'
      workerId: string
      runId: string
      approvalIds: string[]
    }
  | {
      state: 'stopping'
      workerId: string
      reason: 'cancel' | 'shutdown' | 'restart'
    }
  | {
      state: 'crashed'
      workerId: string
      exitCode?: number
      signal?: string
      restartable: boolean
    }

export type SessionRecord = {
  sessionId: string
  workspaceRoot: string
  createdAt: string
  updatedAt: string
  title?: string
  runtime: 'matcha-agent'
  transcriptRef?: string
  hasConversation?: boolean
  lastSeq: number
  lastSnapshotVersion: number
  model?: string
  permissionMode?: string
  workerState: WorkerRuntimeState
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
  | 'error'

export type RunStatus =
  | { type: 'queued'; queuedAt: string }
  | { type: 'running'; startedAt: string; workerId: string }
  | { type: 'waitingForApproval'; approvalIds: string[] }
  | { type: 'completed'; completedAt: string; stopReason: StopReason }
  | { type: 'cancelled'; completedAt: string; reason: string }
  | { type: 'failed'; completedAt: string; error: ClassifiedError }
  | {
      type: 'interrupted'
      completedAt: string
      reason: 'workerCrashed' | 'serverShutdown'
    }

export type RunRecord = {
  runId: string
  sessionId: string
  promptId: string
  status: RunStatus
}

export type ClassifiedError = {
  type:
    | 'invalidRequest'
    | 'auth'
    | 'permission'
    | 'network'
    | 'aborted'
    | 'worker'
    | 'internal'
  message: string
  retryable: boolean
  details?: unknown
}

export type BlobRef = {
  blobId: string
  byteLength: number
  contentType: string
  sha256: string
  preview?: string
}

export type ApprovalOption = {
  optionId: string
  label: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export type ApprovalStatus =
  | { type: 'pending'; requestedAt: string; expiresAt?: string }
  | { type: 'approved'; resolvedAt: string; optionId: string }
  | { type: 'denied'; resolvedAt: string; reason?: string }
  | {
      type: 'cancelled'
      resolvedAt: string
      reason: 'runCancelled' | 'workerExited'
    }
  | { type: 'expired'; resolvedAt: string }

export type ApprovalRecord = {
  approvalId: string
  sessionId: string
  runId: string
  workerId: string
  toolCallId: string
  toolName: string
  prompt: string
  options: ApprovalOption[]
  status: ApprovalStatus
}

export type UsageSummary = {
  inputTokens: number
  outputTokens: number
  cachedReadTokens: number
  cachedWriteTokens: number
  totalTokens: number
}

export type AppServerEvent =
  | { type: 'session.created'; session: SessionRecord }
  | { type: 'session.loaded'; session: SessionRecord }
  | { type: 'session.closed'; sessionId: string }
  | { type: 'worker.spawning'; workerId: string }
  | { type: 'worker.ready'; workerId: string; pid: number }
  | { type: 'worker.heartbeat'; workerId: string; resourceUsage?: JsonObject }
  | {
      type: 'worker.crashed'
      workerId: string
      exitCode?: number
      signal?: string
    }
  | { type: 'run.queued'; run: RunRecord }
  | { type: 'run.started'; runId: string; workerId: string }
  | { type: 'run.cancelRequested'; runId?: string; reason: string }
  | { type: 'run.cancelled'; runId: string; reason: string }
  | {
      type: 'run.trace'
      runId: string
      workerId?: string
      stage: string
      details?: Record<string, string | number | boolean | null>
    }
  | {
      type: 'run.completed'
      runId: string
      stopReason: StopReason
      usage?: UsageSummary
    }
  | { type: 'run.failed'; runId: string; error: ClassifiedError }
  | {
      type: 'run.interrupted'
      runId: string
      reason: 'workerCrashed' | 'serverShutdown'
    }
  | {
      type: 'message.started'
      messageId: string
      role: 'assistant' | 'user' | 'tool'
    }
  | {
      type: 'message.delta'
      messageId: string
      delta: string
      channel?: 'text' | 'thinking' | 'tool'
    }
  | { type: 'message.completed'; messageId: string }
  | {
      type: 'tool.started'
      toolCallId: string
      toolName: string
      input?: unknown
    }
  | { type: 'tool.progress'; toolCallId: string; content: string | BlobRef }
  | { type: 'tool.completed'; toolCallId: string; result?: unknown | BlobRef }
  | { type: 'tool.failed'; toolCallId: string; error: ClassifiedError }
  | { type: 'approval.requested'; approval: ApprovalRecord }
  | { type: 'approval.resolved'; approval: ApprovalRecord }
  | { type: 'usage.updated'; usage: UsageSummary }
  | { type: 'error.reported'; error: ClassifiedError }
  | { type: 'snapshot.invalidated'; reason: string }
  | {
      type: 'sdk.message'
      sdkMessageVersion: 'claude-code-sdk-message-v1'
      sdkMessage: SDKMessage
      projectionHints?: {
        messageId?: string
        toolCallId?: string
        isTerminal?: boolean
      }
    }

export type AppServerEventEnvelope = {
  eventId: string
  sessionId: string
  seq: number
  runId?: string
  workerId?: string
  createdAt: string
  event: AppServerEvent
}

export type SessionSnapshot = {
  session: SessionRecord
  version: number
  updatedAt: string
  runs: RunRecord[]
  messages: AppServerEventEnvelope[]
  pendingApprovals: ApprovalRecord[]
  usage?: UsageSummary
}

export type WorkerInitializePayload = {
  sessionId: string
  cwd: string
  model?: string
  permissionMode?: string
}

export type WorkerCommand =
  | { id: string; type: 'worker.initialize'; payload: WorkerInitializePayload }
  | {
      id: string
      type: 'session.prompt'
      runId: string
      prompt: string
      payload?: unknown
    }
  | { id: string; type: 'session.cancel'; runId?: string; reason: string }
  | {
      id: string
      type: 'approval.response'
      approvalId: string
      decision: WorkerApprovalDecision
    }
  | { id: string; type: 'session.flush' }
  | {
      id: string
      type: 'worker.shutdown'
      reason: 'serverShutdown' | 'idleTimeout' | 'restart'
    }

export type WorkerResponse =
  | { id: string; ok: true; result?: unknown }
  | { id: string; ok: false; error: ClassifiedError }

export type WorkerApprovalDecision =
  | { type: 'approved'; optionId: string }
  | { type: 'denied'; optionId: string; reason?: string }
  | { type: 'cancelled'; reason: string }

export type WorkerApprovalRequest = {
  approvalId?: string
  runId: string
  toolCallId: string
  toolName: string
  prompt: string
  input: JsonObject
  options: ApprovalOption[]
}

export type WorkerNotification =
  | { type: 'worker.ready'; workerId: string; pid: number }
  | { type: 'worker.heartbeat'; workerId: string; resourceUsage?: JsonObject }
  | { type: 'event'; event: AppServerEvent; runId?: string }
  | { type: 'approval.request'; request: WorkerApprovalRequest }
  | {
      type: 'run.completed'
      runId: string
      stopReason: StopReason
      usage?: UsageSummary
    }
  | { type: 'run.failed'; runId: string; error: ClassifiedError }
  | { type: 'worker.fatal'; error: ClassifiedError }

export type WorkerFrame = WorkerResponse | WorkerNotification

export type AppServerCanUseToolResult = PermissionDecision<JsonObject>
