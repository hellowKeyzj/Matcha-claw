import type { ComponentType } from 'react';
import type MarkdownIt from 'markdown-it';
import { defineExtensionPoint } from '@/plugin-host/core';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionAssistantTurnSegment, SessionRenderToolCard } from '@/types/session/tool-card';
import type { AttachedFileMeta } from '@/plugins/chat/store';
import type { ToolActivityDisclosure, ToolActivityRenderer } from './tool-renderers/types';
import type { ToolSlot } from './chat-tool-groups';
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
  isStreaming: boolean;
  showThinking: boolean;
  collapseVersion: number;
  toolSlot?: ToolSlot;
  disclosure: ToolActivityDisclosure;
  latestBrowserTools?: ReadonlySet<SessionRenderToolCard>;
  sessionIdentity?: SessionIdentity;
  toolSessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  onBodyClick: () => void;
  onPreview: (item: MessageLightboxState) => void;
  onOpenFile?: (file: AttachedFileMeta) => void;
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

export const toolRenderers = defineExtensionPoint<ToolRendererContribution>('message-rendering.tools');
export const messageParts = defineExtensionPoint<MessagePartRenderer>('message-rendering.parts');
export const markdownExtensions = defineExtensionPoint<MarkdownContribution>('message-rendering.markdown');
