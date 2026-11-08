import { createContext, useCallback, useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { sessionIdentitiesEqual, validateSessionIdentity, type SessionIdentity } from '@/types/desktop/runtime-address';
import { WORKSPACE_CHAT_SHOW_EVENT, WORKSPACE_PAGE_OPEN_EVENT, type WorkspacePageRequest } from './actions';
import type { WorkspaceCloseHandler, WorkspaceController, WorkspaceLayout, WorkspacePage, WorkspacePane, WorkspaceSessionPromotion } from './extensions';
import { getProviderPane } from './page-placement';

const DEFAULT_LAYOUT: WorkspaceLayout = { position: 'right', fullscreen: false };
const WorkspaceContext = createContext<WorkspaceController | null>(null);

type PageLifecycle = {
  handlers: Map<string, WorkspaceCloseHandler>;
  closing: Map<string, { controller: AbortController; promise: Promise<void> }>;
};
type PageScope = PageLifecycle & { key: string; draftId?: string };
type PageState = {
  scope: PageScope;
  pages: readonly WorkspacePage[];
  activePageId: string | null;
  activePageIds: Record<WorkspacePane, string | null>;
  pagePlacements: Record<string, WorkspacePane>;
  open: boolean;
  layout: WorkspaceLayout;
};

function emptyState(scope: PageScope): PageState {
  return { scope, pages: [], activePageId: null, activePageIds: { main: null, side: null }, pagePlacements: {}, open: false, layout: DEFAULT_LAYOUT };
}

function withoutPages(state: PageState, ids: ReadonlySet<string>): PageState {
  const pages = state.pages.filter((page) => !ids.has(page.id));
  if (pages.length === state.pages.length) return state;
  const pagePlacements = Object.fromEntries(pages.map((page) => [page.id, state.pagePlacements[page.id]]));
  const activePageIds = { ...state.activePageIds };
  for (const pane of ['main', 'side'] as const) {
    const active = activePageIds[pane];
    if (!active || !ids.has(active)) continue;
    const index = state.pages.filter((page) => state.pagePlacements[page.id] === pane).findIndex((page) => page.id === active);
    const remaining = pages.filter((page) => pagePlacements[page.id] === pane);
    activePageIds[pane] = pane === 'main' ? null : remaining[Math.min(index, remaining.length - 1)]?.id ?? null;
  }
  const activePageId = state.activePageId && !ids.has(state.activePageId) ? state.activePageId : activePageIds.main ?? activePageIds.side;
  return { ...state, pages, pagePlacements, activePageIds, activePageId };
}

function changeScope(state: PageState, scope: PageScope, sessionIdentity: SessionIdentity | null, promotion?: WorkspaceSessionPromotion): PageState {
  const isPromotion = promotion && state.scope.key === promotion.fromScopeKey
    && state.scope.draftId === promotion.draftId && scope.key === promotion.toScopeKey && scope.draftId === promotion.draftId;
  const removed = new Set(state.pages.filter((page) => page.lifetime !== 'workspace' && !(isPromotion && page.promoteWithDraft)
    && !page.retainOnSessionChange?.(sessionIdentity)).map((page) => page.id));
  return { ...withoutPages(state, removed), scope };
}

function withPageDraft(page: WorkspacePage, previous: WorkspacePage | undefined, draftId?: string): WorkspacePage {
  const workspaceDraftId = page.promoteWithDraft ? previous?.workspaceDraftId ?? draftId : undefined;
  return page.workspaceDraftId === workspaceDraftId ? page : { ...page, workspaceDraftId };
}

function activate(state: PageState, id: string, reveal = true): PageState {
  const pane = state.pagePlacements[id];
  return { ...state, activePageId: id, activePageIds: { ...state.activePageIds, [pane]: id },
    ...(reveal ? pane === 'side' ? { open: true }
      : { layout: { ...state.layout, position: state.layout.position === 'full' ? 'right' : state.layout.position, fullscreen: false, composer: undefined } } : {}) };
}

function clearLifecycle(lifecycle: PageLifecycle): void {
  for (const entry of lifecycle.closing.values()) entry.controller.abort();
  lifecycle.closing.clear();
  lifecycle.handlers.clear();
}

export function WorkspaceProvider({ scopeKey, draftId, promotion, sessionIdentity, children }: {
  scopeKey: string;
  draftId?: string;
  promotion?: WorkspaceSessionPromotion;
  sessionIdentity: SessionIdentity | null;
  children: ReactNode;
}) {
  const scope = useMemo<PageScope>(() => ({ key: scopeKey, draftId, handlers: new Map(), closing: new Map() }), [scopeKey, draftId]);
  const workspaceLifecycle = useMemo<PageLifecycle>(() => ({ handlers: new Map(), closing: new Map() }), []);
  const [stored, setState] = useState(() => emptyState(scope));
  const state = stored.scope === scope ? stored : changeScope(stored, scope, sessionIdentity, promotion);
  if (stored.scope !== scope) setState(state);
  const current = useRef(state);
  useLayoutEffect(() => { current.current = state; }, [state]);
  const alive = useRef(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearLifecycle(workspaceLifecycle);
    };
  }, [workspaceLifecycle]);
  useLayoutEffect(() => () => clearLifecycle(scope), [scope]);

  const openPage = useCallback((page: WorkspacePage, options?: { activate?: boolean }) => {
    setState((previous) => {
      if (previous.scope !== scope) return previous;
      const index = previous.pages.findIndex((entry) => entry.id === page.id);
      const pages = [...previous.pages];
      const nextPage = withPageDraft(page, pages[index], sessionIdentity ? undefined : scope.draftId);
      if (index < 0) pages.push(nextPage);
      else pages[index] = nextPage;
      const next = { ...previous, pages, pagePlacements: index < 0 ? { ...previous.pagePlacements, [page.id]: 'side' as const } : previous.pagePlacements };
      return options?.activate === false ? next : activate(next, page.id);
    });
  }, [scope, sessionIdentity]);
  const syncPages = useCallback((providerId: string, updates: readonly WorkspacePage[]) => {
    setState((previous) => {
      if (previous.scope !== scope) return previous;
      const incoming = new Map(updates.map((page) => [page.id, page]));
      const removed = new Set(previous.pages.filter((page) => page.providerId === providerId && !incoming.has(page.id)).map((page) => page.id));
      for (const id of removed) {
        scope.closing.get(id)?.controller.abort();
        workspaceLifecycle.closing.get(id)?.controller.abort();
      }
      const next = withoutPages(previous, removed);
      const pages = next.pages.map((page) => {
        if (page.providerId !== providerId) return page;
        const update = incoming.get(page.id)!;
        incoming.delete(page.id);
        return withPageDraft(update, page, sessionIdentity ? undefined : scope.draftId);
      });
      const pagePlacements = { ...next.pagePlacements };
      const selectedProviderPane = getProviderPane(previous, providerId);
      for (const page of incoming.values()) {
        pages.push(withPageDraft(page, undefined, sessionIdentity ? undefined : scope.draftId));
        pagePlacements[page.id] = selectedProviderPane;
      }
      return { ...next, pages, pagePlacements };
    });
  }, [scope, sessionIdentity, workspaceLifecycle]);
  const activatePage = useCallback((id: string, options?: { reveal?: boolean }) => {
    setState((previous) => previous.scope === scope && previous.pages.some((page) => page.id === id)
      ? activate(previous, id, options?.reveal !== false) : previous);
  }, [scope]);
  const movePage = useCallback((id: string, pane: WorkspacePane) => {
    setState((previous) => {
      if (previous.scope !== scope || !previous.pages.some((page) => page.id === id) || previous.pagePlacements[id] === pane) return previous;
      const source = previous.pagePlacements[id];
      const remaining = previous.pages.filter((page) => page.id !== id && previous.pagePlacements[page.id] === source);
      const activePageIds = { ...previous.activePageIds };
      if (activePageIds[source] === id) activePageIds[source] = source === 'main' ? null : remaining[0]?.id ?? null;
      return activate({ ...previous, pagePlacements: { ...previous.pagePlacements, [id]: pane }, activePageIds,
        layout: { ...previous.layout, position: previous.layout.position === 'full' ? 'right' : previous.layout.position, fullscreen: false, composer: undefined } }, id);
    });
  }, [scope]);
  const showChat = useCallback(() => setState((previous) => previous.scope === scope ? { ...previous,
    activePageIds: { ...previous.activePageIds, main: null }, layout: { ...previous.layout, position: previous.layout.position === 'full' ? 'right' : previous.layout.position, fullscreen: false, composer: undefined } } : previous), [scope]);
  const removePage = useCallback((id: string) => {
    if (current.current.scope !== scope) return;
    scope.closing.get(id)?.controller.abort();
    workspaceLifecycle.closing.get(id)?.controller.abort();
    setState((previous) => previous.scope === scope ? withoutPages(previous, new Set([id])) : previous);
  }, [scope, workspaceLifecycle]);
  const registerCloseHandler = useCallback((id: string, handler: WorkspaceCloseHandler) => {
    const page = current.current.scope === scope ? current.current.pages.find((entry) => entry.id === id) : undefined;
    const lifecycle = page?.lifetime === 'workspace' ? workspaceLifecycle : scope;
    if (lifecycle.handlers.has(id)) throw new Error(i18n.t('common:appFrame.closeOwnerExists'));
    lifecycle.handlers.set(id, handler);
    return () => {
      if (lifecycle.handlers.get(id) !== handler) return;
      lifecycle.handlers.delete(id);
      lifecycle.closing.get(id)?.controller.abort();
    };
  }, [scope, workspaceLifecycle]);
  const closePage = useCallback((id: string): Promise<void> => {
    const page = current.current.scope === scope ? current.current.pages.find((entry) => entry.id === id) : undefined;
    if (!page) return Promise.resolve();
    const lifecycle = page.lifetime === 'workspace' ? workspaceLifecycle : scope;
    const pending = lifecycle.closing.get(id);
    if (pending) return pending.promise;
    const isCurrent = (state: PageState) => (page.lifetime === 'workspace' || state.scope === scope)
      && state.pages.some((entry) => entry.id === id && entry.lifetime === page.lifetime);
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      const handler = lifecycle.handlers.get(id);
      if (handler) {
        setState((previous) => isCurrent(previous) ? activate(previous, id) : previous);
        if (await handler(controller.signal) !== true) return;
      }
      if (controller.signal.aborted || !alive.current || !isCurrent(current.current)) return;
      await page.onClose?.();
      if (!controller.signal.aborted && alive.current) setState((previous) => isCurrent(previous) ? withoutPages(previous, new Set([id])) : previous);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && alive.current && isCurrent(current.current)) toast.error(error instanceof Error ? error.message : i18n.t('workspace:closeFailed'));
    }).finally(() => {
      if (lifecycle.closing.get(id)?.controller === controller) lifecycle.closing.delete(id);
    });
    lifecycle.closing.set(id, { controller, promise });
    return promise;
  }, [scope, workspaceLifecycle]);
  const show = useCallback(() => setState((previous) => previous.scope === scope ? { ...previous, open: true } : previous), [scope]);
  const hide = useCallback(() => setState((previous) => previous.scope === scope ? { ...previous, open: false, layout: { ...previous.layout, fullscreen: false, composer: undefined } } : previous), [scope]);
  const setLayout = useCallback((patch: Partial<WorkspaceLayout>) => setState((previous) => previous.scope === scope ? { ...previous, layout: { ...previous.layout, ...patch } } : previous), [scope]);

  const select = useEffectEvent(() => {
    const page = current.current.pages.find((entry) => entry.id === current.current.activePageId);
    if (!page?.onSelect) return;
    void Promise.resolve().then(page.onSelect).catch((error: unknown) => {
      if (alive.current && current.current.scope === scope) toast.error(error instanceof Error ? error.message : i18n.t('workspace:openFailed'));
    });
  });
  useEffect(() => { select(); }, [scope, state.activePageId]);
  useEffect(() => {
    window.addEventListener(WORKSPACE_CHAT_SHOW_EVENT, showChat);
    return () => window.removeEventListener(WORKSPACE_CHAT_SHOW_EVENT, showChat);
  }, [showChat]);
  useEffect(() => {
    const receive = (event: Event) => {
      const request = (event as CustomEvent<WorkspacePageRequest>).detail;
      if (!sessionIdentity || !request || validateSessionIdentity(request.sessionIdentity)
        || !sessionIdentitiesEqual(sessionIdentity, request.sessionIdentity)) return;
      openPage(request.page);
    };
    window.addEventListener(WORKSPACE_PAGE_OPEN_EVENT, receive);
    return () => window.removeEventListener(WORKSPACE_PAGE_OPEN_EVENT, receive);
  }, [sessionIdentity, openPage]);

  const value = useMemo<WorkspaceController>(() => ({ scopeKey, draftId, sessionIdentity, pages: state.pages, activePageId: state.activePageId,
    activePageIds: state.activePageIds, pagePlacements: state.pagePlacements, open: state.open, layout: state.layout,
    openPage, syncPages, activatePage, movePage, showChat, removePage, closePage, show, hide, setLayout, registerCloseHandler }),
    [scopeKey, draftId, sessionIdentity, state, openPage, syncPages, activatePage, movePage, showChat, removePage, closePage, show, hide, setLayout, registerCloseHandler]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceController {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('WorkspaceProvider is missing');
  return workspace;
}
