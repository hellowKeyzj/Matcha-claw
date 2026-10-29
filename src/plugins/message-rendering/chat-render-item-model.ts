import type { AgentAvatarStyle } from '@/types/subagent';
import type {
  SessionAssistantTurnItem,
  SessionRenderExecutionGraphItem,
  SessionRenderSystemItem,
  SessionRenderUserMessageItem,
} from '@/types/session/render-item';

export interface ChatAssistantPresentation {
  agentId?: string;
  agentName?: string;
  avatarSeed?: string;
  avatarStyle?: AgentAvatarStyle;
}

interface ChatRenderItemBase {
  assistantPresentation: ChatAssistantPresentation | null;
  renderSignature: string;
}

export type ChatUserMessageItem = SessionRenderUserMessageItem & ChatRenderItemBase;
export type ChatAssistantTurnItem = SessionAssistantTurnItem & ChatRenderItemBase;
export type ChatExecutionGraphItem = SessionRenderExecutionGraphItem & ChatRenderItemBase;
export type ChatSystemItem = SessionRenderSystemItem & ChatRenderItemBase;

export type ChatRenderItem =
  | ChatUserMessageItem
  | ChatAssistantTurnItem
  | ChatExecutionGraphItem
  | ChatSystemItem;

export interface ChatAssistantCatalogAgent extends ChatAssistantPresentation {
  id: string;
}
