import { z } from 'zod/v4'
declare const inputSchema: () => z.ZodObject<
  {
    todos: z.ZodArray<
      z.ZodObject<
        {
          content: z.ZodString
          status: z.ZodEnum<{
            pending: 'pending'
            completed: 'completed'
            in_progress: 'in_progress'
          }>
          activeForm: z.ZodString
        },
        z.core.$strip
      >
    >
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    oldTodos: z.ZodArray<
      z.ZodObject<
        {
          content: z.ZodString
          status: z.ZodEnum<{
            pending: 'pending'
            completed: 'completed'
            in_progress: 'in_progress'
          }>
          activeForm: z.ZodString
        },
        z.core.$strip
      >
    >
    newTodos: z.ZodArray<
      z.ZodObject<
        {
          content: z.ZodString
          status: z.ZodEnum<{
            pending: 'pending'
            completed: 'completed'
            in_progress: 'in_progress'
          }>
          activeForm: z.ZodString
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
export declare const TodoWriteTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    strict: true
    description(): Promise<string>
    prompt(): Promise<string>
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    userFacingName(): string
    shouldDefer: true
    isEnabled(): boolean
    toAutoClassifierInput(input: {
      todos: {
        content: string
        status: 'pending' | 'completed' | 'in_progress'
        activeForm: string
      }[]
    }): string
    checkPermissions(input: {
      todos: {
        content: string
        status: 'pending' | 'completed' | 'in_progress'
        activeForm: string
      }[]
    }): Promise<{
      behavior: 'allow'
      updatedInput: {
        todos: {
          content: string
          status: 'pending' | 'completed' | 'in_progress'
          activeForm: string
        }[]
      }
    }>
    renderToolUseMessage(): null
    call(
      {
        todos,
      }: {
        todos: {
          content: string
          status: 'pending' | 'completed' | 'in_progress'
          activeForm: string
        }[]
      },
      context: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: {
        oldTodos: {
          content: string
          status: 'pending' | 'completed' | 'in_progress'
          activeForm: string
        }[]
        newTodos: {
          content: string
          status: 'pending' | 'completed' | 'in_progress'
          activeForm: string
        }[]
        verificationNudgeNeeded: boolean
      }
    }>
    mapToolResultToToolResultBlockParam(
      {
        verificationNudgeNeeded,
      }: {
        oldTodos: {
          content: string
          status: 'pending' | 'completed' | 'in_progress'
          activeForm: string
        }[]
        newTodos: {
          content: string
          status: 'pending' | 'completed' | 'in_progress'
          activeForm: string
        }[]
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
  isConcurrencySafe: (_input?: unknown) => boolean
  isReadOnly: (_input?: unknown) => boolean
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (input: {
    todos: {
      content: string
      status: 'pending' | 'completed' | 'in_progress'
      activeForm: string
    }[]
  }) => Promise<{
    behavior: 'allow'
    updatedInput: {
      todos: {
        content: string
        status: 'pending' | 'completed' | 'in_progress'
        activeForm: string
      }[]
    }
  }>
  toAutoClassifierInput: (input: {
    todos: {
      content: string
      status: 'pending' | 'completed' | 'in_progress'
      activeForm: string
    }[]
  }) => string
}
export {}
