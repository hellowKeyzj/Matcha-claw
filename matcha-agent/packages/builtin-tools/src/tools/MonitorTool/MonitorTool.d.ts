import { z } from 'zod/v4'
import type {
  ToolResultBlockParam,
  ToolUseContext,
  ValidationResult,
} from 'src/Tool.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
declare const inputSchema: () => z.ZodObject<
  {
    command: z.ZodString
    description: z.ZodString
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
export type MonitorInput = z.infer<InputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    taskId: z.ZodString
    outputFile: z.ZodString
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type MonitorOutput = z.infer<OutputSchema>
export declare const MonitorTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    strict: true
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    description(): Promise<string>
    prompt(): Promise<string>
    isConcurrencySafe(): true
    isReadOnly(): false
    toAutoClassifierInput(input: MonitorInput): string
    checkPermissions(
      input: MonitorInput,
      context: ToolUseContext,
    ): Promise<PermissionResult>
    userFacingName(): string
    getActivityDescription(input: MonitorInput): string
    validateInput(input: MonitorInput): Promise<ValidationResult>
    call(
      input: MonitorInput,
      context: ToolUseContext,
    ): Promise<{
      data: {
        taskId: string
        outputFile: string
      }
    }>
    renderToolUseMessage(
      input: MonitorInput,
      {
        verbose,
      }: {
        theme: import('src/utils/theme.js').ThemeName
        verbose: boolean
        commands?: import('src/commands.js').Command[]
      },
    ): string
    mapToolResultToToolResultBlockParam(
      content: MonitorOutput,
      toolUseId: string,
    ): ToolResultBlockParam
    renderToolResultMessage(
      output: MonitorOutput,
    ): import('react/jsx-runtime').JSX.Element
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
  isReadOnly: () => false
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: MonitorInput,
    context: ToolUseContext,
  ) => Promise<PermissionResult>
  toAutoClassifierInput: (input: MonitorInput) => string
}
export {}
