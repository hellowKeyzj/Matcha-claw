import type {
  ClassifiedError,
  JsonRpcFailure,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
} from './types.js'

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number'
}

export function parseJsonRpcMessage(
  raw: string,
):
  | { resultType: 'message'; message: JsonRpcMessage }
  | { resultType: 'error'; response: JsonRpcFailure } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      resultType: 'error',
      response: jsonRpcError(
        null,
        PARSE_ERROR,
        'Parse error',
        errorToMessage(error),
      ),
    }
  }

  const message = validateJsonRpcMessage(parsed)
  if (message.resultType === 'error') {
    return {
      resultType: 'error',
      response: jsonRpcError(message.id, INVALID_REQUEST, message.message),
    }
  }

  return { resultType: 'message', message: message.message }
}

export function validateJsonRpcMessage(
  value: unknown,
):
  | { resultType: 'message'; message: JsonRpcMessage }
  | { resultType: 'error'; id: JsonRpcId | null; message: string } {
  if (!isRecord(value)) {
    return {
      resultType: 'error',
      id: null,
      message: 'JSON-RPC message must be an object',
    }
  }

  const id = isJsonRpcId(value.id) ? value.id : null
  if (value.jsonrpc !== '2.0') {
    return { resultType: 'error', id, message: 'jsonrpc must be "2.0"' }
  }

  if (typeof value.method !== 'string' || value.method.trim() === '') {
    return {
      resultType: 'error',
      id,
      message: 'method must be a non-empty string',
    }
  }

  if ('id' in value) {
    if (!isJsonRpcId(value.id)) {
      return {
        resultType: 'error',
        id: null,
        message: 'id must be string or number',
      }
    }
    return {
      resultType: 'message',
      message: {
        jsonrpc: '2.0',
        id: value.id,
        method: value.method,
        ...(value.params !== undefined ? { params: value.params } : {}),
      },
    }
  }

  return {
    resultType: 'message',
    message: {
      jsonrpc: '2.0',
      method: value.method,
      ...(value.params !== undefined ? { params: value.params } : {}),
    },
  }
}

export function isJsonRpcRequest(
  message: JsonRpcMessage,
): message is JsonRpcRequest {
  return 'id' in message
}

export function jsonRpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

export function jsonRpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  }
}

export function methodNotFound(id: JsonRpcId, method: string): JsonRpcFailure {
  return jsonRpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`)
}

export function invalidParams(id: JsonRpcId, message: string): JsonRpcFailure {
  return jsonRpcError(id, INVALID_PARAMS, message)
}

export function internalError(id: JsonRpcId, error: unknown): JsonRpcFailure {
  return jsonRpcError(id, INTERNAL_ERROR, errorToMessage(error))
}

export function encodeJsonRpcMessage(
  message: JsonRpcResponse | JsonRpcMessage,
): string {
  return `${JSON.stringify(message)}\n`
}

export function errorToClassifiedError(error: unknown): ClassifiedError {
  if (error instanceof Error) {
    return {
      type: error.name === 'AbortError' ? 'aborted' : 'internal',
      message: error.message,
      retryable: false,
    }
  }

  return {
    type: 'internal',
    message: String(error),
    retryable: false,
  }
}

export function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export function requireRecordParams(params: unknown): Record<string, unknown> {
  if (!isRecord(params)) {
    throw new Error('params must be an object')
  }
  return params
}

export function requireString(
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} must be a non-empty string`)
  }
  return value
}

export function optionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`)
  }
  return value
}

export function optionalNumber(
  params: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`)
  }
  return value
}
