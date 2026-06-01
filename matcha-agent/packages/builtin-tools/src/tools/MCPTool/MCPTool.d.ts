import { z } from 'zod/v4'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
export declare const inputSchema: () => z.ZodObject<{}, z.core.$loose>
type InputSchema = ReturnType<typeof inputSchema>
export declare const outputSchema: () => z.ZodString
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export type { MCPProgress } from 'src/types/tools.js'
export declare const MCPTool: Omit<
  {
    isMcp: true
    isOpenWorld(): false
    name: string
    maxResultSizeChars: number
    description(): Promise<string>
    prompt(): Promise<string>
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    call(): Promise<{
      data: string
    }>
    checkPermissions(): Promise<PermissionResult>
    renderToolUseMessage: typeof renderToolUseMessage
    userFacingName: () => string
    renderToolUseProgressMessage: typeof renderToolUseProgressMessage
    renderToolResultMessage: typeof renderToolResultMessage
    isResultTruncated(output: Output): boolean
    mapToolResultToToolResultBlockParam(
      content: string,
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
  userFacingName: () => string
  isConcurrencySafe: (_input?: unknown) => boolean
  isReadOnly: (_input?: unknown) => boolean
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: () => Promise<PermissionResult>
  toAutoClassifierInput: (_input?: unknown) => string
}
