import { z } from 'zod/v4'
import type { ToolUseContext } from 'src/Tool.js'
import { type ToolUseDiff } from 'src/utils/gitDiff.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import {
  getToolUseSummary,
  isResultTruncated,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'
declare const inputSchema: () => z.ZodObject<
  {
    file_path: z.ZodString
    content: z.ZodString
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    type: z.ZodEnum<{
      create: 'create'
      update: 'update'
    }>
    filePath: z.ZodString
    content: z.ZodString
    structuredPatch: z.ZodArray<
      z.ZodObject<
        {
          oldStart: z.ZodNumber
          oldLines: z.ZodNumber
          newStart: z.ZodNumber
          newLines: z.ZodNumber
          lines: z.ZodArray<z.ZodString>
        },
        z.core.$strip
      >
    >
    originalFile: z.ZodNullable<z.ZodString>
    gitDiff: z.ZodOptional<
      z.ZodObject<
        {
          filename: z.ZodString
          status: z.ZodEnum<{
            added: 'added'
            modified: 'modified'
          }>
          additions: z.ZodNumber
          deletions: z.ZodNumber
          changes: z.ZodNumber
          patch: z.ZodString
          repository: z.ZodOptional<z.ZodNullable<z.ZodString>>
        },
        z.core.$strip
      >
    >
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export type FileWriteToolInput = InputSchema
export declare const FileWriteTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    strict: true
    description(): Promise<string>
    userFacingName: typeof userFacingName
    getToolUseSummary: typeof getToolUseSummary
    getActivityDescription(
      input:
        | Partial<{
            file_path: string
            content: string
          }>
        | undefined,
    ): string
    prompt(): Promise<string>
    renderToolUseMessage: typeof renderToolUseMessage
    isResultTruncated: typeof isResultTruncated
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    toAutoClassifierInput(input: { file_path: string; content: string }): string
    getPath(input: { file_path: string; content: string }): string
    backfillObservableInput(input: Record<string, unknown>): void
    preparePermissionMatcher({
      file_path,
    }: {
      file_path: string
      content: string
    }): Promise<(pattern: string) => boolean>
    checkPermissions(
      input: {
        file_path: string
        content: string
      },
      context: ToolUseContext,
    ): Promise<PermissionDecision>
    renderToolUseRejectedMessage: typeof renderToolUseRejectedMessage
    renderToolUseErrorMessage: typeof renderToolUseErrorMessage
    renderToolResultMessage: typeof renderToolResultMessage
    extractSearchText(): string
    validateInput(
      {
        file_path,
        content,
      }: {
        file_path: string
        content: string
      },
      toolUseContext: ToolUseContext,
    ): Promise<
      | {
          result: false
          message: string
          errorCode: number
        }
      | {
          result: true
          message?: undefined
          errorCode?: undefined
        }
    >
    call(
      {
        file_path,
        content,
      }: {
        file_path: string
        content: string
      },
      {
        readFileState,
        updateFileHistoryState,
        dynamicSkillDirTriggers,
      }: ToolUseContext,
      _: import('src/hooks/useCanUseTool.js').CanUseToolFn,
      parentMessage: import('@ant/model-provider').AssistantMessage,
    ): Promise<
      | {
          data: {
            gitDiff?: ToolUseDiff | undefined
            type: 'update'
            filePath: string
            content: string
            structuredPatch: import('diff').StructuredPatchHunk[]
            originalFile: string
          }
        }
      | {
          data: {
            gitDiff?: ToolUseDiff | undefined
            type: 'create'
            filePath: string
            content: string
            structuredPatch: never[]
            originalFile: null
          }
        }
    >
    mapToolResultToToolResultBlockParam(
      {
        filePath,
        type,
      }: {
        type: 'create' | 'update'
        filePath: string
        content: string
        structuredPatch: {
          oldStart: number
          oldLines: number
          newStart: number
          newLines: number
          lines: string[]
        }[]
        originalFile: string | null
        gitDiff?:
          | {
              filename: string
              status: 'added' | 'modified'
              additions: number
              deletions: number
              changes: number
              patch: string
              repository?: string | null | undefined
            }
          | undefined
      },
      toolUseID: string,
    ): {
      tool_use_id: string
      type: 'tool_result'
      content: string
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
  userFacingName: typeof userFacingName
  isConcurrencySafe: (_input?: unknown) => boolean
  isReadOnly: (_input?: unknown) => boolean
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      file_path: string
      content: string
    },
    context: ToolUseContext,
  ) => Promise<PermissionDecision>
  toAutoClassifierInput: (input: {
    file_path: string
    content: string
  }) => string
}
export {}
