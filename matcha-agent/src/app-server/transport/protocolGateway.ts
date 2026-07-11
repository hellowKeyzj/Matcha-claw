import {
  encodeJsonRpcMessage,
  internalError,
  invalidParams,
  isJsonRpcRequest,
  methodNotFound,
  parseJsonRpcMessage,
} from '../protocol/jsonRpc.js'
import type {
  ApprovalRespondParams,
  EventsReplayParams,
  EventsSubscribeParams,
  InitializeParams,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcResponse,
  ModelsListParams,
  SessionCancelParams,
  SessionCloseParams,
  SessionCreateParams,
  SessionLoadParams,
  SessionPromptParams,
  SessionSetModeParams,
  SessionSetModelParams,
  SessionSnapshotParams,
  SessionTranscriptParams,
} from '../protocol/types.js'
import type { AppServerPorts } from './ports.js'

type DispatchResult =
  | { resultType: 'success'; result: unknown }
  | { resultType: 'invalidParams'; message: string }
  | { resultType: 'methodNotFound' }

type ParamsParseResult<TParams> =
  | { resultType: 'success'; params: TParams }
  | { resultType: 'invalidParams'; message: string }

type ScalarParseResult<TValue> =
  | { resultType: 'success'; value: TValue }
  | { resultType: 'invalidParams'; message: string }

type MethodHandler = (
  clientId: string | undefined,
  params: unknown,
) => Promise<DispatchResult>

type ParamsParser<TParams> = (params: unknown) => ParamsParseResult<TParams>

export class ProtocolGateway {
  constructor(private readonly ports: AppServerPorts) {}

  async handleTextMessage(
    clientId: string | undefined,
    raw: string,
  ): Promise<string | undefined> {
    const parsed = parseJsonRpcMessage(raw)
    if (parsed.resultType === 'error') {
      return encodeJsonRpcMessage(parsed.response)
    }

    const response = await this.handleMessage(clientId, parsed.message)
    return response ? encodeJsonRpcMessage(response) : undefined
  }

  async handleMessage(
    clientId: string | undefined,
    message: JsonRpcMessage,
  ): Promise<JsonRpcResponse | undefined> {
    if (!isJsonRpcRequest(message)) {
      await this.dispatchNotification(clientId, message)
      return undefined
    }

    return this.dispatchRequest(clientId, message)
  }

  private async dispatchRequest(
    clientId: string | undefined,
    message: JsonRpcMessage & { id: JsonRpcId },
  ): Promise<JsonRpcResponse> {
    try {
      const dispatched = await this.dispatch(
        clientId,
        message.method,
        message.params,
      )
      switch (dispatched.resultType) {
        case 'success':
          return { jsonrpc: '2.0', id: message.id, result: dispatched.result }
        case 'invalidParams':
          return invalidParams(message.id, dispatched.message)
        case 'methodNotFound':
          return methodNotFound(message.id, message.method)
      }
    } catch (error) {
      return internalError(message.id, error)
    }
  }

  private async dispatchNotification(
    clientId: string | undefined,
    message: JsonRpcMessage,
  ): Promise<void> {
    try {
      await this.dispatch(clientId, message.method, message.params)
    } catch {
      // JSON-RPC notifications do not produce responses. Unknown runtime faults are
      // intentionally contained here so one bad notification cannot tear down the transport.
    }
  }

  private async dispatch(
    clientId: string | undefined,
    method: string,
    params: unknown,
  ): Promise<DispatchResult> {
    const handler = this.methodHandlers[method]
    if (!handler) {
      return { resultType: 'methodNotFound' }
    }
    return handler(clientId, params)
  }

