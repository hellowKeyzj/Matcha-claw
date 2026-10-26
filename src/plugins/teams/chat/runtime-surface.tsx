import { createElement, lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { openChatPanel, type ChatPanelRequest } from '@/plugins/chat/workspace-actions';
import { buildSessionIdentityKey, type SessionIdentity } from '@/types/desktop/runtime-address';

export interface TeamGraphSurface {
  readonly kind: 'team-graph';
  readonly sourceSessionIdentity: SessionIdentity;
  readonly teamId: string;
  readonly runId: string;
  readonly title?: string;
}

const teamGraphRuntimePanel = lazy(() => import('./TeamGraphRuntimePanel').then((module) => ({ default: module.TeamGraphRuntimePanel })));

export function buildTeamGraphPanelRequest(surface: TeamGraphSurface): ChatPanelRequest | null {
  if (typeof surface.teamId !== 'string' || !surface.teamId.trim()
    || typeof surface.runId !== 'string' || !surface.runId.trim()) return null;
  return {
    id: 'runtime',
    sessionIdentity: surface.sourceSessionIdentity,
    content: {
      key: JSON.stringify([buildSessionIdentityKey(surface.sourceSessionIdentity), surface.teamId, surface.runId]),
      render: () => <Suspense fallback={<div role="status" className="flex min-h-0 flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}>
        {createElement(teamGraphRuntimePanel, { surface })}
      </Suspense>,
    },
  };
}

export function openTeamGraph(surface: TeamGraphSurface): void {
  const request = buildTeamGraphPanelRequest(surface);
  if (request) openChatPanel(request);
}
