import { z } from 'zod/v4'
import type { Tool } from 'src/Tool.js'
declare const inputSchema: () => z.ZodObject<
  {
    wait_ms: z.ZodOptional<z.ZodNumber>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
export type Output = {
  success: boolean
  message: string
  team_name?: string
}
export type Input = z.infer<InputSchema>
export declare const TeamDeleteTool: Tool<InputSchema, Output>
export {}
