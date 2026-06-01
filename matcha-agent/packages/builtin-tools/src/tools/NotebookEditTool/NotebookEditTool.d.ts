import { z } from 'zod/v4'
import { type ToolUseContext } from 'src/Tool.js'
import type { PermissionDecision } from 'src/utils/permissions/PermissionResult.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'
export declare const inputSchema: () => z.ZodObject<
  {
    notebook_path: z.ZodString
    cell_id: z.ZodOptional<z.ZodString>
    new_source: z.ZodString
    cell_type: z.ZodOptional<
      z.ZodEnum<{
        code: 'code'
        markdown: 'markdown'
      }>
    >
    edit_mode: z.ZodOptional<
      z.ZodEnum<{
        replace: 'replace'
        delete: 'delete'
        insert: 'insert'
      }>
    >
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
export declare const outputSchema: () => z.ZodObject<
  {
    new_source: z.ZodString
    cell_id: z.ZodOptional<z.ZodString>
    cell_type: z.ZodEnum<{
      code: 'code'
      markdown: 'markdown'
    }>
    language: z.ZodString
    edit_mode: z.ZodString
    error: z.ZodOptional<z.ZodString>
    notebook_path: z.ZodString
    original_file: z.ZodString
    updated_file: z.ZodString
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const NotebookEditTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    shouldDefer: true
    description(): Promise<string>
    prompt(): Promise<string>
    userFacingName(): string
    getToolUseSummary: typeof getToolUseSummary
    getActivityDescription(
      input:
        | Partial<{
            notebook_path: string
            new_source: string
            cell_id?: string | undefined
            cell_type?: 'code' | 'markdown' | undefined
            edit_mode?: 'replace' | 'delete' | 'insert' | undefined
          }>
        | undefined,
    ): string
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    toAutoClassifierInput(input: {
      notebook_path: string
      new_source: string
      cell_id?: string | undefined
      cell_type?: 'code' | 'markdown' | undefined
      edit_mode?: 'replace' | 'delete' | 'insert' | undefined
    }): string
    getPath(input: {
      notebook_path: string
      new_source: string
      cell_id?: string | undefined
      cell_type?: 'code' | 'markdown' | undefined
      edit_mode?: 'replace' | 'delete' | 'insert' | undefined
    }): string
    checkPermissions(
      input: {
        notebook_path: string
        new_source: string
        cell_id?: string | undefined
        cell_type?: 'code' | 'markdown' | undefined
        edit_mode?: 'replace' | 'delete' | 'insert' | undefined
      },
      context: ToolUseContext,
    ): Promise<PermissionDecision>
    mapToolResultToToolResultBlockParam(
      {
        cell_id,
        edit_mode,
        new_source,
        error,
      }: {
        new_source: string
        cell_type: 'code' | 'markdown'
        language: string
        edit_mode: string
        notebook_path: string
        original_file: string
        updated_file: string
        cell_id?: string | undefined
        error?: string | undefined
      },
      toolUseID: string,
    ):
      | {
          tool_use_id: string
          type: 'tool_result'
          content: string
          is_error: true
        }
      | {
          tool_use_id: string
          type: 'tool_result'
          content: string
          is_error?: undefined
        }
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolUseRejectedMessage: typeof renderToolUseRejectedMessage
    renderToolUseErrorMessage: typeof renderToolUseErrorMessage
    renderToolResultMessage: typeof renderToolResultMessage
    validateInput(
      {
        notebook_path,
        cell_type,
        cell_id,
        edit_mode,
      }: {
        notebook_path: string
        new_source: string
        cell_id?: string | undefined
        cell_type?: 'code' | 'markdown' | undefined
        edit_mode?: 'replace' | 'delete' | 'insert' | undefined
      },
      toolUseContext: ToolUseContext,
    ): Promise<
      | {
          result: true
          message?: undefined
          errorCode?: undefined
        }
      | {
          result: false
          message: string
          errorCode: number
        }
    >
    call(
      {
        notebook_path,
        new_source,
        cell_id,
        cell_type,
        edit_mode: originalEditMode,
      }: {
        notebook_path: string
        new_source: string
        cell_id?: string | undefined
        cell_type?: 'code' | 'markdown' | undefined
        edit_mode?: 'replace' | 'delete' | 'insert' | undefined
      },
      { readFileState, updateFileHistoryState }: ToolUseContext,
      _: import('src/hooks/useCanUseTool.js').CanUseToolFn,
      parentMessage: import('@ant/model-provider').AssistantMessage,
    ): Promise<{
      data: {
        new_source: string
        cell_type: 'code' | 'markdown'
        language: string
        edit_mode: string
        error: string
        cell_id: string | undefined
        notebook_path: string
        original_file: string
        updated_file: string
      }
    }>
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
  isConcurrencySafe: (_input?: unknown) => boolean
  isReadOnly: (_input?: unknown) => boolean
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      notebook_path: string
      new_source: string
      cell_id?: string | undefined
      cell_type?: 'code' | 'markdown' | undefined
      edit_mode?: 'replace' | 'delete' | 'insert' | undefined
    },
    context: ToolUseContext,
  ) => Promise<PermissionDecision>
  toAutoClassifierInput: (input: {
    notebook_path: string
    new_source: string
    cell_id?: string | undefined
    cell_type?: 'code' | 'markdown' | undefined
    edit_mode?: 'replace' | 'delete' | 'insert' | undefined
  }) => string
}
export {}
