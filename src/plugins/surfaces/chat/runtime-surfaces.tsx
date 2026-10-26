import { createElement } from 'react';
import { lazyWithPreload } from '@/plugin-host/core';
import { openChatPanel } from '@/plugins/chat/workspace-actions';
import { buildSessionIdentityKey, sessionIdentitiesEqual, validateSessionIdentity, type SessionIdentity } from '@/types/desktop/runtime-address';
import { decodeOpenClawRuntimeSurfaceDescriptor, type OpenClawRuntimeSurfaceDescriptor } from '@/types/openclaw-runtime-surface';
import { RuntimeContentHost } from '../RuntimeContentHost';

const NativeSurfacePanel = lazyWithPreload(async () => ({
  default: (await import('./NativeSurfacePanel')).NativeSurfacePanel,
}));

export type ChatRuntimeSurfaceDescriptor = OpenClawRuntimeSurfaceDescriptor | {
  readonly kind: 'browser-tab';
  readonly sourceSessionIdentity: SessionIdentity;
  readonly targetId: string;
  readonly profile: string;
  readonly target: 'host' | 'node';
  readonly node?: string;
  readonly title?: string;
  readonly url?: string;
};

export function openChatRuntimeSurface(surface: ChatRuntimeSurfaceDescriptor): void {
  if (!surface) return;
  const identity = surface.kind === 'browser-tab' ? surface.sourceSessionIdentity : surface.sessionIdentity;
  if (surface.kind === 'browser-tab' ? validateSessionIdentity(identity) : !decodeOpenClawRuntimeSurfaceDescriptor(surface)) return;
  const identityKey = buildSessionIdentityKey(identity);
  const key = surface.kind === 'browser-tab' ? identityKey
    : JSON.stringify([identityKey, surface.kind, surface.kind === 'mcp-app' ? surface.viewId : surface.documentId]);
  openChatPanel({
    id: 'runtime',
    sessionIdentity: identity,
    content: {
      key,
      render: ({ sessionIdentity, onSendMessage, onOpenLink }) => {
        if (!sessionIdentity || !sessionIdentitiesEqual(identity, sessionIdentity)) return null;
        return surface.kind === 'browser-tab'
          ? createElement(RuntimeContentHost, { key, source: { kind: 'browser-tab', surface, sessionIdentity: identity } })
          : createElement(NativeSurfacePanel, { key, surface, onSendMessage, onOpenLink });
      },
    },
  });
}
