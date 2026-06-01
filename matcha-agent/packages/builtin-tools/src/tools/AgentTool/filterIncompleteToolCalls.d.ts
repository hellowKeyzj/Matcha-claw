import type { Message } from 'src/types/message.js'
/**
 * Removes invalid or orphaned tool_use/tool_result blocks while preserving
 * completed tool-call pairs. This is intentionally block-level, not
 * message-level, so completed parallel tool calls stay paired with results.
 */
export declare function filterIncompleteToolCalls(
  messages: Message[],
): Message[]
