import { z } from 'zod/v4'
import type { Tool } from 'src/Tool.js'
declare const inputSchema: () => z.ZodObject<
  {
    action: z.ZodEnum<{
      remove: 'remove'
      keep: 'keep'
    }>
    discard_changes: z.ZodOptional<z.ZodBoolean>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    action: z.ZodEnum<{
      remove: 'remove'
      keep: 'keep'
    }>
    originalCwd: z.ZodString
    worktreePath: z.ZodString
    worktreeBranch: z.ZodOptional<z.ZodString>
    tmuxSessionName: z.ZodOptional<z.ZodString>
    discardedFiles: z.ZodOptional<z.ZodNumber>
    discardedCommits: z.ZodOptional<z.ZodNumber>
    message: z.ZodString
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const ExitWorktreeTool: Tool<InputSchema, Output>
export {}
