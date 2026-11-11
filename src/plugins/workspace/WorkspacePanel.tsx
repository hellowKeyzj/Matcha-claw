import { memo, Suspense, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { ChevronDown, Maximize2, MessageSquare, Minimize2, PanelRightClose, Plus, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { WorkspaceMenu } from './WorkspaceMenu';
import { cn } from '@/lib/utils';
import { useContributions } from '@/plugin-host/react';
import { useWorkspace } from './context';
import { workspaceLaunchers, type WorkspaceCloseHandler, type WorkspaceController, type WorkspaceLauncher, type WorkspacePage, type WorkspacePageProps, type WorkspacePanelProps, type WorkspacePane } from './extensions';

const MENU_PAGE_SIZE = 40;
const iconButtonClass = 'h-8 w-8 shrink-0 rounded-md motion-reduce:transition-none';

type PaneTabs = { pages: readonly WorkspacePage[]; tabs: readonly WorkspacePage[]; start: number };

function getPaneTabs(pages: readonly WorkspacePage[], activeId: string | null): PaneTabs {
  const activeIndex = Math.max(0, pages.findIndex((page) => page.id === activeId));
  const start = pages.length > 50 ? Math.min(Math.max(0, activeIndex - 20), pages.length - MENU_PAGE_SIZE) : 0;
  return { pages, tabs: pages.length > 50 ? pages.slice(start, start + MENU_PAGE_SIZE) : pages, start };
}

const LauncherItem = memo(function LauncherItem({ launcher, workspace }: {
  launcher: WorkspaceLauncher; workspace: WorkspaceController;
}) {
  const { t } = useTranslation('workspace');
  const execute = useCallback(() => {
    void Promise.resolve().then(() => launcher.execute({ workspace, sessionIdentity: workspace.sessionIdentity, scopeKey: workspace.scopeKey }))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : t('openFailed')));
  }, [launcher, workspace, t]);
  const Icon = launcher.icon;
  const label = t(launcher.label, { defaultValue: launcher.defaultLabel });
  const content = <><Icon aria-hidden={true} className="h-4 w-4 shrink-0" /><span className="truncate">{label}</span></>;
  return <Button type="button" variant="ghost" onClick={execute} title={label} className="h-9 w-full justify-start rounded-lg px-3 motion-reduce:transition-none">{content}</Button>;
});

const LauncherMenu = memo(function LauncherMenu({ launchers, workspace }: { launchers: readonly WorkspaceLauncher[]; workspace: WorkspaceController }) {
  const { t } = useTranslation('workspace');
  return <WorkspaceMenu label={t('addPage')} align="start" scopeKey={workspace.scopeKey}
    items={launchers.map((launcher) => ({ id: launcher.id, icon: launcher.icon, label: t(launcher.label, { defaultValue: launcher.defaultLabel }) }))}
    onSelect={(id) => launchers.find((launcher) => launcher.id === id)?.execute({ workspace, sessionIdentity: workspace.sessionIdentity, scopeKey: workspace.scopeKey })}>
    <Plus aria-hidden="true" className="h-4 w-4" />
  </WorkspaceMenu>;
});

const PageOverflow = memo(function PageOverflow({ pages, activeId, onSelect, scopeKey }: { pages: readonly WorkspacePage[]; activeId: string | null; onSelect: (id: string) => void; scopeKey: string }) {
  const { t } = useTranslation('workspace');
  return <WorkspaceMenu label={t('allTabs', { count: pages.length })} align="end" scopeKey={scopeKey}
    items={pages.map((page) => ({ id: page.id, label: page.title, icon: page.icon, selected: page.id === activeId, badge: page.badge === 'preview' ? t('preview') : undefined }))}
    onSelect={onSelect}>
    <ChevronDown aria-hidden="true" className="h-4 w-4" />
  </WorkspaceMenu>;
});

