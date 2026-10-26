import { createElement, type RefAttributes } from 'react';
import { LayoutDashboard } from 'lucide-react';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { chatSidePanels, type ChatPanelProps } from '@/plugins/chat/extensions';
import { surfaceRenderers, type RuntimeContentProps } from './extensions';
import type { RuntimeContentHandle } from './content-snapshot';

const NativeRuntimeContent = lazyWithPreload<RuntimeContentProps & RefAttributes<RuntimeContentHandle>>(() =>
  import('./NativeRuntimeContent').then((module) => ({ default: module.NativeRuntimeContent })));
const BrowserRuntimeSurface = lazyWithPreload(async () => ({
  default: (await import('./BrowserRuntimeSurface')).BrowserRuntimeSurface,
}));
const BoardChatPanel = lazyWithPreload<ChatPanelProps>(() =>
  import('./chat/BoardChatPanel').then((module) => ({ default: module.BoardChatPanel })));

export const surfacesPlugin = definePlugin({
  id: 'surfaces',
  requires: ['app-shell', 'chat'],
  extensionPoints: [surfaceRenderers],
  contributes: [
    contribute(chatSidePanels, { id: 'board', order: 30, icon: LayoutDashboard, label: 'board.title', defaultLabel: 'Board', component: BoardChatPanel }),
    contribute(surfaceRenderers, {
      kind: 'canvas',
      priority: -1,
      render: (props) => props.source.kind === 'canvas'
        ? createElement(NativeRuntimeContent, { ...props, source: props.source }) : null,
    }),
    contribute(surfaceRenderers, {
      kind: 'mcp-app',
      priority: -1,
      render: (props) => props.source.kind === 'mcp-app'
        ? createElement(NativeRuntimeContent, { ...props, source: props.source }) : null,
    }),
    contribute(surfaceRenderers, {
      kind: 'browser-tab',
      priority: -1,
      render: ({ source }) => source.kind === 'browser-tab'
        ? createElement(BrowserRuntimeSurface, { surface: source.surface, sessionIdentity: source.sessionIdentity }) : null,
    }),
    contribute(surfaceRenderers, {
      kind: 'board',
      priority: -1,
      render: (props) => props.source.kind === 'board'
        ? createElement(NativeRuntimeContent, { ...props, source: props.source }) : null,
    }),
  ],
});
