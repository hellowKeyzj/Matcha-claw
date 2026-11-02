import { createElement, type RefAttributes } from 'react';
import { LayoutDashboard } from 'lucide-react';
import i18n from '@/i18n';
import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { workspaceLaunchers, type WorkspacePageProps } from '@/plugins/workspace/extensions';
import { surfaceRenderers, type RuntimeContentProps } from './extensions';
import type { RuntimeContentHandle } from './content-snapshot';

const NativeRuntimeContent = lazyWithPreload<RuntimeContentProps & RefAttributes<RuntimeContentHandle>>(() =>
  import('./NativeRuntimeContent').then((module) => ({ default: module.NativeRuntimeContent })));
const BrowserRuntimeSurface = lazyWithPreload(async () => ({
  default: (await import('./BrowserRuntimeSurface')).BrowserRuntimeSurface,
}));
const BoardChatPanel = lazyWithPreload<WorkspacePageProps>(() =>
  import('./chat/BoardChatPanel').then((module) => ({ default: module.BoardChatPanel })));

export const surfacesPlugin = definePlugin({
  id: 'surfaces',
  requires: ['app-shell', 'chat', 'workspace'],
  extensionPoints: [surfaceRenderers],
  contributes: [
    contribute(workspaceLaunchers, { id: 'board', order: 30, icon: LayoutDashboard, label: 'chat:board.title', defaultLabel: 'Board',
      execute: ({ workspace }) => workspace.openPage({ id: 'board', providerId: 'surfaces:board', title: i18n.t('chat:board.title'), icon: LayoutDashboard,
        render: (props) => createElement(BoardChatPanel, props) }) }),
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