  private readonly methodHandlers: Record<string, MethodHandler> = {
    initialize: async (_clientId, params) =>
      this.callWithParams(params, parseInitializeParams, value =>
        this.ports.initialize(value),
      ),
    'session.create': async (_clientId, params) =>
      this.callWithParams(params, parseSessionCreateParams, value =>
        this.ports.session.create(value),
      ),
    'session.load': async (_clientId, params) =>
      this.callWithParams(params, parseSessionLoadParams, value =>
        this.ports.session.load(value),
      ),
    'session.list': async (_clientId, params) => this.handleSessionList(params),
    'session.close': async (_clientId, params) =>
      this.callWithParams(params, parseSessionCloseParams, value =>
        this.ports.session.close(value),
      ),
    'session.prompt': async (_clientId, params) =>
      this.callWithParams(params, parseSessionPromptParams, value =>
        this.ports.session.prompt(value),
      ),
    'session.cancel': async (_clientId, params) =>
      this.callWithParams(params, parseSessionCancelParams, value =>
        this.ports.session.cancel(value),
      ),
    'session.snapshot': async (_clientId, params) =>
      this.callWithParams(params, parseSessionSnapshotParams, value =>
        this.ports.session.snapshot(value),
      ),
    'session.transcript': async (_clientId, params) =>
      this.callWithParams(params, parseSessionTranscriptParams, value =>
        this.ports.session.transcript(value),
      ),
    'events.replay': async (_clientId, params) =>
      this.handleEventsReplay(params),
    'events.subscribe': async (clientId, params) =>
      this.handleEventsSubscribe(clientId, params),
    'approval.respond': async (_clientId, params) =>
      this.callWithParams(params, parseApprovalRespondParams, value =>
        this.ports.approval.respond(value),
      ),
    'models.list': async (_clientId, params) =>
      this.callWithParams(params, parseModelsListParams, value =>
        this.ports.models.list(value),
      ),
    'session.setModel': async (_clientId, params) =>
      this.callWithParams(params, parseSessionSetModelParams, value =>
        this.ports.session.setModel(value),
      ),
    'session.setMode': async (_clientId, params) =>
      this.callWithParams(params, parseSessionSetModeParams, value =>
        this.ports.session.setMode(value),
      ),
  }

  private async handleSessionList(params: unknown): Promise<DispatchResult> {
    if (params !== undefined) {
      const parsed = requireObjectParams(params)
      if (parsed.resultType === 'invalidParams') return parsed
    }

    return { resultType: 'success', result: await this.ports.session.list() }
  }

  private async handleEventsReplay(params: unknown): Promise<DispatchResult> {
    if (!this.ports.events.replay) {
      return { resultType: 'success', result: { events: [] } }
    }
    return this.callWithParams(params, parseEventsReplayParams, value =>
      this.ports.events.replay?.(value),
    )
  }

  private async handleEventsSubscribe(
    clientId: string | undefined,
    params: unknown,
  ): Promise<DispatchResult> {
    const parsed = parseEventsSubscribeParams(params)
    if (parsed.resultType === 'invalidParams') return parsed

    const subscribed = await this.ports.events.subscribe(
      clientId,
      parsed.params,
    )
    const replayed = this.ports.events.replay
      ? await this.ports.events.replay({
          sessionId: parsed.params.sessionId,
          ...(parsed.params.afterSeq !== undefined
            ? { afterSeq: parsed.params.afterSeq }
            : {}),
        })
      : undefined

    if (!replayed || subscribed.resultType !== 'subscribed') {
      return { resultType: 'success', result: subscribed }
    }

    return {
      resultType: 'success',
      result: {
        ...subscribed,
        replayed: replayed.events,
      },
    }
  }

  private async callWithParams<TParams>(
    params: unknown,
    parser: ParamsParser<TParams>,
    callback: (params: TParams) => unknown | Promise<unknown>,
  ): Promise<DispatchResult> {
    const parsed = parser(params)
    if (parsed.resultType === 'invalidParams') return parsed

    const result = await callback(parsed.params)
    return { resultType: 'success', result }
  }
}

function parseInitializeParams(
  params: unknown,
): ParamsParseResult<InitializeParams> {
  const parsed = requireOptionalObjectParams(params)
  if (parsed.resultType === 'invalidParams') return parsed

  const clientName = optionalString(parsed.params, 'clientName')
  if (clientName.resultType === 'invalidParams') return clientName
  const protocolVersion = optionalString(parsed.params, 'protocolVersion')
  if (protocolVersion.resultType === 'invalidParams') return protocolVersion
  const authToken = optionalString(parsed.params, 'authToken')
  if (authToken.resultType === 'invalidParams') return authToken

  return {
    resultType: 'success',
    params: {
      ...(clientName.value !== undefined
        ? { clientName: clientName.value }
        : {}),
      ...(protocolVersion.value !== undefined
        ? { protocolVersion: protocolVersion.value }
        : {}),
      ...(authToken.value !== undefined ? { authToken: authToken.value } : {}),
    },
  }
}

function parseSessionCreateParams(
  params: unknown,
): ParamsParseResult<SessionCreateParams> {
  const parsed = requireObjectParams(params)
  if (parsed.resultType === 'invalidParams') return parsed

  const cwd = requiredString(parsed.params, 'cwd')
  if (cwd.resultType === 'invalidParams') return cwd
  const sessionId = optionalString(parsed.params, 'sessionId')
  if (sessionId.resultType === 'invalidParams') return sessionId
  const title = optionalString(parsed.params, 'title')
  if (title.resultType === 'invalidParams') return title
  const model = optionalString(parsed.params, 'model')
  if (model.resultType === 'invalidParams') return model
  const permissionMode = optionalString(parsed.params, 'permissionMode')
  if (permissionMode.resultType === 'invalidParams') return permissionMode

  return {
    resultType: 'success',
    params: {
      cwd: cwd.value,
      ...(sessionId.value !== undefined ? { sessionId: sessionId.value } : {}),
      ...(title.value !== undefined ? { title: title.value } : {}),
      ...(model.value !== undefined ? { model: model.value } : {}),
      ...(permissionMode.value !== undefined
        ? { permissionMode: permissionMode.value }
        : {}),
    },
  }
}

