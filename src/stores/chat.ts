/**
 * Chat store facade.
 *
 * Runtime implementation lives in `src/stores/chat/store.ts`.
 * This file only re-exports store entry and public types.
 */
export { useChatStore } from './chat/store';

export type {
  AttachedFileMeta,
  RawMessage,
  ContentBlock,
  ChatSession,
  ChatSessionHistoryStatus,
  ToolStatus,
  ApprovalStatus,
  ApprovalDecision,
  ApprovalItem,
  TaskInboxChatBridgeState,
  ChatSessionRuntimeState,
  ChatSessionMetaState,
  ChatSessionViewportState,
  ChatSessionRecord,
  ChatViewState,
  ChatStoreBaseState,
  ChatSendAttachment,
  ChatStoreActions,
  ChatStoreState,
} from './chat/types';
