import { z } from 'zod/v4'
import type { ToolResultBlockParam } from 'src/Tool.js'
declare const inputSchema: z.ZodObject<
  {
    workflow: z.ZodString
    args: z.ZodOptional<z.ZodString>
    action: z.ZodOptional<
      z.ZodEnum<{
        status: 'status'
        cancel: 'cancel'
        list: 'list'
        start: 'start'
        advance: 'advance'
      }>
    >
    run_id: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type Input = typeof inputSchema
type WorkflowInput = z.infer<Input>
type WorkflowOutput = {
  output: string
}
export declare const WorkflowTool: Omit<
  {
    name: string
    searchHint: string
    maxResultSizeChars: number
    strict: true
    inputSchema: z.ZodObject<
      {
        workflow: z.ZodString
        args: z.ZodOptional<z.ZodString>
        action: z.ZodOptional<
          z.ZodEnum<{
            status: 'status'
            cancel: 'cancel'
            list: 'list'
            start: 'start'
            advance: 'advance'
          }>
        >
        run_id: z.ZodOptional<z.ZodString>
      },
      z.core.$strip
    >
    description(): Promise<string>
    prompt(): Promise<string>
    userFacingName(): string
    isReadOnly(input: any): boolean
    isEnabled(): true
    renderToolUseMessage(input: Partial<WorkflowInput>): string
    mapToolResultToToolResultBlockParam(
      content: WorkflowOutput,
      toolUseID: string,
    ): ToolResultBlockParam
    call(input: WorkflowInput): Promise<{
      data: WorkflowOutput
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
  isEnabled: () => true
  userFacingName: () => string
  isConcurrencySafe: (_input?: unknown) => boolean
  isReadOnly: (input: any) => boolean
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