const WorkspaceTab = memo(function WorkspaceTab({ page, active, tabbable, tabId, panelId, onSelect, onClose, onDragStart, onDragEnd }: {
  page: WorkspacePage; active: boolean; tabbable: boolean; tabId: string; panelId: string;
  onSelect: (id: string) => void; onClose: (id: string) => Promise<void>;
  onDragStart: (event: DragEvent<HTMLDivElement>, pageId: string) => void; onDragEnd: () => void;
}) {
  const { t } = useTranslation('workspace');
  const select = useCallback(() => onSelect(page.id), [onSelect, page.id]);
  const keyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); }
  }, [select]);
  const close = useCallback((event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); void onClose(page.id); }, [onClose, page.id]);
  const stopKey = useCallback((event: KeyboardEvent<HTMLButtonElement>) => event.stopPropagation(), []);
  const Icon = page.icon;
  return <div id={tabId} role="tab" aria-controls={panelId} aria-selected={active} aria-description={t('dragTabHint')} tabIndex={tabbable ? 0 : -1}
    data-page-id={page.id} title={`${page.title} · ${t('dragTabHint')}`} onClick={select} onKeyDown={keyDown}
    draggable onDragStart={(event) => onDragStart(event, page.id)} onDragEnd={onDragEnd}
    className={cn('no-drag group flex h-9 min-w-[112px] max-w-[240px] shrink-0 cursor-grab select-none items-center gap-2 rounded-lg px-2.5 text-[13px] active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground')}>
    {Icon && <Icon aria-hidden={true} className="h-3.5 w-3.5 shrink-0" />}
    <span className="min-w-0 flex-1 truncate">{page.title}</span>
    {page.badge === 'preview' && <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground">{t('preview')}</span>}
    <Button type="button" variant="ghost" size="icon" tabIndex={active ? 0 : -1} onClick={close} onKeyDown={stopKey}
      aria-label={t('closePage', { title: page.title })} title={t('closePage', { title: page.title })} className="h-6 w-6 shrink-0 rounded-md motion-reduce:transition-none">
      <X aria-hidden="true" className="h-3 w-3" />
    </Button>
  </div>;
});

function PageContent({ page, pageProps }: { page: WorkspacePage; pageProps: WorkspacePageProps }) {
  return page.render(pageProps);
}

const PageSlot = memo(function PageSlot({ page, active, style, tabId, panelId, closePage, registerCloseHandler, ...props }: Omit<WorkspacePageProps, 'onClose' | 'registerCloseHandler'> & {
  page: WorkspacePage; active: boolean; style: CSSProperties; tabId?: string; panelId: string;
  closePage: WorkspaceController['closePage']; registerCloseHandler: WorkspaceController['registerCloseHandler'];
}) {
  const { t } = useTranslation('workspace');
  const boundary = useRef<ErrorBoundary>(null);
  const closeHandlerRegistration = useRef(registerCloseHandler);
  useLayoutEffect(() => { closeHandlerRegistration.current = registerCloseHandler; }, [registerCloseHandler]);
  const onClose = useCallback(() => { void closePage(page.id); }, [closePage, page.id]);
  const register = useCallback((handler: WorkspaceCloseHandler) => closeHandlerRegistration.current(page.id, handler), [page.id]);
  const retry = useCallback(() => boundary.current?.handleReset(), []);
  return <div id={panelId} role="tabpanel" aria-labelledby={tabId} aria-label={tabId ? undefined : page.title} hidden={!active} inert={!props.visible}
    style={{ ...style, display: active ? undefined : 'none' }}
    className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-card">
    {(page.mount !== 'active' || active) && <ErrorBoundary ref={boundary} fallback={
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm">
        <p>{t('pageFailed')}</p>
        <Button type="button" variant="outline" size="sm" onClick={retry} className="motion-reduce:transition-none">
          <RefreshCw aria-hidden="true" className="h-4 w-4" />{t('retry')}
        </Button>
      </div>
    }>
      <Suspense fallback={<div role="status" className="flex h-full flex-col justify-center gap-3 p-6 text-sm text-muted-foreground">
        <div aria-hidden="true" className="h-3 w-1/3 rounded bg-muted" />
        <div aria-hidden="true" className="h-3 w-2/3 rounded bg-muted" />
        <span>{t('loading')}</span>
      </div>}>
        <PageContent page={page} pageProps={{ ...props, onClose, registerCloseHandler: register }} />
      </Suspense>
    </ErrorBoundary>}
  </div>;
});

