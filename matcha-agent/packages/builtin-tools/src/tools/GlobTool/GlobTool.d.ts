import { z } from 'zod/v4'
import type { ValidationResult } from 'src/Tool.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import {
  getToolUseSummary,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'
declare const inputSchema: () => z.ZodObject<
  {
    pattern: z.ZodString
    path: z.ZodOptional<z.ZodString>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    durationMs: z.ZodNumber
    numFiles: z.ZodNumber
    filenames: z.ZodArray<z.ZodString>
    truncated: z.ZodBoolean
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const GlobTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    description(): Promise<string>
    userFacingName: typeof userFacingName
    getToolUseSummary: typeof getToolUseSummary
    getActivityDescription(
      input:
        | Partial<{
            pattern: string
            path?: string | undefined
          }>
        | undefined,
    ): string
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    isConcurrencySafe(): true
    isReadOnly(): true
    toAutoClassifierInput(input: {
      pattern: string
      path?: string | undefined
    }): string
    isSearchOrReadCommand(): {
      isSearch: true
      isRead: false
    }
    getPath({ path }: { pattern: string; path?: string | undefined }): string
    preparePermissionMatcher({
      pattern,
    }: {
      pattern: string
      path?: string | undefined
    }): Promise<(rulePattern: string) => boolean>
    validateInput({
      path,
    }: {
      pattern: string
      path?: string | undefined
    }): Promise<ValidationResult>
    checkPermissions(
      input: {
        pattern: string
        path?: string | undefined
      },
      context: import('src/Tool.js').ToolUseContext,
    ): Promise<PermissionDecision>
    prompt(): Promise<string>
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolUseErrorMessage: typeof renderToolUseErrorMessage
    renderToolResultMessage: typeof import('../GrepTool/UI.js').renderToolResultMessage
    extractSearchText({
      filenames,
    }: {
      durationMs: number
      numFiles: number
      filenames: string[]
      truncated: boolean
    }): string
    call(
      input: {
        pattern: string
        path?: string | undefined
      },
      {
        abortController,
        getAppState,
        globLimits,
      }: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: {
        durationMs: number
        numFiles: number
        filenames: string[]
        truncated: boolean
      }
    }>
    mapToolResultToToolResultBlockParam(
      output: {
        durationMs: number
        numFiles: number
        filenames: string[]
        truncated: boolean
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
  isConcurrencySafe: () => true
  isReadOnly: () => true
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      pattern: string
      path?: string | undefined
    },
    context: import('src/Tool.js').ToolUseContext,
  ) => Promise<PermissionDecision>
  toAutoClassifierInput: (input: {
    pattern: string
    path?: string | undefined
  }) => string
}
export {}
