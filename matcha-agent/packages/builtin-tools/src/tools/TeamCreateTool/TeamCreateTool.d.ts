import { z } from 'zod/v4'
import type { Tool } from 'src/Tool.js'
declare const inputSchema: () => z.ZodObject<
  {
    team_name: z.ZodString
    description: z.ZodOptional<z.ZodString>
    agent_type: z.ZodOptional<z.ZodString>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
export type Output = {
  team_name: string
  team_file_path: string
  lead_agent_id: string
}
export type Input = z.infer<InputSchema>
export declare const TeamCreateTool: Tool<InputSchema, Output>
export {}
