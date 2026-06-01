import type { SDKMessage } from './coreTypes.js'
import type { SDKControlRequest, SDKControlResponse } from './controlTypes.js'
import { initBridgeCore } from '../../bridge/replBridge.js'
import { createCodeSession } from '../../bridge/codeSessionApi.js'
import { archiveBridgeSession } from '../../bridge/createSession.js'

export type InboundPrompt = {
  content: string | unknown[]
  uuid?: string
}

export type ConnectRemoteControlOptions = {
  dir: string
  name?: string
  workerType?: string
  branch?: string
  gitRepoUrl?: string | null
  getAccessToken: () => string | undefined
  baseUrl: string
  orgUUID: string
  model: string
}

export type RemoteControlHandle = {
  sessionUrl: string
  environmentId: string
  bridgeSessionId: string
  write(msg: SDKMessage): void
  sendResult(): void
  sendControlRequest(req: unknown): void
  sendControlResponse(res: unknown): void
  sendControlCancelRequest(requestId: string): void
  inboundPrompts(): AsyncGenerator<InboundPrompt>
  controlRequests(): AsyncGenerator<unknown>
  permissionResponses(): AsyncGenerator<unknown>
  onStateChange(
    cb: (
      state: 'ready' | 'connected' | 'reconnecting' | 'failed',
      detail?: string,
    ) => void,
  ): void
  teardown(): Promise<void>
}

type Queue<T> = {
  push(value: T): void
  stream(): AsyncGenerator<T>
  close(): void
}

export async function connectRemoteControl(
  opts: ConnectRemoteControlOptions,
): Promise<RemoteControlHandle | null> {
  const inbound = createQueue<InboundPrompt>()
  const controls = createQueue<unknown>()
  const permissions = createQueue<unknown>()
  const stateCallbacks = new Set<
    (
      state: 'ready' | 'connected' | 'reconnecting' | 'failed',
      detail?: string,
    ) => void
  >()

  const handle = await initBridgeCore({
    dir: opts.dir,
    machineName: opts.name ?? 'Matcha SDK',
    branch: opts.branch ?? '',
    gitRepoUrl: opts.gitRepoUrl ?? null,
    title: opts.name ?? 'Matcha SDK Session',
    baseUrl: opts.baseUrl,
    sessionIngressUrl: opts.baseUrl,
    workerType: opts.workerType ?? 'claude_code',
    getAccessToken: opts.getAccessToken,
    createSession: async ({ title, signal }) => {
      if (signal.aborted) return null
      const token = opts.getAccessToken()
      if (!token) return null
      return createCodeSession(opts.baseUrl, token, title, 10_000, [opts.model])
    },
    archiveSession: async sessionId => {
      await archiveBridgeSession(sessionId, {
        baseUrl: opts.baseUrl,
        getAccessToken: opts.getAccessToken,
      })
    },
    onInboundMessage: message => {
      if (message.type === 'user') {
        inbound.push({
          content: message.content as string | unknown[],
          uuid: typeof message.uuid === 'string' ? message.uuid : undefined,
        })
      }
    },
    onPermissionResponse: response => permissions.push(response),
    onInterrupt: () => controls.push({ subtype: 'interrupt' }),
    onSetModel: model => controls.push({ subtype: 'set_model', model }),
    onSetMaxThinkingTokens: maxTokens =>
      controls.push({
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: maxTokens,
      }),
    onSetPermissionMode: mode => {
      controls.push({ subtype: 'set_permission_mode', mode })
      return { ok: true }
    },
    onStateChange: (state, detail) => {
      for (const cb of stateCallbacks) cb(state, detail)
    },
  })

  if (!handle) return null

  return {
    sessionUrl: `${opts.baseUrl}/code/${handle.bridgeSessionId}`,
    environmentId: handle.environmentId,
    bridgeSessionId: handle.bridgeSessionId,
    write(msg: SDKMessage) {
      handle.writeSdkMessages([msg])
    },
    sendResult() {
      handle.sendResult()
    },
    sendControlRequest(req: unknown) {
      handle.sendControlRequest(req as SDKControlRequest)
    },
    sendControlResponse(res: unknown) {
      handle.sendControlResponse(res as SDKControlResponse)
    },
    sendControlCancelRequest(requestId: string) {
      handle.sendControlCancelRequest(requestId)
    },
    inboundPrompts() {
      return inbound.stream()
    },
    controlRequests() {
      return controls.stream()
    },
    permissionResponses() {
      return permissions.stream()
    },
    onStateChange(cb) {
      stateCallbacks.add(cb)
    },
    async teardown() {
      inbound.close()
      controls.close()
      permissions.close()
      await handle.teardown()
    },
  }
}

function createQueue<T>(): Queue<T> {
  const values: T[] = []
  const waiters: Array<(value: T | undefined) => void> = []
  let closed = false
  return {
    push(value) {
      if (closed) return
      const waiter = waiters.shift()
      if (waiter) waiter(value)
      else values.push(value)
    },
    async *stream() {
      while (!closed) {
        const value = values.shift()
        if (value !== undefined) {
          yield value
          continue
        }
        const next = await new Promise<T | undefined>(resolve =>
          waiters.push(resolve),
        )
        if (next === undefined) return
        yield next
      }
    },
    close() {
      closed = true
      for (const waiter of waiters.splice(0)) waiter(undefined)
    },
  }
}
