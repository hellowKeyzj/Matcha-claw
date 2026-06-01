import { z } from 'zod/v4'
import type { Tool } from 'src/Tool.js'
declare const inputSchema: () => z.ZodObject<
  {
    name: z.ZodOptional<z.ZodString>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    worktreePath: z.ZodString
    worktreeBranch: z.ZodOptional<z.ZodString>
    message: z.ZodString
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const EnterWorktreeTool: Tool<InputSchema, Output>
export {}
