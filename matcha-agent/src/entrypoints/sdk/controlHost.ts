import type {
  SDKControlCancelRequest,
  SDKControlRequest,
  SDKControlResponse,
} from './controlTypes.js'
import type { Options } from './runtimeTypes.js'
import { handleSdkMcpMessage } from './sdkMcp.js'

type SendControlResponse = (response: SDKControlResponse) => void

export class ControlHost {
  private readonly active = new Map<string, AbortController>()

  constructor(
    private readonly options: Options,
    private readonly send: SendControlResponse,
  ) {}

  async handleControlRequest(request: SDKControlRequest): Promise<void> {
    const abortController = new AbortController()
    this.active.set(request.request_id, abortController)
    try {
      const payload = await dispatchControlRequest(
        request,
        this.options,
        abortController.signal,
      )
      if (abortController.signal.aborted) return
      this.send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
          response: payload as Record<string, unknown> | undefined,
        },
      })
    } catch (error) {
      if (abortController.signal.aborted) return
      this.send({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: request.request_id,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    } finally {
      this.active.delete(request.request_id)
    }
  }

  cancel(request: SDKControlCancelRequest): void {
    this.active.get(request.request_id)?.abort()
    this.active.delete(request.request_id)
  }

  close(): void {
    for (const controller of this.active.values()) {
      controller.abort()
    }
    this.active.clear()
  }
}

export async function handleControlRequest(
  request: SDKControlRequest,
  options: Options,
  send: SendControlResponse,
): Promise<void> {
  await new ControlHost(options, send).handleControlRequest(request)
}

async function dispatchControlRequest(
  request: SDKControlRequest,
  options: Options,
  signal: AbortSignal,
): Promise<unknown> {
  const inner = request.request
  if (inner.subtype === 'can_use_tool') {
    if (!options.canUseTool) return { behavior: 'allow' }
    return options.canUseTool({
      toolName: inner.tool_name,
      input: inner.input,
      toolUseId: inner.tool_use_id,
      permissionSuggestions: inner.permission_suggestions,
      blockedPath: inner.blocked_path,
      decisionReason: inner.decision_reason,
      title: inner.title,
      displayName: inner.display_name,
      agentId: inner.agent_id,
      description: inner.description,
    })
  }

  if (inner.subtype === 'hook_callback') {
    if (!options.hookCallback) return {}
    return options.hookCallback({
      callbackId: inner.callback_id,
      hookInput: inner.input,
      toolUseId: inner.tool_use_id,
    })
  }

  if (inner.subtype === 'elicitation') {
    if (!options.onElicitation) return { action: 'cancel' }
    return options.onElicitation({
      serverName: inner.mcp_server_name,
      message: inner.message,
      mode: inner.mode,
      url: inner.url,
      elicitationId: inner.elicitation_id,
      requestedSchema: inner.requested_schema,
    })
  }

  if (inner.subtype === 'mcp_message') {
    return {
      mcp_response: await handleSdkMcpMessage(
        options.sdkMcpServers ?? [],
        inner.server_name,
        inner.message,
        signal,
      ),
    }
  }

  return {}
}
