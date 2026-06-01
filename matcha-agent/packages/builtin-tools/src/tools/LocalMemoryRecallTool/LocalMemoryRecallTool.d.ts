import { z } from 'zod/v4'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
export declare function _resetFetchBudgetForTest(): void
declare const inputSchema: () => z.ZodObject<
  {
    action: z.ZodEnum<{
      fetch: 'fetch'
      list_stores: 'list_stores'
      list_entries: 'list_entries'
    }>
    store: z.ZodOptional<z.ZodString>
    key: z.ZodOptional<z.ZodString>
    preview_only: z.ZodOptional<z.ZodBoolean>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    action: z.ZodEnum<{
      fetch: 'fetch'
      list_stores: 'list_stores'
      list_entries: 'list_entries'
    }>
    stores: z.ZodOptional<z.ZodArray<z.ZodString>>
    entries: z.ZodOptional<z.ZodArray<z.ZodString>>
    store: z.ZodOptional<z.ZodString>
    key: z.ZodOptional<z.ZodString>
    value: z.ZodOptional<z.ZodString>
    preview_only: z.ZodOptional<z.ZodBoolean>
    truncated: z.ZodOptional<z.ZodBoolean>
    budget_exceeded: z.ZodOptional<z.ZodBoolean>
    error: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const LocalMemoryRecallTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    isReadOnly(): true
    isConcurrencySafe(): true
    toAutoClassifierInput(input: {
      action: 'fetch' | 'list_stores' | 'list_entries'
      store?: string | undefined
      key?: string | undefined
      preview_only?: boolean | undefined
    }): string
    requiresUserInteraction(): true
    userFacingName: () => string
    description(): Promise<string>
    prompt(): Promise<string>
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    checkPermissions(
      input: {
        action: 'fetch' | 'list_stores' | 'list_entries'
        store?: string | undefined
        key?: string | undefined
        preview_only?: boolean | undefined
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
          behavior: 'allow'
          updatedInput: {
            action: 'fetch' | 'list_stores' | 'list_entries'
            store?: string | undefined
            key?: string | undefined
            preview_only?: boolean | undefined
          }
          message?: undefined
          decisionReason?: undefined
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
            action: 'fetch' | 'list_stores' | 'list_entries'
            store?: string | undefined
            key?: string | undefined
            preview_only?: boolean | undefined
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
      context: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: {
        action: 'fetch' | 'list_stores' | 'list_entries'
        stores?: string[] | undefined
        entries?: string[] | undefined
        store?: string | undefined
        key?: string | undefined
        value?: string | undefined
        preview_only?: boolean | undefined
        truncated?: boolean | undefined
        budget_exceeded?: boolean | undefined
        error?: string | undefined
      }
    }>
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolResultMessage: typeof renderToolResultMessage
    mapToolResultToToolResultBlockParam(
      output: {
        action: 'fetch' | 'list_stores' | 'list_entries'
        stores?: string[] | undefined
        entries?: string[] | undefined
        store?: string | undefined
        key?: string | undefined
        value?: string | undefined
        preview_only?: boolean | undefined
        truncated?: boolean | undefined
        budget_exceeded?: boolean | undefined
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
  isConcurrencySafe: () => true
  isReadOnly: () => true
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      action: 'fetch' | 'list_stores' | 'list_entries'
      store?: string | undefined
      key?: string | undefined
      preview_only?: boolean | undefined
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
        behavior: 'allow'
        updatedInput: {
          action: 'fetch' | 'list_stores' | 'list_entries'
          store?: string | undefined
          key?: string | undefined
          preview_only?: boolean | undefined
        }
        message?: undefined
        decisionReason?: undefined
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
          action: 'fetch' | 'list_stores' | 'list_entries'
          store?: string | undefined
          key?: string | undefined
          preview_only?: boolean | undefined
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
    action: 'fetch' | 'list_stores' | 'list_entries'
    store?: string | undefined
    key?: string | undefined
    preview_only?: boolean | undefined
  }) => string
}
export {}
