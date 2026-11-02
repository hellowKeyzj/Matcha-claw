import { createContext, useCallback, useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { sessionIdentitiesEqual, validateSessionIdentity, type SessionIdentity } from '@/types/desktop/runtime-address';
import { WORKSPACE_PAGE_OPEN_EVENT, type WorkspacePageRequest } from './actions';
import type { WorkspaceCloseHandler, WorkspaceController, WorkspaceLayout, WorkspacePage } from './extensions';

const DEFAULT_LAYOUT: WorkspaceLayout = { position: 'right', fullscreen: false };
const WorkspaceContext = createContext<WorkspaceController | null>(null);

type PageLifecycle = {
  handlers: Map<string, WorkspaceCloseHandler>;
  closing: Map<string, { controller: AbortController; promise: Promise<void> }>;
};
type PageScope = PageLifecycle & { key: string };
type PageState = { scope: PageScope; pages: readonly WorkspacePage[]; activePageId: string | null; open: boolean; layout: WorkspaceLayout };

function emptyState(scope: PageScope): PageState {
  return { scope, pages: [], activePageId: null, open: false, layout: DEFAULT_LAYOUT };
}

function changeScope(state: PageState, scope: PageScope): PageState {
  const pages = state.pages.filter((page) => page.lifetime === 'workspace');
  if (!pages.length) return emptyState(scope);
  const activePageId = pages.some((page) => page.id === state.activePageId) ? state.activePageId : pages[0].id;
  return { ...state, scope, pages, activePageId };
}

function clearLifecycle(lifecycle: PageLifecycle): void {
  for (const entry of lifecycle.closing.values()) entry.controller.abort();
  lifecycle.closing.clear();
  lifecycle.handlers.clear();
}

function withoutPages(state: PageState, ids: ReadonlySet<string>): PageState {
  const pages = state.pages.filter((page) => !ids.has(page.id));
  if (pages.length === state.pages.length) return state;
  const index = state.pages.findIndex((page) => page.id === state.activePageId);
  const activePageId = state.activePageId && !ids.has(state.activePageId) ? state.activePageId
    : pages[Math.min(Math.max(0, index), pages.length - 1)]?.id ?? null;
  return { ...state, pages, activePageId };
}

export function WorkspaceProvider({ scopeKey, sessionIdentity, children }: {
  scopeKey: string;
  sessionIdentity: SessionIdentity | null;
  children: ReactNode;
}) {
  const scope = useMemo<PageScope>(() => ({ key: scopeKey, handlers: new Map(), closing: new Map() }), [scopeKey]);
  const workspaceLifecycle = useMemo<PageLifecycle>(() => ({ handlers: new Map(), closing: new Map() }), []);
  const [stored, setState] = useState(() => emptyState(scope));
  const state = stored.scope === scope ? stored : changeScope(stored, scope);
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
      if (index < 0) pages.push(page);
      else pages[index] = page;
      return { ...previous, pages, ...(options?.activate === false ? {} : { activePageId: page.id, open: true }) };
    });
  }, [scope]);
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
        return update;
      });
      pages.push(...incoming.values());
      return { ...next, pages };
    });
  }, [scope, workspaceLifecycle]);
  const activatePage = useCallback((id: string, options?: { reveal?: boolean }) => {
    setState((previous) => previous.scope === scope && previous.pages.some((page) => page.id === id)
      ? { ...previous, activePageId: id, ...(options?.reveal === false ? {} : { open: true }) } : previous);
  }, [scope]);
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
        setState((previous) => isCurrent(previous) ? { ...previous, activePageId: id, open: true } : previous);
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
    const receive = (event: Event) => {
      const request = (event as CustomEvent<WorkspacePageRequest>).detail;
      if (!sessionIdentity || !request || validateSessionIdentity(request.sessionIdentity)
        || !sessionIdentitiesEqual(sessionIdentity, request.sessionIdentity)) return;
      openPage(request.page);
    };
    window.addEventListener(WORKSPACE_PAGE_OPEN_EVENT, receive);
    return () => window.removeEventListener(WORKSPACE_PAGE_OPEN_EVENT, receive);
  }, [sessionIdentity, openPage]);

  const value = useMemo<WorkspaceController>(() => ({ scopeKey, sessionIdentity, pages: state.pages, activePageId: state.activePageId, open: state.open, layout: state.layout, openPage, syncPages, activatePage, removePage, closePage, show, hide, setLayout, registerCloseHandler }),
    [scopeKey, sessionIdentity, state, openPage, syncPages, activatePage, removePage, closePage, show, hide, setLayout, registerCloseHandler]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceController {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error('WorkspaceProvider is missing');
  return workspace;
}
