import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import { z } from 'zod/v4'
import type {
  ToolCallProgress,
  ToolUseContext,
  ValidationResult,
} from 'src/Tool.js'
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
 * Checks if a bash command is a search or read operation.
 * Used to determine if the command should be collapsed in the UI.
 * Returns an object indicating whether it's a search or read operation.
 *
 * For pipelines (e.g., `cat file | bq`), ALL parts must be search/read commands
 * for the whole command to be considered collapsible.
 *
 * Semantic-neutral commands (echo, printf, true, false, :) are skipped in any
 * position, as they're pure output/status commands that don't affect the read/search
 * nature of the pipeline (e.g. `ls dir && echo "---" && ls dir2` is still a read).
 */
export declare function isSearchOrReadBashCommand(command: string): {
  isSearch: boolean
  isRead: boolean
  isList: boolean
}
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
    _simulatedSedEdit: z.ZodOptional<
      z.ZodObject<
        {
          filePath: z.ZodString
          newContent: z.ZodString
        },
        z.core.$strip
      >
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
export type BashToolInput = z.infer<ReturnType<typeof fullInputSchema>>
declare const outputSchema: () => z.ZodObject<
  {
    stdout: z.ZodString
    stderr: z.ZodString
    rawOutputPath: z.ZodOptional<z.ZodString>
    interrupted: z.ZodBoolean
    isImage: z.ZodOptional<z.ZodBoolean>
    backgroundTaskId: z.ZodOptional<z.ZodString>
    backgroundedByUser: z.ZodOptional<z.ZodBoolean>
    assistantAutoBackgrounded: z.ZodOptional<z.ZodBoolean>
    dangerouslyDisableSandbox: z.ZodOptional<z.ZodBoolean>
    returnCodeInterpretation: z.ZodOptional<z.ZodString>
    noOutputExpected: z.ZodOptional<z.ZodBoolean>
    structuredContent: z.ZodOptional<z.ZodArray<z.ZodAny>>
    persistedOutputPath: z.ZodOptional<z.ZodString>
    persistedOutputSize: z.ZodOptional<z.ZodNumber>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Out = z.infer<OutputSchema>
export type { BashProgress } from 'src/types/tools.js'
import type { BashProgress } from 'src/types/tools.js'
/**
 * Detect standalone or leading `sleep N` patterns that should use Monitor
 * instead. Catches `sleep 5`, `sleep 5 && check`, `sleep 5; check` — but
 * not sleep inside pipelines, subshells, or scripts (those are fine).
 */
export declare function detectBlockedSleepPattern(
  command: string,
): string | null
/**
 * Checks if a command contains tools that shouldn't run in sandbox
 * This includes:
 * - Dynamic config-based disabled commands and substrings (tengu_sandbox_disabled_commands)
 * - User-configured commands from settings.json (sandbox.excludedCommands)
 *
 * User-configured commands support the same pattern syntax as permission rules:
 * - Exact matches: "npm run lint"
 * - Prefix patterns: "npm run test:*"
 */
type SimulatedSedEditResult = {
  data: Out
}
export declare const BashTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    strict: true
    description({
      description,
    }: {
      command: string
      description?: string | undefined
      timeout?: number | undefined
      dangerouslyDisableSandbox?: boolean | undefined
    }): Promise<string>
    prompt(): Promise<string>
    isConcurrencySafe(input: {
      command: string
      description?: string | undefined
      timeout?: number | undefined
      dangerouslyDisableSandbox?: boolean | undefined
    }): boolean
    isReadOnly(input: {
      command: string
      description?: string | undefined
      timeout?: number | undefined
      dangerouslyDisableSandbox?: boolean | undefined
    }): boolean
    toAutoClassifierInput(input: {
      command: string
      description?: string | undefined
      timeout?: number | undefined
      dangerouslyDisableSandbox?: boolean | undefined
    }): string
    preparePermissionMatcher({
      command,
    }: {
      command: string
      description?: string | undefined
      timeout?: number | undefined
      dangerouslyDisableSandbox?: boolean | undefined
    }): Promise<(pattern: string) => boolean>
    isSearchOrReadCommand(input: {
      command: string
      description?: string | undefined
      timeout?: number | undefined
      dangerouslyDisableSandbox?: boolean | undefined
    }): {
      isSearch: boolean
      isRead: boolean
      isList: boolean
    }
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    userFacingName(
      input:
        | Partial<{
            command: string
            description?: string | undefined
            timeout?: number | undefined
            dangerouslyDisableSandbox?: boolean | undefined
          }>
        | undefined,
    ): string
    getToolUseSummary(
      input:
        | Partial<{
            command: string
            description?: string | undefined
            timeout?: number | undefined
            dangerouslyDisableSandbox?: boolean | undefined
          }>
        | undefined,
    ): string | null
    getActivityDescription(
      input:
        | Partial<{
            command: string
            description?: string | undefined
            timeout?: number | undefined
            dangerouslyDisableSandbox?: boolean | undefined
          }>
        | undefined,
    ): string
    validateInput(input: BashToolInput): Promise<ValidationResult>
    checkPermissions(
      input: {
        command: string
        description?: string | undefined
        timeout?: number | undefined
        dangerouslyDisableSandbox?: boolean | undefined
      },
      context: ToolUseContext,
    ): Promise<PermissionResult>
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolUseProgressMessage: typeof renderToolUseProgressMessage
    renderToolUseQueuedMessage: typeof renderToolUseQueuedMessage
    renderToolResultMessage: typeof renderToolResultMessage
    extractSearchText({
      stdout,
      stderr,
    }: {
      stdout: string
      stderr: string
      interrupted: boolean
      rawOutputPath?: string | undefined
      isImage?: boolean | undefined
      backgroundTaskId?: string | undefined
      backgroundedByUser?: boolean | undefined
      assistantAutoBackgrounded?: boolean | undefined
      dangerouslyDisableSandbox?: boolean | undefined
      returnCodeInterpretation?: string | undefined
      noOutputExpected?: boolean | undefined
      structuredContent?: any[] | undefined
      persistedOutputPath?: string | undefined
      persistedOutputSize?: number | undefined
    }): string
    mapToolResultToToolResultBlockParam(
      {
        interrupted,
        stdout,
        stderr,
        isImage,
        backgroundTaskId,
        backgroundedByUser,
        assistantAutoBackgrounded,
        structuredContent,
        persistedOutputPath,
        persistedOutputSize,
      }: {
        stdout: string
        stderr: string
        interrupted: boolean
        rawOutputPath?: string | undefined
        isImage?: boolean | undefined
        backgroundTaskId?: string | undefined
        backgroundedByUser?: boolean | undefined
        assistantAutoBackgrounded?: boolean | undefined
        dangerouslyDisableSandbox?: boolean | undefined
        returnCodeInterpretation?: string | undefined
        noOutputExpected?: boolean | undefined
        structuredContent?: any[] | undefined
        persistedOutputPath?: string | undefined
        persistedOutputSize?: number | undefined
      },
      toolUseID: string,
    ): ToolResultBlockParam
    call(
      input: BashToolInput,
      toolUseContext: ToolUseContext,
      _canUseTool?: CanUseToolFn,
      parentMessage?: AssistantMessage,
      onProgress?: ToolCallProgress<BashProgress>,
    ): Promise<SimulatedSedEditResult>
    renderToolUseErrorMessage: typeof renderToolUseErrorMessage
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
  userFacingName: (
    input:
      | Partial<{
          command: string
          description?: string | undefined
          timeout?: number | undefined
          dangerouslyDisableSandbox?: boolean | undefined
        }>
      | undefined,
  ) => string
  isConcurrencySafe: (input: {
    command: string
    description?: string | undefined
    timeout?: number | undefined
    dangerouslyDisableSandbox?: boolean | undefined
  }) => boolean
  isReadOnly: (input: {
    command: string
    description?: string | undefined
    timeout?: number | undefined
    dangerouslyDisableSandbox?: boolean | undefined
  }) => boolean
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      command: string
      description?: string | undefined
      timeout?: number | undefined
      dangerouslyDisableSandbox?: boolean | undefined
    },
    context: ToolUseContext,
  ) => Promise<PermissionResult>
  toAutoClassifierInput: (input: {
    command: string
    description?: string | undefined
    timeout?: number | undefined
    dangerouslyDisableSandbox?: boolean | undefined
  }) => string
}
