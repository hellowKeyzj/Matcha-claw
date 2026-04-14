import type {
  ChatRuntimeOverlayLayerState,
  ChatSessionSnapshotLayerState,
  ChatState,
  ChatViewDerivedLayerState,
} from './types';

export type ChatSet = (
  partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
  replace?: false,
) => void;

export type ChatGet = () => ChatState;

export type ChatSnapshotLayerPatch = Partial<ChatSessionSnapshotLayerState>;
export type ChatRuntimeLayerPatch = Partial<ChatRuntimeOverlayLayerState>;
export type ChatViewLayerPatch = Partial<ChatViewDerivedLayerState>;

export interface ChatLayeredSetApi {
  setSnapshot: (patch: ChatSnapshotLayerPatch) => void;
  setRuntime: (patch: ChatRuntimeLayerPatch) => void;
  setView: (patch: ChatViewLayerPatch) => void;
}

export type SessionHistoryActions = Pick<
  ChatState,
  'loadSessions' | 'openAgentConversation' | 'switchSession' | 'newSession' | 'deleteSession' | 'cleanupEmptySession' | 'loadHistory'
>;

export type RuntimeActions = Pick<
  ChatState,
  'sendMessage' | 'abortRun' | 'handleChatEvent' | 'toggleThinking' | 'refresh' | 'clearError'
>;
