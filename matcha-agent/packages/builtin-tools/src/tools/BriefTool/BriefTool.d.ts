import { z } from 'zod/v4'
import type { ValidationResult } from 'src/Tool.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'
declare const inputSchema: () => z.ZodObject<
  {
    message: z.ZodString
    attachments: z.ZodOptional<z.ZodArray<z.ZodString>>
    status: z.ZodEnum<{
      normal: 'normal'
      proactive: 'proactive'
    }>
  },
  z.core.$strict
>
type InputSchema = ReturnType<typeof inputSchema>
declare const outputSchema: () => z.ZodObject<
  {
    message: z.ZodString
    attachments: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            path: z.ZodString
            size: z.ZodNumber
            isImage: z.ZodBoolean
            file_uuid: z.ZodOptional<z.ZodString>
          },
          z.core.$strip
        >
      >
    >
    sentAt: z.ZodOptional<z.ZodString>
  },
  z.core.$strip
>
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>
/**
 * Entitlement check — is the user ALLOWED to use Brief? Combines build-time
 * flags with runtime GB gate + assistant-mode passthrough. No opt-in check
 * here — this decides whether opt-in should be HONORED, not whether the user
 * has opted in.
 *
 * Build-time OR-gated on KAIROS || KAIROS_BRIEF (same pattern as
 * PROACTIVE || KAIROS): assistant mode depends on Brief, so KAIROS alone
 * must bundle it. KAIROS_BRIEF lets Brief ship independently.
 *
 * Use this to decide whether `--brief` / `defaultView: 'chat'` / `--tools`
 * listing should be honored. Use `isBriefEnabled()` to decide whether the
 * tool is actually active in the current session.
 *
 * CLAUDE_CODE_BRIEF env var force-grants entitlement for dev/testing —
 * bypasses the GB gate so you can test without being enrolled. Still
 * requires an opt-in action to activate (--brief, defaultView, etc.), but
 * the env var alone also sets userMsgOptIn via maybeActivateBrief().
 */
export declare function isBriefEntitled(): boolean
/**
 * Unified activation gate for the Brief tool. Governs model-facing behavior
 * as a unit: tool availability, system prompt section (getBriefSection),
 * tool-deferral bypass (isDeferredTool), and todo-nag suppression.
 *
 * Activation requires explicit opt-in (userMsgOptIn) set by one of:
 *   - `--brief` CLI flag (maybeActivateBrief in main.tsx)
 *   - `defaultView: 'chat'` in settings (main.tsx init)
 *   - `/brief` slash command (brief.ts)
 *   - `/config` defaultView picker (Config.tsx)
 *   - SendUserMessage in `--tools` / SDK `tools` option (main.tsx)
 *   - CLAUDE_CODE_BRIEF env var (maybeActivateBrief — dev/testing bypass)
 * Assistant mode (kairosActive) bypasses opt-in since its system prompt
 * hard-codes "you MUST use SendUserMessage" (systemPrompt.md:14).
 *
 * The GB gate is re-checked here as a kill-switch AND — flipping
 * tengu_kairos_brief off mid-session disables the tool on the next 5-min
 * refresh even for opted-in sessions. No opt-in → always false regardless
 * of GB (this is the fix for "brief defaults on for enrolled ants").
 *
 * Called from Tool.isEnabled() (lazy, post-init), never at module scope.
 * getKairosActive() and getUserMsgOptIn() are set in main.tsx before any
 * caller reaches here.
 */
export declare function isBriefEnabled(): boolean
export declare const BriefTool: Omit<
  {
    name: string
    aliases: string[]
    searchHint: string
    maxResultSizeChars: number
    userFacingName(): string
    readonly inputSchema: InputSchema
    readonly outputSchema: OutputSchema
    isEnabled(): boolean
    isConcurrencySafe(): true
    isReadOnly(): true
    toAutoClassifierInput(input: {
      message: string
      status: 'normal' | 'proactive'
      attachments?: string[] | undefined
    }): string
    validateInput(
      {
        attachments,
      }: {
        message: string
        status: 'normal' | 'proactive'
        attachments?: string[] | undefined
      },
      _context: import('src/Tool.js').ToolUseContext,
    ): Promise<ValidationResult>
    description(): Promise<string>
    prompt(): Promise<string>
    mapToolResultToToolResultBlockParam(
      output: {
        message: string
        attachments?:
          | {
              path: string
              size: number
              isImage: boolean
              file_uuid?: string | undefined
            }[]
          | undefined
        sentAt?: string | undefined
      },
      toolUseID: string,
    ): {
      tool_use_id: string
      type: 'tool_result'
      content: string
    }
    renderToolUseMessage: typeof renderToolUseMessage
    renderToolResultMessage: typeof renderToolResultMessage
    call(
      {
        message,
        attachments,
        status,
      }: {
        message: string
        status: 'normal' | 'proactive'
        attachments?: string[] | undefined
      },
      context: import('src/Tool.js').ToolUseContext,
    ): Promise<
      | {
          data: {
            message: string
            sentAt: string
            attachments?: undefined
          }
        }
      | {
          data: {
            message: string
            attachments: import('./attachments.js').ResolvedAttachment[]
            sentAt: string
          }
        }
    >
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
  isReadOnly: () => true
  isDestructive: (_input?: unknown) => boolean
  checkPermissions: (
    input: {
      [key: string]: unknown
    },
    _ctx?: import('src/Tool.js').ToolUseContext,
  ) => Promise<import('src/types/permissions.js').PermissionResult>
  toAutoClassifierInput: (input: {
    message: string
    status: 'normal' | 'proactive'
    attachments?: string[] | undefined
  }) => string
}
export {}
