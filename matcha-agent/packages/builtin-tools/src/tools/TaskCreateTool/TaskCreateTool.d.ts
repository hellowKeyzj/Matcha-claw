import { z } from 'zod/v4'
declare const inputSchema: () => z.ZodObject<
  {
    subject: z.ZodString
    description: z.ZodString
    activeForm: z.ZodOptional<z.ZodString>
    metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    task: z.ZodObject<
      {
        id: z.ZodString
        subject: z.ZodString
      },
      z.core.$strip
    >
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const TaskCreateTool: Omit<
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
      subject: string
      description: string
      activeForm?: string | undefined
      metadata?: Record<string, unknown> | undefined
    }): string
    renderToolUseMessage(): null
    call(
      {
        subject,
        description,
        activeForm,
        metadata,
      }: {
        subject: string
        description: string
        activeForm?: string | undefined
        metadata?: Record<string, unknown> | undefined
      },
      context: import('src/Tool.js').ToolUseContext,
    ): Promise<{
      data: {
        task: {
          id: string
          subject: string
        }
      }
    }>
    mapToolResultToToolResultBlockParam(
      content: {
        task: {
          id: string
          subject: string
        }
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
    subject: string
    description: string
    activeForm?: string | undefined
    metadata?: Record<string, unknown> | undefined
  }) => string
}
export {}
