import type { ComponentType, ReactNode, RefObject } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionRunPhase } from '@/types/session/runtime-state';
import type { SessionOwnership } from '@/types/desktop/session-ownership';
import type { ChatPanelContent, ChatPanelRequest } from './workspace-actions';

export interface ChatComposerActionState {
  readonly t: TFunction<'chat'>;
  readonly sessionIdentity: SessionIdentity | null;
  readonly disabled: boolean;
  readonly actionsDisabled: boolean;
  readonly goalSupported: boolean;
  readonly goalDisabled: boolean;
  readonly skillManagerLabel: string | undefined;
  readonly skillManagerOpen: boolean;
  readonly quickPhraseOpen: boolean;
}

export interface ChatComposerActionContext extends ChatComposerActionState {
  readonly attachFiles: () => Promise<void>;
  readonly openPanel: (id: string) => void;
  readonly toggleQuickPhrase: () => void;
  readonly openSkillManager: () => void;
  readonly startGoal: () => void;
}

export interface ChatComposerPanelProps {
  sessionIdentity: SessionIdentity | null;
  activeRunId: string | null;
  runPhase: SessionRunPhase | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}

export interface ChatComposerAction {
  readonly id: string;
  readonly order: number;
  readonly icon: LucideIcon;
  readonly control: string;
  readonly testId?: string;
  readonly separatorAfter?: boolean;
  readonly panel?: ComponentType<ChatComposerPanelProps>;
  readonly resolve: (context: ChatComposerActionState) => {
    label: string;
    hidden?: boolean;
    disabled?: boolean;
    dialogExpanded?: boolean;
  };
  readonly execute: (context: ChatComposerActionContext) => void | Promise<void>;
}

export interface ChatComposerContentProps {
  sessionIdentity: SessionIdentity | null;
  ownership: SessionOwnership | null;
  enabled: boolean;
  runActive: boolean;
  imageGenerationActive: boolean;
  approvalWaiting: boolean;
  canSend: boolean;
  focusComposer: () => void;
  children: (content: ReactNode) => ReactNode;
}

export interface ChatWorkspaceContentProps {
  isActive: boolean;
  enabled: boolean;
  visible: boolean;
  sessionIdentity: SessionIdentity | null;
  ownership: SessionOwnership | null;
  openPanel: (request: ChatPanelRequest) => void;
}

export interface ChatContentContribution<P> {
  readonly id: string;
  readonly order: number;
  readonly component: ComponentType<P>;
}

export interface ChatPanelLayout {
  readonly position: 'left' | 'right' | 'top' | 'full';
  readonly fullscreen: boolean;
  readonly composer?: 'dock';
}

export interface ChatPanelProps {
  sessionIdentity?: SessionIdentity;
  width: number;
  content: ChatPanelContent | null;
  layout: ChatPanelLayout;
  onLayoutChange: (layout: Partial<ChatPanelLayout>) => void;
  onClose: () => void;
  registerCloseHandler?: (handler: (signal: AbortSignal) => boolean | Promise<boolean>) => () => void;
  onSendMessage?: (text: string) => void | Promise<void>;
  onOpenLink?: (url: string) => void | Promise<void>;
}

export interface ChatSidePanelContribution {
  readonly id: string;
  readonly order: number;
  readonly keepMounted?: boolean;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly defaultLabel?: string;
  readonly title?: string;
  readonly component: ComponentType<ChatPanelProps>;
}

export interface ChatComposerContribution {
  readonly id: string;
  readonly order: number;
  readonly load: () => Promise<ComponentType<ChatComposerContentProps>>;
}

export const chatComposerActions = defineExtensionPoint<ChatComposerAction>('chat.composer.actions');
export const chatComposerContent = defineExtensionPoint<ChatComposerContribution>('chat.composer.content');
export const chatWorkspaceContent = defineExtensionPoint<ChatContentContribution<ChatWorkspaceContentProps>>('chat.workspace.content');
export const chatSidePanels = defineExtensionPoint<ChatSidePanelContribution>('chat.workspace.side-panels');
