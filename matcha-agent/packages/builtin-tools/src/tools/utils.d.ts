import type {
  AssistantMessage,
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'
/**
 * Tags user messages with a sourceToolUseID so they stay transient until the tool resolves.
 * This prevents the "is running" message from being duplicated in the UI.
 */
export declare function tagMessagesWithToolUseID(
  messages: (UserMessage | AttachmentMessage | SystemMessage)[],
  toolUseID: string | undefined,
): (UserMessage | AttachmentMessage | SystemMessage)[]
/**
 * Extracts the tool use ID from a parent message for a given tool name.
 */
export declare function getToolUseIDFromParentMessage(
  parentMessage: AssistantMessage,
  toolName: string,
): string | undefined
