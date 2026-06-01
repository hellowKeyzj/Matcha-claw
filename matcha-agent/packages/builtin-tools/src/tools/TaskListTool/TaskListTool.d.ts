import { z } from 'zod/v4'
declare const inputSchema: () => z.ZodObject<{}, z.core.$strict>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    tasks: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString
          subject: z.ZodString
          status: z.ZodEnum<{
            pending: 'pending'
            completed: 'completed'
            in_progress: 'in_progress'
          }>
          owner: z.ZodOptional<z.ZodString>
          blockedBy: z.ZodArray<z.ZodString>
        },
        z.core.$strip
      >
    >
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const TaskListTool: Omit<
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
    isEnabled(): boolean
    isConcurrencySafe(): true
    isReadOnly(): true
    renderToolUseMessage(): null
    call(): Promise<{
      data: {
        tasks: {
          id: string
          subject: string
          status: 'pending' | 'completed' | 'in_progress'
          owner: string | undefined
          blockedBy: string[]
        }[]
      }
    }>
    mapToolResultToToolResultBlockParam(
      content: {
        tasks: {
          id: string
          subject: string
          status: 'pending' | 'completed' | 'in_progress'
          blockedBy: string[]
          owner?: string | undefined
        }[]
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
  userFacingName: () => string
  isConcurrencySafe: () => true
  isReadOnly: () => true
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      [key: string]: unknown
    },
    _ctx?: import('src/Tool.js').ToolUseContext,
  ) => Promise<import('src/types/permissions.js').PermissionResult>
  toAutoClassifierInput: (_input?: unknown) => string
}
export {}