function PaneHeader({ pane, pageTabs: { pages, tabs, start }, workspace, launchers, visible, style, actions, onHide, id, onDragStart, onDragEnd, pendingPageFocusRef }: {
  pane: WorkspacePane; pageTabs: PaneTabs; workspace: WorkspaceController;
  launchers: readonly WorkspaceLauncher[]; visible: boolean; style: CSSProperties; actions?: ReactNode; onHide: () => void; id: string;
  onDragStart: (event: DragEvent<HTMLDivElement>, pageId: string) => void; onDragEnd: () => void;
  pendingPageFocusRef: RefObject<string | null>;
}) {
  const { t } = useTranslation('workspace');
  const { activePageIds, activatePage, closePage, movePage, showChat, layout, setLayout } = workspace;
  const activeId = activePageIds[pane];
  const pendingFocus = useRef<string | null>(null);
  const select = useCallback((pageId: string) => activatePage(pageId), [activatePage]);
  const tabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return;
    if (event.altKey && event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const pageId = event.target.dataset.pageId;
      if (pageId) {
        event.preventDefault();
        pendingPageFocusRef.current = pageId;
        movePage(pageId, event.key === 'ArrowLeft' ? 'main' : 'side');
      }
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const entries = pane === 'main' ? [null, ...pages.map((page) => page.id)] : pages.map((page) => page.id);
    if (!entries.length) return;
    event.preventDefault();
    const current = Math.max(0, entries.indexOf(event.target.dataset.pageId ?? null));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + entries.length) % entries.length;
    const pageId = entries[next];
    pendingFocus.current = pageId ?? 'chat';
    if (pageId === null) showChat(); else activatePage(pageId);
  };
  useLayoutEffect(() => {
    if (!visible) return;
    const tab = document.getElementById(activeId ? `${id}-tab-${encodeURIComponent(activeId)}` : `${id}-chat`);
    const tabList = tab?.parentElement;
    if (tab && tabList) {
      const bounds = tabList.getBoundingClientRect();
      const tabBounds = tab.getBoundingClientRect();
      const left = tabBounds.left < bounds.left ? tabBounds.left - bounds.left : Math.max(0, tabBounds.right - bounds.right);
      tabList.scrollBy({ left, behavior: 'instant' });
    }
    if (pendingFocus.current === (activeId ?? 'chat') || activeId && pendingPageFocusRef.current === activeId) {
      tab?.focus({ preventScroll: true });
      pendingFocus.current = null;
      pendingPageFocusRef.current = null;
    }
  }, [activeId, id, visible, start, pendingPageFocusRef]);
  const fullscreenLabel = t(layout.fullscreen ? 'restore' : 'fullscreen');
  return <div hidden={!visible} inert={!visible} style={{ ...style, display: visible ? undefined : 'none' }}
    data-workspace-pane={pane} className={cn('z-10 flex min-w-0 items-center gap-1 bg-card px-2 py-1.5', pane === 'main' && window.electron?.platform === 'darwin' && 'drag-region')}>
    <div role="tablist" aria-label={t(pane === 'main' ? 'mainTabs' : 'sideTabs')} aria-orientation="horizontal" onKeyDown={tabKeyDown}
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1">
      {pane === 'main' && <button type="button" role="tab" id={`${id}-chat`} aria-selected={activeId === null} tabIndex={activeId === null ? 0 : -1}
        onClick={showChat} className={cn('no-drag flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring', activeId === null ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:bg-secondary/50')}>
        <MessageSquare aria-hidden="true" className="h-3.5 w-3.5" />{t('chat')}
      </button>}
      {tabs.map((page) => <WorkspaceTab key={page.id} page={page} active={page.id === activeId}
        tabbable={page.id === activeId || pane === 'side' && !activeId && page.id === pages[0]?.id}
        tabId={`${id}-tab-${encodeURIComponent(page.id)}`} panelId={`${id}-panel-${encodeURIComponent(page.id)}`} onSelect={select} onClose={closePage}
        onDragStart={onDragStart} onDragEnd={onDragEnd} />)}
    </div>
    {visible && pages.length > 50 && <div className="no-drag shrink-0"><PageOverflow pages={pages} activeId={activeId} onSelect={select} scopeKey={workspace.scopeKey} /></div>}
    {actions && <div className="no-drag shrink-0">{actions}</div>}
    {pane === 'side' && <>
      {visible && <LauncherMenu launchers={launchers} workspace={workspace} />}
      <Button type="button" variant="ghost" size="icon" className={iconButtonClass}
        onClick={() => setLayout({ fullscreen: !layout.fullscreen, composer: layout.fullscreen ? undefined : 'dock' })}
        title={fullscreenLabel} aria-label={fullscreenLabel} aria-pressed={layout.fullscreen}>
        {layout.fullscreen ? <Minimize2 aria-hidden="true" className="h-4 w-4" /> : <Maximize2 aria-hidden="true" className="h-4 w-4" />}
      </Button>
      <Button type="button" variant="ghost" size="icon" className={iconButtonClass} onClick={onHide} title={t('hide')} aria-label={t('hide')}>
        <PanelRightClose aria-hidden="true" className="h-4 w-4" />
      </Button>
    </>}
  </div>;
}

export const WorkspacePanel = memo(function WorkspacePanel(props: WorkspacePanelProps) {
  const { t } = useTranslation('workspace');
  const workspace = useWorkspace();
  const { pages, activePageIds, pagePlacements, layout, closePage, setLayout, registerCloseHandler } = workspace;
  const contributions = useContributions(workspaceLaunchers);
  const launchers = useMemo(() => [...contributions].sort((a, b) => a.order - b.order), [contributions]);
  const mainPages = useMemo(() => pages.filter((page) => pagePlacements[page.id] === 'main'), [pages, pagePlacements]);
  const sidePages = useMemo(() => pages.filter((page) => pagePlacements[page.id] === 'side'), [pages, pagePlacements]);
  const mainTabs = useMemo(() => getPaneTabs(mainPages, activePageIds.main), [mainPages, activePageIds.main]);
  const sideTabs = useMemo(() => getPaneTabs(sidePages, activePageIds.side), [sidePages, activePageIds.side]);
  const tabIds = useMemo(() => new Set([...mainTabs.tabs, ...sideTabs.tabs].map((page) => page.id)), [mainTabs, sideTabs]);
  const [drag, setDrag] = useState<{ pageId: string; over: boolean } | null>(null);
  const pendingPageFocusRef = useRef<string | null>(null);
  const endDrag = useCallback(() => setDrag(null), []);
  const startDrag = useCallback((event: DragEvent<HTMLDivElement>, pageId: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-matcha-workspace-page', pageId);
    setDrag({ pageId, over: false });
    if (workspace.pagePlacements[pageId] === 'main' && !workspace.open) workspace.show();
  }, [workspace]);
  const drop = (event: DragEvent<HTMLDivElement>, pane: WorkspacePane) => {
    if (!drag) return;
    event.preventDefault();
    pendingPageFocusRef.current = drag.pageId;
    workspace.movePage(drag.pageId, pane);
    endDrag();
  };
  const dragTarget: WorkspacePane | null = drag && pagePlacements[drag.pageId]
    ? pagePlacements[drag.pageId] === 'main' ? 'side' : 'main' : null;
  const dropVisible = dragTarget === 'main' ? props.mainVisible || props.visible : props.visible;
  const id = useId();
  return <div className="contents">
    <PaneHeader pane="main" pageTabs={mainTabs} workspace={workspace} launchers={launchers} visible={props.mainVisible}
      style={props.mainStyle.header} actions={props.mainActions} onHide={props.onHide} id={id} onDragStart={startDrag} onDragEnd={endDrag} pendingPageFocusRef={pendingPageFocusRef} />
    <PaneHeader pane="side" pageTabs={sideTabs} workspace={workspace} launchers={launchers} visible={props.visible}
      style={props.sideStyle.header} onHide={props.onHide} id={id} onDragStart={startDrag} onDragEnd={endDrag} pendingPageFocusRef={pendingPageFocusRef} />
    {sidePages.length === 0 && <div style={{ ...props.sideStyle.body, display: props.visible ? undefined : 'none' }} inert={!props.visible}
      className="flex min-h-0 min-w-0 flex-col items-center overflow-y-auto bg-card p-6">
      <div className="my-auto w-full max-w-xs shrink-0 space-y-1">
        <p className="px-3 pb-2 text-sm text-muted-foreground">{t(launchers.length ? 'addPage' : 'noLaunchers')}</p>
        {launchers.map((launcher) => <LauncherItem key={launcher.id} launcher={launcher} workspace={workspace} />)}
      </div>
    </div>}
    {pages.map((page) => {
      const pane = pagePlacements[page.id];
      const visible = (pane === 'main' ? props.mainVisible : props.visible) && activePageIds[pane] === page.id;
      return <PageSlot key={page.lifetime === 'workspace' || page.retainOnSessionChange ? page.id : JSON.stringify(page.workspaceDraftId ? [page.workspaceDraftId, page.id] : [workspace.scopeKey, workspace.draftId, page.id])}
        page={page} active={visible}
        style={(pane === 'main' ? props.mainStyle : props.sideStyle).body}
        tabId={tabIds.has(page.id) ? `${id}-tab-${encodeURIComponent(page.id)}` : undefined} panelId={`${id}-panel-${encodeURIComponent(page.id)}`}
        sessionIdentity={workspace.sessionIdentity ?? undefined} workspaceDraftId={page.workspaceDraftId}
        visible={visible} width={pane === 'main' ? props.mainWidth : props.width}
        layout={layout} onLayoutChange={setLayout} closePage={closePage} registerCloseHandler={registerCloseHandler}
        onSendMessage={props.onSendMessage} onOpenLink={props.onOpenLink} />;
    })}
    {drag && dragTarget && dropVisible && <div data-workspace-drop-target={dragTarget}
      style={(dragTarget === 'main' ? props.mainStyle : props.sideStyle).dropTarget}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        if (!drag.over) setDrag({ ...drag, over: true });
      }}
      onDragLeave={(event) => {
        if (drag.over && (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))) setDrag({ ...drag, over: false });
      }}
      onDrop={(event) => drop(event, dragTarget)}
      className={cn('flex min-h-0 min-w-0 items-center justify-center border-2 border-dashed border-primary/40 bg-primary/5', drag.over && 'border-primary bg-primary/10')}>
      <span className="pointer-events-none rounded-lg border border-border bg-popover px-4 py-2 text-sm text-popover-foreground shadow-sm">{t(dragTarget === 'main' ? 'dropToMain' : 'dropToSide')}</span>
    </div>}
  </div>;
});
