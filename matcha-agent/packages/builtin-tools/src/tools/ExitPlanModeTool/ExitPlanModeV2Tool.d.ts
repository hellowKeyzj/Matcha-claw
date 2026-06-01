import { z } from 'zod/v4'
import { type Tool } from 'src/Tool.js'
/**
 * Schema for prompt-based permission requests.
 * Used by Claude to request semantic permissions when exiting plan mode.
 */
declare const allowedPromptSchema: () => z.ZodObject<
  {
    tool: z.ZodEnum<{
      Bash: 'Bash'
    }>
    prompt: z.ZodString
  },
  z.core.$strip
>
export type AllowedPrompt = z.infer<ReturnType<typeof allowedPromptSchema>>
declare const inputSchema: () => z.ZodObject<
  {
    allowedPrompts: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            tool: z.ZodEnum<{
              Bash: 'Bash'
            }>
            prompt: z.ZodString
          },
          z.core.$strip
        >
      >
    >
  },
  z.core.$loose
>
type InputSchema = ReturnType<typeof inputSchema>
/**
 * SDK-facing input schema - includes fields injected by normalizeToolInput.
 * The internal inputSchema doesn't have these fields because plan is read from disk,
 * but the SDK/hooks see the normalized version with plan and file path included.
 */
export declare const _sdkInputSchema: () => z.ZodObject<
  {
    allowedPrompts: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            tool: z.ZodEnum<{
              Bash: 'Bash'
            }>
            prompt: z.ZodString
          },
          z.core.$strip
        >
      >
    >
    plan: z.ZodOptional<z.ZodString>
    planFilePath: z.ZodOptional<z.ZodString>
  },
  z.core.$loose
>
export declare const outputSchema: () => z.ZodObject<
  {
    plan: z.ZodNullable<z.ZodString>
    isAgent: z.ZodBoolean
    filePath: z.ZodOptional<z.ZodString>
    hasTaskTool: z.ZodOptional<z.ZodBoolean>
    planWasEdited: z.ZodOptional<z.ZodBoolean>
    awaitingLeaderApproval: z.ZodOptional<z.ZodBoolean>
    requestId: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
export declare const ExitPlanModeV2Tool: Tool<InputSchema, Output>
export {}