function parseSessionLoadParams(
  params: unknown,
): ParamsParseResult<SessionLoadParams> {
  return parseSessionIdOnlyParams(params)
}

function parseSessionCloseParams(
  params: unknown,
): ParamsParseResult<SessionCloseParams> {
  return parseSessionIdOnlyParams(params)
}

function parseSessionSnapshotParams(
  params: unknown,
): ParamsParseResult<SessionSnapshotParams> {
  return parseSessionIdOnlyParams(params)
}

function parseSessionTranscriptParams(
  params: unknown,
): ParamsParseResult<SessionTranscriptParams> {
  return parseSessionIdOnlyParams(params)
}

function parseSessionPromptParams(
  params: unknown,
): ParamsParseResult<SessionPromptParams> {
  const parsed = requireObjectParams(params)
  if (parsed.resultType === 'invalidParams') return parsed

  const sessionId = requiredString(parsed.params, 'sessionId')
  if (sessionId.resultType === 'invalidParams') return sessionId
  const prompt = requiredString(parsed.params, 'prompt')
  if (prompt.resultType === 'invalidParams') return prompt
  const runId = optionalString(parsed.params, 'runId')
  if (runId.resultType === 'invalidParams') return runId

  return {
    resultType: 'success',
    params: {
      sessionId: sessionId.value,
      prompt: prompt.value,
      ...(runId.value !== undefined ? { runId: runId.value } : {}),
      ...(parsed.params.payload !== undefined
        ? { payload: parsed.params.payload }
        : {}),
    },
  }
}

function parseSessionCancelParams(
  params: unknown,
): ParamsParseResult<SessionCancelParams> {
  const parsed = requireObjectParams(params)
  if (parsed.resultType === 'invalidParams') return parsed

  const sessionId = requiredString(parsed.params, 'sessionId')
  if (sessionId.resultType === 'invalidParams') return sessionId
  const runId = optionalString(parsed.params, 'runId')
  if (runId.resultType === 'invalidParams') return runId
  const reason = optionalString(parsed.params, 'reason')
  if (reason.resultType === 'invalidParams') return reason

  return {
    resultType: 'success',
    params: {
      sessionId: sessionId.value,
      ...(runId.value !== undefined ? { runId: runId.value } : {}),
      ...(reason.value !== undefined ? { reason: reason.value } : {}),
    },
  }
}

function parseEventsReplayParams(
  params: unknown,
): ParamsParseResult<EventsReplayParams> {
  const parsed = requireObjectParams(params)
  if (parsed.resultType === 'invalidParams') return parsed

  const sessionId = requiredString(parsed.params, 'sessionId')
  if (sessionId.resultType === 'invalidParams') return sessionId
  const afterSeq = optionalFiniteNumber(parsed.params, 'afterSeq')
  if (afterSeq.resultType === 'invalidParams') return afterSeq
  const limit = optionalFiniteNumber(parsed.params, 'limit')
  if (limit.resultType === 'invalidParams') return limit

  return {
    resultType: 'success',
    params: {
      sessionId: sessionId.value,
      ...(afterSeq.value !== undefined ? { afterSeq: afterSeq.value } : {}),
      ...(limit.value !== undefined ? { limit: limit.value } : {}),
    },
  }
}

function parseEventsSubscribeParams(
  params: unknown,
): ParamsParseResult<EventsSubscribeParams> {
  const parsed = requireObjectParams(params)
  if (parsed.resultType === 'invalidParams') return parsed

  const sessionId = requiredString(parsed.params, 'sessionId')
  if (sessionId.resultType === 'invalidParams') return sessionId
  const afterSeq = optionalFiniteNumber(parsed.params, 'afterSeq')
  if (afterSeq.resultType === 'invalidParams') return afterSeq

  return {
    resultType: 'success',
    params: {
      sessionId: sessionId.value,
      ...(afterSeq.value !== undefined ? { afterSeq: afterSeq.value } : {}),
    },
  }
}

