import type { ComponentType, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { SessionIdentity } from '@/types/desktop/runtime-address';

export interface WorkspaceLayout {
  readonly position: 'left' | 'right' | 'top' | 'full';
  readonly fullscreen: boolean;
  readonly composer?: 'dock';
}

export type WorkspaceCloseHandler = (signal: AbortSignal) => boolean | Promise<boolean>;

export interface WorkspaceSessionPromotion {
  readonly draftId: string;
  readonly fromScopeKey: string;
  readonly toScopeKey: string;
}

export interface WorkspacePageProps {
  sessionIdentity?: SessionIdentity;
  workspaceDraftId?: string;
  visible: boolean;
  width: number;
  layout: WorkspaceLayout;
  onLayoutChange: (layout: Partial<WorkspaceLayout>) => void;
  onClose: () => void;
  registerCloseHandler: (handler: WorkspaceCloseHandler) => () => void;
  onSendMessage?: (text: string) => void | Promise<void>;
  onOpenLink?: (url: string) => void | Promise<void>;
}

export interface WorkspacePage {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  readonly badge?: 'preview';
  readonly render: (props: WorkspacePageProps) => ReactNode;
  readonly mount?: 'active';
  readonly lifetime?: 'workspace';
  readonly promoteWithDraft?: boolean;
  readonly workspaceDraftId?: string;
  readonly onSelect?: () => void | Promise<void>;
  readonly onClose?: () => void | Promise<void>;
}

export interface WorkspaceController {
  readonly scopeKey: string;
  readonly draftId?: string;
  readonly sessionIdentity: SessionIdentity | null;
  readonly pages: readonly WorkspacePage[];
  readonly activePageId: string | null;
  readonly open: boolean;
  readonly layout: WorkspaceLayout;
  openPage(page: WorkspacePage, options?: { activate?: boolean }): void;
  syncPages(providerId: string, pages: readonly WorkspacePage[]): void;
  activatePage(id: string, options?: { reveal?: boolean }): void;
  removePage(id: string): void;
  closePage(id: string): Promise<void>;
  show(): void;
  hide(): void;
  setLayout(patch: Partial<WorkspaceLayout>): void;
  registerCloseHandler(id: string, handler: WorkspaceCloseHandler): () => void;
}

export interface WorkspaceLauncherContext {
  readonly sessionIdentity: SessionIdentity | null;
  readonly scopeKey: string;
  readonly workspace: WorkspaceController;
}

export interface WorkspaceLauncher {
  readonly id: string;
  readonly order: number;
  readonly label: string;
  readonly defaultLabel?: string;
  readonly icon: LucideIcon;
  readonly execute: (context: WorkspaceLauncherContext) => void | Promise<void>;
}

export interface WorkspacePanelProps {
  readonly visible: boolean;
  readonly width: number;
  readonly mode: 'docked' | 'overlay';
  readonly onHide: () => void;
  readonly onSendMessage?: (text: string) => void | Promise<void>;
  readonly onOpenLink?: (url: string) => void | Promise<void>;
}

export const workspaceLaunchers = defineExtensionPoint<WorkspaceLauncher>('workspace.launchers');
export const workspacePanels = defineExtensionPoint<{ readonly id: string; readonly component: ComponentType<WorkspacePanelProps> }>('workspace.panels');
