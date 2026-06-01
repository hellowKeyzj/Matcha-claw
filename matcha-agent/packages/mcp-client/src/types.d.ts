import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type {
  Resource,
  ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
export declare const ConfigScope: z.ZodEnum<{
  user: 'user'
  project: 'project'
  local: 'local'
  managed: 'managed'
  dynamic: 'dynamic'
  enterprise: 'enterprise'
  claudeai: 'claudeai'
}>
export type ConfigScope = z.infer<typeof ConfigScope>
export declare const TransportType: z.ZodEnum<{
  stdio: 'stdio'
  sse: 'sse'
  http: 'http'
  sdk: 'sdk'
  'claudeai-proxy': 'claudeai-proxy'
  'sse-ide': 'sse-ide'
  ws: 'ws'
}>
export type Transport = z.infer<typeof TransportType>
export declare const McpStdioServerConfigSchema: z.ZodObject<
  {
    type: z.ZodOptional<z.ZodLiteral<'stdio'>>
    command: z.ZodString
    args: z.ZodDefault<z.ZodArray<z.ZodString>>
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
  },
  z.core.$strip
>
export declare const McpSSEServerConfigSchema: z.ZodObject<
  {
    type: z.ZodLiteral<'sse'>
    url: z.ZodString
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
    headersHelper: z.ZodOptional<z.ZodString>
    oauth: z.ZodOptional<
      z.ZodObject<
        {
          clientId: z.ZodOptional<z.ZodString>
          callbackPort: z.ZodOptional<z.ZodNumber>
          authServerMetadataUrl: z.ZodOptional<z.ZodString>
          xaa: z.ZodOptional<z.ZodBoolean>
        },
        z.core.$strip
      >
    >
  },
  z.core.$strip
>
export declare const McpSSEIDEServerConfigSchema: z.ZodObject<
  {
    type: z.ZodLiteral<'sse-ide'>
    url: z.ZodString
    ideName: z.ZodString
    ideRunningInWindows: z.ZodOptional<z.ZodBoolean>
  },
  z.core.$strip
>
export declare const McpWebSocketIDEServerConfigSchema: z.ZodObject<
  {
    type: z.ZodLiteral<'ws-ide'>
    url: z.ZodString
    ideName: z.ZodString
    authToken: z.ZodOptional<z.ZodString>
    ideRunningInWindows: z.ZodOptional<z.ZodBoolean>
  },
  z.core.$strip
>
export declare const McpHTTPServerConfigSchema: z.ZodObject<
  {
    type: z.ZodLiteral<'http'>
    url: z.ZodString
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
    headersHelper: z.ZodOptional<z.ZodString>
    oauth: z.ZodOptional<
      z.ZodObject<
        {
          clientId: z.ZodOptional<z.ZodString>
          callbackPort: z.ZodOptional<z.ZodNumber>
          authServerMetadataUrl: z.ZodOptional<z.ZodString>
          xaa: z.ZodOptional<z.ZodBoolean>
        },
        z.core.$strip
      >
    >
  },
  z.core.$strip
>
export declare const McpWebSocketServerConfigSchema: z.ZodObject<
  {
    type: z.ZodLiteral<'ws'>
    url: z.ZodString
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
    headersHelper: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
export declare const McpSdkServerConfigSchema: z.ZodObject<
  {
    type: z.ZodLiteral<'sdk'>
    name: z.ZodString
  },
  z.core.$strip
>
export declare const McpClaudeAIProxyServerConfigSchema: z.ZodObject<
  {
    type: z.ZodLiteral<'claudeai-proxy'>
    url: z.ZodString
    id: z.ZodString
  },
  z.core.$strip
>
export declare const McpServerConfigSchema: z.ZodUnion<
  readonly [
    z.ZodObject<
      {
        type: z.ZodOptional<z.ZodLiteral<'stdio'>>
        command: z.ZodString
        args: z.ZodDefault<z.ZodArray<z.ZodString>>
        env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'sse'>
        url: z.ZodString
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
        headersHelper: z.ZodOptional<z.ZodString>
        oauth: z.ZodOptional<
          z.ZodObject<
            {
              clientId: z.ZodOptional<z.ZodString>
              callbackPort: z.ZodOptional<z.ZodNumber>
              authServerMetadataUrl: z.ZodOptional<z.ZodString>
              xaa: z.ZodOptional<z.ZodBoolean>
            },
            z.core.$strip
          >
        >
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'sse-ide'>
        url: z.ZodString
        ideName: z.ZodString
        ideRunningInWindows: z.ZodOptional<z.ZodBoolean>
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'ws-ide'>
        url: z.ZodString
        ideName: z.ZodString
        authToken: z.ZodOptional<z.ZodString>
        ideRunningInWindows: z.ZodOptional<z.ZodBoolean>
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'http'>
        url: z.ZodString
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
        headersHelper: z.ZodOptional<z.ZodString>
        oauth: z.ZodOptional<
          z.ZodObject<
            {
              clientId: z.ZodOptional<z.ZodString>
              callbackPort: z.ZodOptional<z.ZodNumber>
              authServerMetadataUrl: z.ZodOptional<z.ZodString>
              xaa: z.ZodOptional<z.ZodBoolean>
            },
            z.core.$strip
          >
        >
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'ws'>
        url: z.ZodString
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
        headersHelper: z.ZodOptional<z.ZodString>
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'sdk'>
        name: z.ZodString
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        type: z.ZodLiteral<'claudeai-proxy'>
        url: z.ZodString
        id: z.ZodString
      },
      z.core.$strip
    >,
  ]
>
export type McpStdioServerConfig = z.infer<typeof McpStdioServerConfigSchema>
export type McpSSEServerConfig = z.infer<typeof McpSSEServerConfigSchema>
export type McpSSEIDEServerConfig = z.infer<typeof McpSSEIDEServerConfigSchema>
export type McpWebSocketIDEServerConfig = z.infer<
  typeof McpWebSocketIDEServerConfigSchema
>
export type McpHTTPServerConfig = z.infer<typeof McpHTTPServerConfigSchema>
export type McpWebSocketServerConfig = z.infer<
  typeof McpWebSocketServerConfigSchema
>
export type McpSdkServerConfig = z.infer<typeof McpSdkServerConfigSchema>
export type McpClaudeAIProxyServerConfig = z.infer<
  typeof McpClaudeAIProxyServerConfigSchema
>
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>
export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  pluginSource?: string
}
export declare const McpJsonConfigSchema: z.ZodObject<
  {
    mcpServers: z.ZodRecord<
      z.ZodString,
      z.ZodUnion<
        readonly [
          z.ZodObject<
            {
              type: z.ZodOptional<z.ZodLiteral<'stdio'>>
              command: z.ZodString
              args: z.ZodDefault<z.ZodArray<z.ZodString>>
              env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              type: z.ZodLiteral<'sse'>
              url: z.ZodString
              headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
              headersHelper: z.ZodOptional<z.ZodString>
              oauth: z.ZodOptional<
                z.ZodObject<
                  {
                    clientId: z.ZodOptional<z.ZodString>
                    callbackPort: z.ZodOptional<z.ZodNumber>
                    authServerMetadataUrl: z.ZodOptional<z.ZodString>
                    xaa: z.ZodOptional<z.ZodBoolean>
                  },
                  z.core.$strip
                >
              >
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              type: z.ZodLiteral<'sse-ide'>
              url: z.ZodString
              ideName: z.ZodString
              ideRunningInWindows: z.ZodOptional<z.ZodBoolean>
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              type: z.ZodLiteral<'ws-ide'>
              url: z.ZodString
              ideName: z.ZodString
              authToken: z.ZodOptional<z.ZodString>
              ideRunningInWindows: z.ZodOptional<z.ZodBoolean>
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              type: z.ZodLiteral<'http'>
              url: z.ZodString
              headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
              headersHelper: z.ZodOptional<z.ZodString>
              oauth: z.ZodOptional<
                z.ZodObject<
                  {
                    clientId: z.ZodOptional<z.ZodString>
                    callbackPort: z.ZodOptional<z.ZodNumber>
                    authServerMetadataUrl: z.ZodOptional<z.ZodString>
                    xaa: z.ZodOptional<z.ZodBoolean>
                  },
                  z.core.$strip
                >
              >
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              type: z.ZodLiteral<'ws'>
              url: z.ZodString
              headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
              headersHelper: z.ZodOptional<z.ZodString>
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              type: z.ZodLiteral<'sdk'>
              name: z.ZodString
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              type: z.ZodLiteral<'claudeai-proxy'>
              url: z.ZodString
              id: z.ZodString
            },
            z.core.$strip
          >,
        ]
      >
    >
  },
  z.core.$strip
>
export type McpJsonConfig = z.infer<typeof McpJsonConfigSchema>
export type ConnectedMCPServer = {
  client: Client
  name: string
  type: 'connected'
  capabilities: ServerCapabilities
  serverInfo?: {
    name: string
    version: string
  }
  instructions?: string
  config: ScopedMcpServerConfig
  cleanup: () => Promise<void>
}
export type FailedMCPServer = {
  name: string
  type: 'failed'
  config: ScopedMcpServerConfig
  error?: string
}
export type NeedsAuthMCPServer = {
  name: string
  type: 'needs-auth'
  config: ScopedMcpServerConfig
}
export type PendingMCPServer = {
  name: string
  type: 'pending'
  config: ScopedMcpServerConfig
  reconnectAttempt?: number
  maxReconnectAttempts?: number
}
export type DisabledMCPServer = {
  name: string
  type: 'disabled'
  config: ScopedMcpServerConfig
}
export type MCPServerConnection =
  | ConnectedMCPServer
  | FailedMCPServer
  | NeedsAuthMCPServer
  | PendingMCPServer
  | DisabledMCPServer
export type ServerResource = Resource & {
  server: string
}
export interface SerializedTool {
  name: string
  description: string
  inputJSONSchema?: {
    [x: string]: unknown
    type: 'object'
    properties?: {
      [x: string]: unknown
    }
  }
  isMcp?: boolean
  originalToolName?: string
}
export interface SerializedClient {
  name: string
  type: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  capabilities?: ServerCapabilities
}
export interface MCPCliState {
  clients: SerializedClient[]
  configs: Record<string, ScopedMcpServerConfig>
  tools: SerializedTool[]
  resources: Record<string, ServerResource[]>
  normalizedNames?: Record<string, string>
}
