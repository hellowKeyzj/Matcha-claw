import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'
import type {
  AnyZodRawShape,
  InferShape,
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from './runtimeTypes.js'

export type CreateSdkMcpServerOptions = {
  name: string
  version?: string
  tools?: SdkMcpToolDefinition[]
}

export function tool<Schema extends AnyZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: SdkMcpToolDefinition<Schema>['handler'],
  extras?: {
    annotations?: ToolAnnotations
    searchHint?: string
    alwaysLoad?: boolean
  },
): SdkMcpToolDefinition<Schema> {
  return {
    name,
    description,
    inputSchema,
    handler,
    ...extras,
  }
}

export function createSdkMcpServer(
  options: CreateSdkMcpServerOptions,
): McpSdkServerConfigWithInstance {
  return {
    type: 'sdk',
    name: options.name,
    version: options.version,
    tools: options.tools ?? [],
  }
}

export async function handleSdkMcpMessage(
  servers: McpSdkServerConfigWithInstance[],
  serverName: string,
  message: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const server = servers.find(candidate => candidate.name === serverName)
  if (!server) {
    throw new Error(`Unknown SDK MCP server: ${serverName}`)
  }

  const request = message as {
    id?: string | number | null
    method?: unknown
    params?: Record<string, unknown>
  }

  if (typeof request.method !== 'string') {
    return jsonRpcError(request.id, -32600, 'Invalid SDK MCP request')
  }

  if (request.method === 'initialize') {
    return jsonRpcResult(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: server.name,
        version: server.version ?? '0.0.0',
      },
    })
  }

  if (request.method === 'tools/list') {
    return jsonRpcResult(request.id, {
      tools: server.tools.map(toolDefinition => ({
        name: toolDefinition.name,
        description: toolDefinition.description,
        inputSchema: toolDefinition.inputSchema,
        annotations: toolDefinition.annotations,
      })),
    })
  }

  if (request.method === 'tools/call') {
    const name = request.params?.name
    if (typeof name !== 'string') {
      return jsonRpcError(
        request.id,
        -32602,
        'tools/call requires a string tool name',
      )
    }
    const toolDefinition = server.tools.find(
      candidate => candidate.name === name,
    )
    if (!toolDefinition) {
      return jsonRpcError(request.id, -32602, `Unknown SDK MCP tool: ${name}`)
    }
    if (signal?.aborted) {
      return jsonRpcError(request.id, -32000, 'SDK MCP tool call was cancelled')
    }
    try {
      const result = await toolDefinition.handler(
        (request.params?.arguments ?? {}) as never,
        { serverName, signal },
      )
      return jsonRpcResult(request.id, result)
    } catch (error) {
      return jsonRpcError(
        request.id,
        signal?.aborted ? -32000 : -32001,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  return jsonRpcError(
    request.id,
    -32601,
    `Unsupported SDK MCP method: ${request.method}`,
  )
}

function jsonRpcResult(
  id: string | number | null | undefined,
  result: unknown,
): unknown {
  if (id === undefined) return undefined
  return { jsonrpc: '2.0', id, result }
}

function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
): unknown {
  if (id === undefined) return undefined
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  }
}
