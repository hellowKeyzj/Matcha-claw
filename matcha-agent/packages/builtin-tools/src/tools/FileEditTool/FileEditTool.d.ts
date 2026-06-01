import type { ToolUseContext } from 'src/Tool.js'
import { type ToolUseDiff } from 'src/utils/gitDiff.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import { type FileEditInput, type FileEditOutput } from './types.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
  userFacingName,
} from './UI.js'
export declare const FileEditTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    strict: true
    description(): Promise<string>
    prompt(): Promise<string>
    userFacingName: typeof userFacingName
    getToolUseSummary: typeof getToolUseSummary
    getActivityDescription(
      input:
        | Partial<{
            file_path: string
            old_string: string
            new_string: string
            replace_all?: boolean | undefined
          }>
        | undefined,
    ): string
    readonly inputSchema: import('zod').ZodObject<
      {
        file_path: import('zod').ZodString
        old_string: import('zod').ZodString
        new_string: import('zod').ZodString
        replace_all: import('zod').ZodPipe<
          import('zod').ZodTransform<unknown, unknown>,
          import('zod').ZodOptional<
            import('zod').ZodDefault<import('zod').ZodBoolean>
          >
        >
      },
      import('zod/v4/core').$strict
    >
    readonly outputSchema: import('zod').ZodObject<
      {
        filePath: import('zod').ZodString
        oldString: import('zod').ZodString
        newString: import('zod').ZodString
        originalFile: import('zod').ZodString
        structuredPatch: import('zod').ZodArray<
          import('zod').ZodObject<
            {
              oldStart: import('zod').ZodNumber
              oldLines: import('zod').ZodNumber
              newStart: import('zod').ZodNumber
              newLines: import('zod').ZodNumber
              lines: import('zod').ZodArray<import('zod').ZodString>
            },
            import('zod/v4/core').$strip
          >
        >
        userModified: import('zod').ZodBoolean
        replaceAll: import('zod').ZodBoolean
        gitDiff: import('zod').ZodOptional<
          import('zod').ZodObject<
            {
              filename: import('zod').ZodString
              status: import('zod').ZodEnum<{
                added: 'added'
                modified: 'modified'
              }>
              additions: import('zod').ZodNumber
              deletions: import('zod').ZodNumber
              changes: import('zod').ZodNumber
              patch: import('zod').ZodString
              repository: import('zod').ZodOptional<
                import('zod').ZodNullable<import('zod').ZodString>
              >
            },
            import('zod/v4/core').$strip
          >
        >
      },
      import('zod/v4/core').$strip
    >
    toAutoClassifierInput(input: {
      file_path: string
      old_string: string
      new_string: string
      replace_all?: boolean | undefined
    }): string
    getPath(input: {
      file_path: string
      old_string: string
      new_string: string
      replace_all?: boolean | undefined
    }): string
    backfillObservableInput(input: Record<string, unknown>): void
    preparePermissionMatcher({
      file_path,
    }: {
      file_path: string
      old_string: string
      new_string: string
      replace_all?: boolean | undefined
    }): Promise<(pattern: string) => boolean>
    checkPermissions(
      input: {
        file_path: string
        old_string: string
        new_string: string
        replace_all?: boolean | undefined
      },
      context: ToolUseContext,
    ): Promise<PermissionDecision>
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolResultMessage: typeof renderToolResultMessage
    renderToolUseRejectedMessage: typeof renderToolUseRejectedMessage
    renderToolUseErrorMessage: typeof renderToolUseErrorMessage
    validateInput(
      input: FileEditInput,
      toolUseContext: ToolUseContext,
    ): Promise<
      | {
          result: false
          message: string
          errorCode: number
        }
      | {
          result: false
          behavior: string
          message: string
          errorCode: number
          meta?: undefined
        }
      | {
          result: true
          behavior?: undefined
          message?: undefined
          errorCode?: undefined
          meta?: undefined
        }
      | {
          result: false
          behavior: string
          message: string
          meta: {
            isFilePathAbsolute: string
            actualOldString?: undefined
          }
          errorCode: number
        }
      | {
          result: false
          behavior: string
          message: string
          meta: {
            isFilePathAbsolute: string
            actualOldString: string
          }
          errorCode: number
        }
      | {
          result: true
          meta: {
            actualOldString: string
            isFilePathAbsolute?: undefined
          }
          behavior?: undefined
          message?: undefined
          errorCode?: undefined
        }
    >
    inputsEquivalent(
      input1: {
        file_path: string
        old_string: string
        new_string: string
        replace_all?: boolean | undefined
      },
      input2: {
        file_path: string
        old_string: string
        new_string: string
        replace_all?: boolean | undefined
      },
    ): boolean
    call(
      input: FileEditInput,
      {
        readFileState,
        userModified,
        updateFileHistoryState,
        dynamicSkillDirTriggers,
      }: ToolUseContext,
      _: import('src/hooks/useCanUseTool.js').CanUseToolFn,
      parentMessage: import('@ant/model-provider').AssistantMessage,
    ): Promise<{
      data: {
        gitDiff?: ToolUseDiff | undefined
        filePath: string
        oldString: string
        newString: string
        originalFile: string
        structuredPatch: import('diff').StructuredPatchHunk[]
        userModified: boolean
        replaceAll: boolean
      }
    }>
    mapToolResultToToolResultBlockParam(
      data: FileEditOutput,
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
      old_string: string
      new_string: string
      replace_all?: boolean | undefined
    },
    context: ToolUseContext,
  ) => Promise<PermissionDecision>
  toAutoClassifierInput: (input: {
    file_path: string
    old_string: string
    new_string: string
    replace_all?: boolean | undefined
  }) => string
}
