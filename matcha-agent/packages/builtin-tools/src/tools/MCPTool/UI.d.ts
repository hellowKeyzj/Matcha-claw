import * as React from 'react'
import type { z } from 'zod/v4'
import type { ToolProgressData } from 'src/Tool.js'
import type { ProgressMessage } from 'src/types/message.js'
import type { MCPProgress } from 'src/types/tools.js'
import { type MCPToolResult } from 'src/utils/mcpValidation.js'
import type { inputSchema } from './MCPTool.js'
export declare function renderToolUseMessage(
  input: z.infer<ReturnType<typeof inputSchema>>,
  {
    verbose,
  }: {
    verbose: boolean
  },
): React.ReactNode
export declare function renderToolUseProgressMessage(
  progressMessagesForMessage: ProgressMessage<MCPProgress>[],
): React.ReactNode
export declare function renderToolResultMessage(
  output: string | MCPToolResult,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  {
    verbose,
    input,
  }: {
    verbose: boolean
    input?: unknown
  },
): React.ReactNode
/**
 * If content parses as a JSON object where every value is a scalar or a
 * small nested object, flatten it to [key, displayValue] pairs. Nested
 * objects get one-line JSON. Returns null if content doesn't qualify.
 */
export declare function tryFlattenJson(
  content: string,
): [string, string][] | null
/**
 * If content is a JSON object where one key holds a dominant string payload
 * (multiline or long) and all siblings are small scalars, unwrap it. This
 * handles the common MCP pattern of {"messages":"line1\nline2..."} where
 * pretty-printing keeps \n escaped but we want real line breaks + truncation.
 */
export declare function tryUnwrapTextPayload(content: string): {
  body: string
  extras: [string, string][]
} | null
/**
 * Detect a Slack send-message result and return a compact {channel, url} pair.
 * Matches both hosted (claude.ai Slack) and community MCP server shapes —
 * both return `message_link` in the result. The channel label prefers the
 * tool input (may be a name like "#foo" or an ID like "C09EVDAN1NK") and
 * falls back to the ID parsed from the archives URL.
 */
export declare function trySlackSendCompact(
  output: string | MCPToolResult,
  input: unknown,
): {
  channel: string
  url: string
} | null
