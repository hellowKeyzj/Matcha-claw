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
  ToolStatus,
  ApprovalStatus,
  ApprovalDecision,
  ApprovalItem,
  TaskInboxChatBridgeState,
  SessionRuntimeSnapshot,
  ChatSessionSnapshotLayerState,
  ChatRuntimeOverlayLayerState,
  ChatViewDerivedLayerState,
  ChatLayeredState,
  ChatSendAttachment,
  ChatStoreActions,
  ChatStoreState,
  ChatState,
} from './chat/types';
