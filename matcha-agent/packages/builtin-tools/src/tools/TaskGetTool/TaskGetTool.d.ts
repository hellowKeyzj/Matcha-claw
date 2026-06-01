import { z } from 'zod/v4'
declare const inputSchema: () => z.ZodObject<
  {
    taskId: z.ZodString
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    task: z.ZodNullable<
      z.ZodObject<
        {
          id: z.ZodString
          subject: z.ZodString
          description: z.ZodString
          status: z.ZodEnum<{
            pending: 'pending'
            completed: 'completed'
            in_progress: 'in_progress'
          }>
          blocks: z.ZodArray<z.ZodString>
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
export declare const TaskGetTool: Omit<
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
    toAutoClassifierInput(input: { taskId: string }): string
    renderToolUseMessage(): null
    call({ taskId }: { taskId: string }): Promise<
      | {
          data: {
            task: null
          }
        }
      | {
          data: {
            task: {
              id: string
              subject: string
              description: string
              status: 'pending' | 'completed' | 'in_progress'
              blocks: string[]
              blockedBy: string[]
            }
          }
        }
    >
    mapToolResultToToolResultBlockParam(
      content: {
        task: {
          id: string
          subject: string
          description: string
          status: 'pending' | 'completed' | 'in_progress'
          blocks: string[]
          blockedBy: string[]
        } | null
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
  toAutoClassifierInput: (input: { taskId: string }) => string
}
export {}
