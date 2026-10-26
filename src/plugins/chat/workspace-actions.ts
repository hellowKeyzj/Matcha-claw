import type { ReactNode } from 'react';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { ChatPanelProps } from './extensions';

export interface ChatPanelContent {
  readonly key: string;
  readonly render: (props: ChatPanelProps) => ReactNode;
}

export interface ChatPanelRequest {
  readonly id: string;
  readonly sessionIdentity: SessionIdentity;
  readonly content?: ChatPanelContent;
}

export const CHAT_PANEL_OPEN_EVENT = 'chat:open-panel';

export function openChatPanel(request: ChatPanelRequest): void {
  window.dispatchEvent(new CustomEvent<ChatPanelRequest>(CHAT_PANEL_OPEN_EVENT, { detail: request }));
}
