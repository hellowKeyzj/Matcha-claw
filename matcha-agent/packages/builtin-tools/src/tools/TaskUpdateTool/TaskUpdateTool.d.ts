import { z } from 'zod/v4'
declare const inputSchema: () => z.ZodObject<
  {
    taskId: z.ZodString
    subject: z.ZodOptional<z.ZodString>
    description: z.ZodOptional<z.ZodString>
    activeForm: z.ZodOptional<z.ZodString>
    status: z.ZodOptional<
      z.ZodUnion<
        [
          z.ZodEnum<{
            pending: 'pending'
            completed: 'completed'
            in_progress: 'in_progress'
          }>,
          z.ZodLiteral<'deleted'>,
        ]
      >
    >
    addBlocks: z.ZodOptional<z.ZodArray<z.ZodString>>
    addBlockedBy: z.ZodOptional<z.ZodArray<z.ZodString>>
    owner: z.ZodOptional<z.ZodString>
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    success: z.ZodBoolean
    taskId: z.ZodString
    updatedFields: z.ZodArray<z.ZodString>
    error: z.ZodOptional<z.ZodString>
    statusChange: z.ZodOptional<
      z.ZodObject<
        {
          from: z.ZodString
          to: z.ZodString
        },
        z.core.$strip
      >
    >
    verificationNudgeNeeded: z.ZodOptional<z.ZodBoolean>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const TaskUpdateTool: Omit<
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
    toAutoClassifierInput(input: {
      taskId: string
      subject?: string | undefined
      description?: string | undefined
      activeForm?: string | undefined
      status?: 'pending' | 'completed' | 'deleted' | 'in_progress' | undefined
      addBlocks?: string[] | undefined
      addBlockedBy?: string[] | undefined
      owner?: string | undefined
      metadata?: Record<string, unknown> | undefined
    }): string
    renderToolUseMessage(): null
    call(
      {
        taskId,
        subject,
        description,
        activeForm,
        status,
        owner,
        addBlocks,
        addBlockedBy,
        metadata,
      }: {
        taskId: string
        subject?: string | undefined
        description?: string | undefined
        activeForm?: string | undefined
        status?: 'pending' | 'completed' | 'deleted' | 'in_progress' | undefined
        addBlocks?: string[] | undefined
        addBlockedBy?: string[] | undefined
        owner?: string | undefined
        metadata?: Record<string, unknown> | undefined
      },
      context: import('src/Tool.js').ToolUseContext,
    ): Promise<
      | {
          data: {
            success: false
            taskId: string
            updatedFields: never[]
            error: string
            statusChange?: undefined
            verificationNudgeNeeded?: undefined
          }
        }
      | {
          data: {
            success: boolean
            taskId: string
            updatedFields: string[]
            error: string | undefined
            statusChange:
              | {
                  from: 'pending' | 'completed' | 'in_progress'
                  to: string
                }
              | undefined
            verificationNudgeNeeded?: undefined
          }
        }
      | {
          data: {
            success: true
            taskId: string
            updatedFields: string[]
            statusChange:
              | {
                  from: 'pending' | 'completed' | 'in_progress'
                  to: 'pending' | 'completed' | 'in_progress'
                }
              | undefined
            verificationNudgeNeeded: boolean
            error?: undefined
          }
        }
    >
    mapToolResultToToolResultBlockParam(
      content: {
        success: boolean
        taskId: string
        updatedFields: string[]
        error?: string | undefined
        statusChange?:
          | {
              from: string
              to: string
            }
          | undefined
        verificationNudgeNeeded?: boolean | undefined
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
  isReadOnly: (_input?: unknown) => boolean
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      [key: string]: unknown
    },
    _ctx?: import('src/Tool.js').ToolUseContext,
  ) => Promise<import('src/types/permissions.js').PermissionResult>
  toAutoClassifierInput: (input: {
    taskId: string
    subject?: string | undefined
    description?: string | undefined
    activeForm?: string | undefined
    status?: 'pending' | 'completed' | 'deleted' | 'in_progress' | undefined
    addBlocks?: string[] | undefined
    addBlockedBy?: string[] | undefined
    owner?: string | undefined
    metadata?: Record<string, unknown> | undefined
  }) => string
}
export {}
