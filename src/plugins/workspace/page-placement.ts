import type { WorkspaceController, WorkspacePane } from './extensions';

export function isWorkspacePageRevealed(
  state: Pick<WorkspaceController, 'activePageIds' | 'pagePlacements' | 'open' | 'layout'>,
  pageId: string,
): boolean {
  const pane = state.pagePlacements[pageId];
  if (pane === 'side') return state.open && state.activePageIds.side === pageId;
  return pane === 'main' && state.activePageIds.main === pageId
    && !(state.open && (state.layout.fullscreen || state.layout.position === 'full'));
}

export function getProviderPane(
  state: Pick<WorkspaceController, 'pages' | 'pagePlacements' | 'activePageId' | 'activePageIds'>,
  providerId: string,
): WorkspacePane {
  const focusedProviderPage = state.pages.find((page) => page.id === state.activePageId && page.providerId === providerId);
  return (focusedProviderPage ? state.pagePlacements[focusedProviderPage.id]
    : (['main', 'side'] as const).find((pane) => state.pages.some((page) => page.id === state.activePageIds[pane] && page.providerId === providerId))) ?? 'side';
}