function parseApprovalRespondParams(
  params: unknown,
): ParamsParseResult<ApprovalRespondParams> {
  const parsed = requireObjectParams(params)
  if (parsed.resultType === 'invalidParams') return parsed

  const sessionId = requiredString(parsed.params, 'sessionId')
  if (sessionId.resultType === 'invalidParams') return sessionId
  const approvalId = requiredString(parsed.params, 'approvalId')
  if (approvalId.resultType === 'invalidParams') return approvalId
  const optionId = requiredString(parsed.params, 'optionId')
  if (optionId.resultType === 'invalidParams') return optionId
  const reason = optionalString(parsed.params, 'reason')
  if (reason.resultType === 'invalidParams') return reason

  return {
    resultType: 'success',
    params: {
      sessionId: sessionId.value,
      approvalId: approvalId.value,
      optionId: optionId.value,
      ...(reason.value !== undefined ? { reason: reason.value } : {}),
    },
  }
}

function parseModelsListParams(
  params: unknown,
): ParamsParseResult<ModelsListParams> {
  const parsed = requireOptionalObjectParams(params)
  if (parsed.resultType === 'invalidParams') return parsed

  const sessionId = optionalString(parsed.params, 'sessionId')
  if (sessionId.resultType === 'invalidParams') return sessionId

  return {
    resultType: 'success',
    params: {
      ...(sessionId.value !== undefined ? { sessionId: sessionId.value } : {}),
    },
  }
}

function parseSessionSetModelParams(
  params: unknown,
): ParamsParseResult<SessionSetModelParams> {
  const parsed = requireObjectParams(params)
  if (parsed.resultType === 'invalidParams') return parsed

  const sessionId = requiredString(parsed.params, 'sessionId')
  if (sessionId.resultType === 'invalidParams') return sessionId
  const model = requiredString(parsed.params, 'model')
  if (model.resultType === 'invalidParams') return model

  return {
    resultType: 'success',
    params: { sessionId: sessionId.value, model: model.value },
  }
}

function parseSessionSetModeParams(
  params: unknown,
): ParamsParseResult<SessionSetModeParams> {
  const parsed = requireObjectParams(params)
  if (parsed.resultType === 'invalidParams') return parsed

  const sessionId = requiredString(parsed.params, 'sessionId')
  if (sessionId.resultType === 'invalidParams') return sessionId
  const mode = requiredString(parsed.params, 'mode')
  if (mode.resultType === 'invalidParams') return mode

  return {
    resultType: 'success',
    params: { sessionId: sessionId.value, mode: mode.value },
  }
}

function parseSessionIdOnlyParams<TParams extends { sessionId: string }>(
  params: unknown,
): ParamsParseResult<TParams> {
  const parsed = requireObjectParams(params)
  if (parsed.resultType === 'invalidParams') return parsed

  const sessionId = requiredString(parsed.params, 'sessionId')
  if (sessionId.resultType === 'invalidParams') return sessionId

  return {
    resultType: 'success',
    params: { sessionId: sessionId.value } as TParams,
  }
}

function requireOptionalObjectParams(
  params: unknown,
): ParamsParseResult<Record<string, unknown>> {
  if (params === undefined) return { resultType: 'success', params: {} }
  return requireObjectParams(params)
}

function requireObjectParams(
  params: unknown,
): ParamsParseResult<Record<string, unknown>> {
  if (
    params === undefined ||
    params === null ||
    typeof params !== 'object' ||
    Array.isArray(params)
  ) {
    return { resultType: 'invalidParams', message: 'params must be an object' }
  }
  return { resultType: 'success', params: params as Record<string, unknown> }
}

function requiredString(
  params: Record<string, unknown>,
  key: string,
): ScalarParseResult<string> {
  const value = params[key]
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      resultType: 'invalidParams',
      message: `${key} must be a non-empty string`,
    }
  }
  return { resultType: 'success', value }
}

function optionalString(
  params: Record<string, unknown>,
  key: string,
): ScalarParseResult<string | undefined> {
  const value = params[key]
  if (value === undefined) return { resultType: 'success', value: undefined }
  if (typeof value !== 'string') {
    return { resultType: 'invalidParams', message: `${key} must be a string` }
  }
  return { resultType: 'success', value }
}

function optionalFiniteNumber(
  params: Record<string, unknown>,
  key: string,
): ScalarParseResult<number | undefined> {
  const value = params[key]
  if (value === undefined) return { resultType: 'success', value: undefined }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return {
      resultType: 'invalidParams',
      message: `${key} must be a finite number`,
    }
  }
  return { resultType: 'success', value }
}

export type {
  ApprovalRespondParams,
  EventsReplayParams,
  EventsSubscribeParams,
  InitializeParams,
  ModelsListParams,
  SessionCancelParams,
  SessionCloseParams,
  SessionCreateParams,
  SessionLoadParams,
  SessionPromptParams,
  SessionSetModeParams,
  SessionSetModelParams,
  SessionSnapshotParams,
}
