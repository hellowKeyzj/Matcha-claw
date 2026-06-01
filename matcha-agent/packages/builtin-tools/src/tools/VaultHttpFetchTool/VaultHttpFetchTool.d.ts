import { z } from 'zod/v4'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
declare const inputSchema: () => z.ZodObject<
  {
    url: z.ZodString
    method: z.ZodDefault<
      z.ZodEnum<{
        GET: 'GET'
        DELETE: 'DELETE'
        POST: 'POST'
        PUT: 'PUT'
        PATCH: 'PATCH'
      }>
    >
    vault_auth_key: z.ZodString
    auth_scheme: z.ZodDefault<
      z.ZodEnum<{
        custom: 'custom'
        basic: 'basic'
        bearer: 'bearer'
        header_x_api_key: 'header_x_api_key'
      }>
    >
    auth_header_name: z.ZodOptional<z.ZodString>
    body: z.ZodOptional<z.ZodString>
    body_content_type: z.ZodOptional<z.ZodString>
    reason: z.ZodString
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    status: z.ZodOptional<z.ZodNumber>
    statusText: z.ZodOptional<z.ZodString>
    responseHeaders: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>
    body: z.ZodOptional<z.ZodString>
    error: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const VaultHttpFetchTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    isConcurrencySafe(): false
    isReadOnly(): false
    toAutoClassifierInput(input: {
      url: string
      method: 'GET' | 'DELETE' | 'POST' | 'PUT' | 'PATCH'
      vault_auth_key: string
      auth_scheme: 'custom' | 'basic' | 'bearer' | 'header_x_api_key'
      reason: string
      auth_header_name?: string | undefined
      body?: string | undefined
      body_content_type?: string | undefined
    }): string
    requiresUserInteraction(): true
    userFacingName: () => string
    description(): Promise<string>
    prompt(): Promise<string>
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    checkPermissions(
      input: {
        url: string
        method: 'GET' | 'DELETE' | 'POST' | 'PUT' | 'PATCH'
        vault_auth_key: string
        auth_scheme: 'custom' | 'basic' | 'bearer' | 'header_x_api_key'
        reason: string
        auth_header_name?: string | undefined
        body?: string | undefined
        body_content_type?: string | undefined
      },
      context: import('src/Tool.js').ToolUseContext,
    ): Promise<
      | {
          behavior: 'deny'
          message: string
          decisionReason: {
            type: 'other'
            reason: string
            rule?: undefined
          }
          updatedInput?: undefined
        }
      | {
          behavior: 'deny'
          message: string
          decisionReason: {
            type: 'rule'
            rule: import('src/types/permissions.js').PermissionRule
            reason?: undefined
          }
          updatedInput?: undefined
        }
      | {
          behavior: 'allow'
          updatedInput: {
            url: string
            method: 'GET' | 'DELETE' | 'POST' | 'PUT' | 'PATCH'
            vault_auth_key: string
            auth_scheme: 'custom' | 'basic' | 'bearer' | 'header_x_api_key'
            reason: string
            auth_header_name?: string | undefined
            body?: string | undefined
            body_content_type?: string | undefined
          }
          decisionReason: {
            type: 'rule'
            rule: import('src/types/permissions.js').PermissionRule
            reason?: undefined
          }
          message?: undefined
        }
      | {
          behavior: 'ask'
          message: string
          decisionReason: {
            type: 'other'
            reason: string
            rule?: undefined
          }
          updatedInput?: undefined
        }
    >
    call(
      input: Input,
      _context: import('src/Tool.js').ToolUseContext,
    ): Promise<
      | {
          data: {
            error: string
            status?: undefined
            statusText?: undefined
            responseHeaders?: undefined
            body?: undefined
          }
        }
      | {
          data: {
            status: number
            statusText: string
            responseHeaders: Record<string, string>
            body: string
            error?: undefined
          }
        }
    >
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolResultMessage: typeof renderToolResultMessage
    mapToolResultToToolResultBlockParam(
      output: {
        status?: number | undefined
        statusText?: string | undefined
        responseHeaders?: Record<string, string> | undefined
        body?: string | undefined
        error?: string | undefined
      },
      toolUseID: string,
    ): {
      type: 'tool_result'
      tool_use_id: string
      content: string
      is_error: boolean
    }
  },
  | 'isEnabled'
  | 'userFacingName'
  | 'isConcurrencySafe'
  | 'isReadOnly'
  | 'isDestructive'
  | 'checkPermissions'
  | 'toAutoClassifierInput'
> & {
  isEnabled: () => boolean
  userFacingName: () => string
  isConcurrencySafe: () => false
  isReadOnly: () => false
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      url: string
      method: 'GET' | 'DELETE' | 'POST' | 'PUT' | 'PATCH'
      vault_auth_key: string
      auth_scheme: 'custom' | 'basic' | 'bearer' | 'header_x_api_key'
      reason: string
      auth_header_name?: string | undefined
      body?: string | undefined
      body_content_type?: string | undefined
    },
    context: import('src/Tool.js').ToolUseContext,
  ) => Promise<
    | {
        behavior: 'deny'
        message: string
        decisionReason: {
          type: 'other'
          reason: string
          rule?: undefined
        }
        updatedInput?: undefined
      }
    | {
        behavior: 'deny'
        message: string
        decisionReason: {
          type: 'rule'
          rule: import('src/types/permissions.js').PermissionRule
          reason?: undefined
        }
        updatedInput?: undefined
      }
    | {
        behavior: 'allow'
        updatedInput: {
          url: string
          method: 'GET' | 'DELETE' | 'POST' | 'PUT' | 'PATCH'
          vault_auth_key: string
          auth_scheme: 'custom' | 'basic' | 'bearer' | 'header_x_api_key'
          reason: string
          auth_header_name?: string | undefined
          body?: string | undefined
          body_content_type?: string | undefined
        }
        decisionReason: {
          type: 'rule'
          rule: import('src/types/permissions.js').PermissionRule
          reason?: undefined
        }
        message?: undefined
      }
    | {
        behavior: 'ask'
        message: string
        decisionReason: {
          type: 'other'
          reason: string
          rule?: undefined
        }
        updatedInput?: undefined
      }
  >
  toAutoClassifierInput: (input: {
    url: string
    method: 'GET' | 'DELETE' | 'POST' | 'PUT' | 'PATCH'
    vault_auth_key: string
    auth_scheme: 'custom' | 'basic' | 'bearer' | 'header_x_api_key'
    reason: string
    auth_header_name?: string | undefined
    body?: string | undefined
    body_content_type?: string | undefined
  }) => string
}
export {}
