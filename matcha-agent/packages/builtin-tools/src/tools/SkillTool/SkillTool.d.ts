import type { Tool } from 'src/Tool.js'
import { z } from 'zod/v4'
export type { SkillToolProgress as Progress } from 'src/types/tools.js'
import type { SkillToolProgress as Progress } from 'src/types/tools.js'
export declare const inputSchema: () => z.ZodObject<
  {
    skill: z.ZodString
    args: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type InputSchema = ReturnType<typeof inputSchema>
export declare const outputSchema: () => z.ZodUnion<
  readonly [
    z.ZodObject<
      {
        success: z.ZodBoolean
        commandName: z.ZodString
        allowedTools: z.ZodOptional<z.ZodArray<z.ZodString>>
        model: z.ZodOptional<z.ZodString>
        status: z.ZodOptional<z.ZodLiteral<'inline'>>
      },
      z.core.$strip
    >,
    z.ZodObject<
      {
        success: z.ZodBoolean
        commandName: z.ZodString
        status: z.ZodLiteral<'forked'>
        agentId: z.ZodString
        result: z.ZodString
      },
      z.core.$strip
    >,
  ]
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.input<OutputSchema>
export declare const SkillTool: Tool<InputSchema, Output, Progress>
