/**
 * Chat store facade.
 *
 * Runtime implementation lives in `src/stores/chat/store.ts`.
 * This file only re-exports store entry and public types.
 */
export { useChatStore } from '@/plugins/chat/store/store';
export {
  isChatSendGateOpen,
  resolveChatSendGateForPayload,
} from '@/plugins/chat/store/send-gate';
export { selectCurrentChatSendGate } from '@/plugins/chat/store/selectors';

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
  ChatSessionRuntimeErrorDetail,
  ChatSessionRuntimeNotice,
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
} from '@/plugins/chat/store/types';
