/**
 * Chat store facade.
 *
 * Runtime implementation lives in `src/stores/chat/store.ts`.
 * This file only re-exports store entry and public types.
 */
export { useChatStore } from './chat/store';
export {
  isChatSendGateOpen,
  resolveChatSendGateForPayload,
} from './chat/send-gate';
export { selectCurrentChatSendGate } from './chat/selectors';

export type {
  AttachedFileMeta,
  ContentBlock,
  ChatSession,
  ChatSessionHistoryStatus,
  ToolStatus,
  ApprovalStatus,
  ApprovalDecision,
  ApprovalItem,
  TaskChatBridgeState,
  ChatRuntimeErrorDismissMarker,
  ChatSessionRuntimeState,
  ChatSessionMetaState,
  ChatSessionViewportState,
  ChatSessionRecord,
  ChatViewState,
  ChatStoreBaseState,
  ChatSendAttachment,
  ChatSendGate,
  ChatSendRejectReason,
  ChatSendResult,
  ChatStoreActions,
  ChatStoreState,
} from './chat/types';
