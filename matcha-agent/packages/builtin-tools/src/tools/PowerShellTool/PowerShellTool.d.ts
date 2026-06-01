import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { z } from 'zod/v4'
import type { Tool, ToolCallProgress, ValidationResult } from 'src/Tool.js'
import type { AssistantMessage } from 'src/types/message.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolUseQueuedMessage,
} from './UI.js'
/**
 * PS-flavored port of BashTool's detectBlockedSleepPattern.
 * Catches `Start-Sleep N`, `Start-Sleep -Seconds N`, `sleep N` (built-in alias)
 * as the first statement. Does NOT block `Start-Sleep -Milliseconds` (sub-second
 * pacing is fine) or float seconds (legit rate limiting).
 */
export declare function detectBlockedSleepPattern(
  command: string,
): string | null
declare const fullInputSchema: () => z.ZodObject<
  {
    command: z.ZodString
    timeout: z.ZodPipe<
      z.ZodTransform<unknown, unknown>,
      z.ZodOptional<z.ZodNumber>
    >
    description: z.ZodOptional<z.ZodString>
    run_in_background: z.ZodPipe<
      z.ZodTransform<unknown, unknown>,
      z.ZodOptional<z.ZodBoolean>
    >
    dangerouslyDisableSandbox: z.ZodPipe<
      z.ZodTransform<unknown, unknown>,
      z.ZodOptional<z.ZodBoolean>
    >
  },
  z.core.$strict
>
declare const inputSchema: () => z.ZodObject<
  {
    command: z.ZodString
    description: z.ZodOptional<z.ZodString>
    timeout: z.ZodPipe<
      z.ZodTransform<unknown, unknown>,
      z.ZodOptional<z.ZodNumber>
    >
    dangerouslyDisableSandbox: z.ZodPipe<
      z.ZodTransform<unknown, unknown>,
      z.ZodOptional<z.ZodBoolean>
    >
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
export type PowerShellToolInput = z.infer<ReturnType<typeof fullInputSchema>>
declare const outputSchema: () => z.ZodObject<
  {
    stdout: z.ZodString
    stderr: z.ZodString
    interrupted: z.ZodBoolean
    returnCodeInterpretation: z.ZodOptional<z.ZodString>
    isImage: z.ZodOptional<z.ZodBoolean>
    persistedOutputPath: z.ZodOptional<z.ZodString>
    persistedOutputSize: z.ZodOptional<z.ZodNumber>
    backgroundTaskId: z.ZodOptional<z.ZodString>
    backgroundedByUser: z.ZodOptional<z.ZodBoolean>
    assistantAutoBackgrounded: z.ZodOptional<z.ZodBoolean>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Out = z.infer<OutputSchema>
import type { PowerShellProgress } from 'src/types/tools.js'
export type { PowerShellProgress } from 'src/types/tools.js'
export declare const PowerShellTool: Omit<
  {
    name: 'PowerShell'
    searchHint: string
    maxResultSizeChars: number
    strict: true
    description({ description }: Partial<PowerShellToolInput>): Promise<string>
    prompt(): Promise<string>
    isConcurrencySafe(input: PowerShellToolInput): boolean
    isSearchOrReadCommand(input: Partial<PowerShellToolInput>): {
      isSearch: boolean
      isRead: boolean
    }
    isReadOnly(input: PowerShellToolInput): boolean
    toAutoClassifierInput(input: {
      command: string
      description?: string | undefined
      timeout?: number | undefined
      dangerouslyDisableSandbox?: boolean | undefined
    }): string
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    userFacingName(): string
    getToolUseSummary(
      input: Partial<PowerShellToolInput> | undefined,
    ): string | null
    getActivityDescription(
      input: Partial<PowerShellToolInput> | undefined,
    ): string
    isEnabled(): boolean
    validateInput(input: PowerShellToolInput): Promise<ValidationResult>
    checkPermissions(
      input: PowerShellToolInput,
      context: Parameters<Tool['checkPermissions']>[1],
    ): Promise<PermissionResult>
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolUseProgressMessage: typeof renderToolUseProgressMessage
    renderToolUseQueuedMessage: typeof renderToolUseQueuedMessage
    renderToolResultMessage: typeof renderToolResultMessage
    renderToolUseErrorMessage: typeof renderToolUseErrorMessage
    mapToolResultToToolResultBlockParam(
      {
        interrupted,
        stdout,
        stderr,
        isImage,
        persistedOutputPath,
        persistedOutputSize,
        backgroundTaskId,
        backgroundedByUser,
        assistantAutoBackgrounded,
      }: Out,
      toolUseID: string,
    ): ToolResultBlockParam
    call(
      input: PowerShellToolInput,
      toolUseContext: Parameters<Tool['call']>[1],
      _canUseTool?: CanUseToolFn,
      _parentMessage?: AssistantMessage,
      onProgress?: ToolCallProgress<PowerShellProgress>,
    ): Promise<{
      data: Out
    }>
    isResultTruncated(output: Out): boolean
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
  isConcurrencySafe: (input: PowerShellToolInput) => boolean
  isReadOnly: (input: PowerShellToolInput) => boolean
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: PowerShellToolInput,
    context: Parameters<Tool['checkPermissions']>[1],
  ) => Promise<PermissionResult>
  toAutoClassifierInput: (input: {
    command: string
    description?: string | undefined
    timeout?: number | undefined
    dangerouslyDisableSandbox?: boolean | undefined
  }) => string
}
