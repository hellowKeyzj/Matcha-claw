import { z } from 'zod/v4'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'
declare const inputSchema: () => z.ZodObject<
  {
    setting: z.ZodString
    value: z.ZodOptional<
      z.ZodUnion<readonly [z.ZodString, z.ZodBoolean, z.ZodNumber]>
    >
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    success: z.ZodBoolean
    operation: z.ZodOptional<
      z.ZodEnum<{
        set: 'set'
        get: 'get'
      }>
    >
    setting: z.ZodOptional<z.ZodString>
    value: z.ZodOptional<z.ZodUnknown>
    previousValue: z.ZodOptional<z.ZodUnknown>
    newValue: z.ZodOptional<z.ZodUnknown>
    error: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Input = z.infer<InputSchema>
export type Output = z.infer<OutputSchema>
export declare const ConfigTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    description(): Promise<string>
    prompt(): Promise<string>
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    userFacingName(): string
    shouldDefer: true
    isConcurrencySafe(): true
    isReadOnly(input: Input): boolean
    toAutoClassifierInput(input: {
      setting: string
      value?: string | number | boolean | undefined
    }): string
    checkPermissions(input: Input): Promise<
      | {
          behavior: 'allow'
          updatedInput: {
            setting: string
            value?: string | number | boolean | undefined
          }
          message?: undefined
        }
      | {
          behavior: 'ask'
          message: string
          updatedInput?: undefined
        }
    >
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolResultMessage: typeof renderToolResultMessage
    renderToolUseRejectedMessage: typeof renderToolUseRejectedMessage
    call(
      { setting, value }: Input,
      context: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: Output
    }>
    mapToolResultToToolResultBlockParam(
      content: Output,
      toolUseID: string,
    ):
      | {
          tool_use_id: string
          type: 'tool_result'
          content: string
          is_error?: undefined
        }
      | {
          tool_use_id: string
          type: 'tool_result'
          content: string
          is_error: true
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
  isReadOnly: (input: Input) => boolean
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (input: Input) => Promise<
    | {
        behavior: 'allow'
        updatedInput: {
          setting: string
          value?: string | number | boolean | undefined
        }
        message?: undefined
      }
    | {
        behavior: 'ask'
        message: string
        updatedInput?: undefined
      }
  >
  toAutoClassifierInput: (input: {
    setting: string
    value?: string | number | boolean | undefined
  }) => string
}
export {}
