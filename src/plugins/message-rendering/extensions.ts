import type { ComponentType } from 'react';
import type MarkdownIt from 'markdown-it';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionAssistantTurnSegment, SessionRenderToolCard } from '@/types/session/tool-card';
import type { AttachedFileMeta } from '@/plugins/message-rendering/attachments';
import type { ToolActivityDisclosure, ToolActivityRenderer } from './tool-renderers/types';
import type { ToolSlot } from './tool-groups';
import type { MessageLightboxState } from './chat-message-parts';

export interface MarkdownExtension {
  readonly id: string;
  readonly install: (renderer: MarkdownIt) => void;
}

export interface MessagePartProps {
  segment: SessionAssistantTurnSegment;
  itemKey: string;
  createdAt?: number;
  renderText?: string;
  attachedFiles?: ReadonlyArray<AttachedFileMeta>;
  isStreaming: boolean;
  showThinking: boolean;
  collapseVersion: number;
  toolSlot?: ToolSlot;
  disclosure: ToolActivityDisclosure;
  latestBrowserTools?: ReadonlySet<SessionRenderToolCard>;
  sessionIdentity?: SessionIdentity;
  toolSessionIdentity?: SessionIdentity;
  toolIsImmutable?: boolean;
  endpointSessionId?: string | null;
  onBodyClick: () => void;
  onPreview: (item: MessageLightboxState) => void;
  onOpenFile?: (file: AttachedFileMeta) => boolean | void;
  onOpenToolSurface: (tool: SessionRenderToolCard, identity: SessionIdentity) => void;
  onRuntimeSendMessage?: (text: string) => void | Promise<void>;
  onRuntimeOpenLink?: (url: string) => void | Promise<void>;
}

export interface MessagePartRenderer {
  readonly kind: SessionAssistantTurnSegment['kind'];
  readonly priority?: number;
  readonly component: ComponentType<MessagePartProps>;
}

export function resolveMessagePartRenderer(
  kind: SessionAssistantTurnSegment['kind'],
  renderers: readonly MessagePartRenderer[],
): MessagePartRenderer | undefined {
  let selected: MessagePartRenderer | undefined;
  for (const renderer of renderers) {
    if (renderer.kind === kind && (!selected || (renderer.priority ?? 0) > (selected.priority ?? 0))) {
      selected = renderer;
    }
  }
  return selected;
}

export interface ToolRendererContribution {
  readonly id: string;
  readonly priority?: number;
  readonly load: () => Promise<ToolActivityRenderer>;
}

export interface MarkdownContribution {
  readonly id: string;
  readonly load: () => Promise<MarkdownExtension>;
}

export interface ImagePreviewActionProps {
  readonly src: string;
  readonly fileName: string;
  readonly sessionIdentity?: SessionIdentity;
  readonly onClose: () => void;
}

export interface ImagePreviewAction {
  readonly id: string;
  readonly component: ComponentType<ImagePreviewActionProps>;
}

export interface MessageContextTag {
  readonly pluginId: string;
  readonly digest: string;
  readonly tag: string;
}

export const messageContextTags = defineExtensionPoint<MessageContextTag>('message-rendering.context-tags');
export const imagePreviewActions = defineExtensionPoint<ImagePreviewAction>('message-rendering.image-preview-actions');
export const toolRenderers = defineExtensionPoint<ToolRendererContribution>('message-rendering.tools');
export const messageParts = defineExtensionPoint<MessagePartRenderer>('message-rendering.parts');
export const markdownExtensions = defineExtensionPoint<MarkdownContribution>('message-rendering.markdown');
