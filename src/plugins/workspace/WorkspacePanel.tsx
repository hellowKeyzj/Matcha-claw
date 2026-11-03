import { memo, Suspense, useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Maximize2, Minimize2, PanelRightClose, Plus, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useContributions } from '@/plugin-host/react';
import { useWorkspace } from './context';
import { workspaceLaunchers, type WorkspaceCloseHandler, type WorkspaceController, type WorkspaceLauncher, type WorkspacePage, type WorkspacePageProps, type WorkspacePanelProps } from './extensions';

const MENU_PAGE_SIZE = 40;
const iconButtonClass = 'h-8 w-8 shrink-0 rounded-md motion-reduce:transition-none';

function MenuPagination({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  const { t } = useTranslation('workspace');
  const previous = useCallback((event: Event) => { event.preventDefault(); onChange(page - 1); }, [page, onChange]);
  const next = useCallback((event: Event) => { event.preventDefault(); onChange(page + 1); }, [page, onChange]);
  if (total <= MENU_PAGE_SIZE) return null;
  return <>
    <DropdownMenuSeparator />
    <DropdownMenuLabel className="text-xs text-muted-foreground">{t('menuPage', { current: page + 1, total: Math.ceil(total / MENU_PAGE_SIZE) })}</DropdownMenuLabel>
    <DropdownMenuItem disabled={page === 0} onSelect={previous} className="motion-reduce:transition-none">
      <ChevronLeft aria-hidden="true" className="h-4 w-4" />{t('previousPage')}
    </DropdownMenuItem>
    <DropdownMenuItem disabled={(page + 1) * MENU_PAGE_SIZE >= total} onSelect={next} className="motion-reduce:transition-none">
      <ChevronRight aria-hidden="true" className="h-4 w-4" />{t('nextPage')}
    </DropdownMenuItem>
  </>;
}

const LauncherItem = memo(function LauncherItem({ launcher, workspace, menu = false }: {
  launcher: WorkspaceLauncher; workspace: WorkspaceController; menu?: boolean;
}) {
  const { t } = useTranslation('workspace');
  const execute = useCallback(() => {
    void Promise.resolve().then(() => launcher.execute({ workspace, sessionIdentity: workspace.sessionIdentity, scopeKey: workspace.scopeKey }))
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : t('openFailed')));
  }, [launcher, workspace, t]);
  const Icon = launcher.icon;
  const label = t(launcher.label, { defaultValue: launcher.defaultLabel });
  const content = <><Icon aria-hidden={true} className="h-4 w-4 shrink-0" /><span className="truncate">{label}</span></>;
  return menu
    ? <DropdownMenuItem onSelect={execute} title={label} className="motion-reduce:transition-none">{content}</DropdownMenuItem>
    : <Button type="button" variant="ghost" onClick={execute} title={label} className="h-9 w-full justify-start rounded-lg px-3 motion-reduce:transition-none">{content}</Button>;
});

const LauncherMenu = memo(function LauncherMenu({ launchers, workspace }: { launchers: readonly WorkspaceLauncher[]; workspace: WorkspaceController }) {
  const { t } = useTranslation('workspace');
  const [menuPage, setMenuPage] = useState(0);
  const page = Math.min(menuPage, Math.max(0, Math.ceil(launchers.length / MENU_PAGE_SIZE) - 1));
  const onOpenChange = useCallback((open: boolean) => { if (open) setMenuPage(0); }, []);
  return <DropdownMenu onOpenChange={onOpenChange}>
    <DropdownMenuTrigger asChild>
      <Button type="button" variant="ghost" size="icon" className={iconButtonClass} aria-label={t('addPage')} title={t('addPage')}>
        <Plus aria-hidden="true" className="h-4 w-4" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] max-w-xs overflow-y-auto">
      {launchers.length ? launchers.slice(page * MENU_PAGE_SIZE, (page + 1) * MENU_PAGE_SIZE).map((launcher) =>
        <LauncherItem key={launcher.id} launcher={launcher} workspace={workspace} menu />)
        : <DropdownMenuItem disabled>{t('noLaunchers')}</DropdownMenuItem>}
      <MenuPagination page={page} total={launchers.length} onChange={setMenuPage} />
    </DropdownMenuContent>
  </DropdownMenu>;
});

const OverflowItem = memo(function OverflowItem({ page, active, onSelect }: { page: WorkspacePage; active: boolean; onSelect: (id: string) => void }) {
  const { t } = useTranslation('workspace');
  const select = useCallback(() => onSelect(page.id), [onSelect, page.id]);
  const Icon = page.icon;
  return <DropdownMenuItem onSelect={select} title={page.title} className={cn('motion-reduce:transition-none', active && 'bg-accent text-accent-foreground')}>
    {Icon && <Icon aria-hidden={true} className="h-4 w-4 shrink-0" />}
    <span className="min-w-0 flex-1 truncate">{page.title}</span>
    {page.badge === 'preview' && <span className="text-xs text-muted-foreground">{t('preview')}</span>}
  </DropdownMenuItem>;
});

const PageOverflow = memo(function PageOverflow({ pages, activeId, onSelect }: { pages: readonly WorkspacePage[]; activeId: string | null; onSelect: (id: string) => void }) {
  const { t } = useTranslation('workspace');
  const [menuPage, setMenuPage] = useState(0);
  const page = Math.min(menuPage, Math.max(0, Math.ceil(pages.length / MENU_PAGE_SIZE) - 1));
  const onOpenChange = useCallback((open: boolean) => {
    if (open) setMenuPage(Math.floor(Math.max(0, pages.findIndex((entry) => entry.id === activeId)) / MENU_PAGE_SIZE));
  }, [pages, activeId]);
  return <DropdownMenu onOpenChange={onOpenChange}>
    <DropdownMenuTrigger asChild>
      <Button type="button" variant="ghost" size="icon" className={iconButtonClass} aria-label={t('allTabs', { count: pages.length })} title={t('allTabs', { count: pages.length })}>
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] max-w-xs overflow-y-auto">
      {pages.slice(page * MENU_PAGE_SIZE, (page + 1) * MENU_PAGE_SIZE).map((entry) =>
        <OverflowItem key={entry.id} page={entry} active={entry.id === activeId} onSelect={onSelect} />)}
      <MenuPagination page={page} total={pages.length} onChange={setMenuPage} />
    </DropdownMenuContent>
  </DropdownMenu>;
});

const WorkspaceTab = memo(function WorkspaceTab({ page, active, tabbable, tabId, panelId, onSelect, onClose }: {
  page: WorkspacePage; active: boolean; tabbable: boolean; tabId: string; panelId: string;
  onSelect: (id: string) => void; onClose: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation('workspace');
  const select = useCallback(() => onSelect(page.id), [onSelect, page.id]);
  const keyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); }
  }, [select]);
  const close = useCallback((event: MouseEvent<HTMLButtonElement>) => { event.stopPropagation(); void onClose(page.id); }, [onClose, page.id]);
  const stopKey = useCallback((event: KeyboardEvent<HTMLButtonElement>) => event.stopPropagation(), []);
  const Icon = page.icon;
  return <div id={tabId} role="tab" aria-controls={panelId} aria-selected={active} tabIndex={tabbable ? 0 : -1}
    data-page-id={page.id} title={page.title} onClick={select} onKeyDown={keyDown}
    className={cn('group flex h-9 min-w-[112px] max-w-[240px] shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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

const PageSlot = memo(function PageSlot({ page, active, tabId, panelId, closePage, registerCloseHandler, ...props }: Omit<WorkspacePageProps, 'onClose' | 'registerCloseHandler'> & {
  page: WorkspacePage; active: boolean; tabId?: string; panelId: string;
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
    className={cn('h-full min-h-0 min-w-0 flex-1 overflow-hidden', active && 'flex flex-col')}>
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

export const WorkspacePanel = memo(function WorkspacePanel(props: WorkspacePanelProps) {
  const { t } = useTranslation('workspace');
  const workspace = useWorkspace();
  const { pages, activePageId, layout, activatePage, closePage, setLayout, registerCloseHandler } = workspace;
  const contributions = useContributions(workspaceLaunchers);
  const launchers = useMemo(() => [...contributions].sort((a, b) => a.order - b.order), [contributions]);
  const id = useId();
  const pendingFocus = useRef<string | null>(null);
  const activeIndex = Math.max(0, pages.findIndex((page) => page.id === activePageId));
  const start = pages.length > 50 ? Math.min(Math.max(0, activeIndex - 20), pages.length - MENU_PAGE_SIZE) : 0;
  const tabs = useMemo(() => pages.length > 50 ? pages.slice(start, start + MENU_PAGE_SIZE) : pages, [pages, start]);
  const tabIds = useMemo(() => new Set(tabs.map((page) => page.id)), [tabs]);
  const select = useCallback((pageId: string) => activatePage(pageId), [activatePage]);
  const toggleFullscreen = useCallback(() => setLayout({ fullscreen: !layout.fullscreen, composer: layout.fullscreen ? undefined : 'dock' }), [setLayout, layout.fullscreen]);
  const tabKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !pages.length
      || !(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return;
    event.preventDefault();
    const pageId = event.target.dataset.pageId;
    const current = Math.max(0, pages.findIndex((page) => page.id === pageId));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? pages.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + pages.length) % pages.length;
    pendingFocus.current = pages[next].id === activePageId ? null : pages[next].id;
    activatePage(pages[next].id);
  }, [pages, activePageId, activatePage]);
  useLayoutEffect(() => {
    if (!props.visible || !activePageId) return;
    const tab = document.getElementById(`${id}-tab-${encodeURIComponent(activePageId)}`);
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    if (pendingFocus.current === activePageId) {
      tab?.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  }, [id, activePageId, tabs, props.visible]);
  const fullscreenLabel = t(layout.fullscreen ? 'restore' : 'fullscreen');
  return <aside aria-label={t('title')} data-mode={props.mode} inert={!props.visible}
    className={cn('relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-card',
      layout.fullscreen ? 'border-0' : props.mode === 'overlay' && 'rounded-[18px] border border-border/60 shadow-elevated')}>
    <div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1.5">
      <div role="tablist" aria-label={t('tabs')} aria-orientation="horizontal" onKeyDown={tabKeyDown}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1">
        {tabs.map((page) => <WorkspaceTab key={page.id} page={page} active={page.id === activePageId}
          tabbable={page.id === activePageId || !activePageId && page.id === pages[0]?.id}
          tabId={`${id}-tab-${encodeURIComponent(page.id)}`} panelId={`${id}-panel-${encodeURIComponent(page.id)}`} onSelect={select} onClose={closePage} />)}
      </div>
      {pages.length > 50 && <PageOverflow pages={pages} activeId={activePageId} onSelect={select} />}
      <LauncherMenu launchers={launchers} workspace={workspace} />
      <Button type="button" variant="ghost" size="icon" className={iconButtonClass} onClick={toggleFullscreen}
        title={fullscreenLabel} aria-label={fullscreenLabel} aria-pressed={layout.fullscreen}>
        {layout.fullscreen ? <Minimize2 aria-hidden="true" className="h-4 w-4" /> : <Maximize2 aria-hidden="true" className="h-4 w-4" />}
      </Button>
      <Button type="button" variant="ghost" size="icon" className={iconButtonClass} onClick={props.onHide} title={t('hide')} aria-label={t('hide')}>
        <PanelRightClose aria-hidden="true" className="h-4 w-4" />
      </Button>
    </div>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {!pages.length && <div className="flex h-full items-center justify-center overflow-y-auto p-6">
        <div className="w-full max-w-xs space-y-1">
          <p className="px-3 pb-2 text-sm text-muted-foreground">{t(launchers.length ? 'addPage' : 'noLaunchers')}</p>
          {launchers.slice(0, 6).map((launcher) => <LauncherItem key={launcher.id} launcher={launcher} workspace={workspace} />)}
        </div>
      </div>}
      {pages.map((page) => <PageSlot key={page.lifetime === 'workspace' ? page.id : JSON.stringify(page.workspaceDraftId ? [page.workspaceDraftId, page.id] : [workspace.scopeKey, workspace.draftId, page.id])} page={page} active={page.id === activePageId}
        tabId={tabIds.has(page.id) ? `${id}-tab-${encodeURIComponent(page.id)}` : undefined} panelId={`${id}-panel-${encodeURIComponent(page.id)}`}
        sessionIdentity={workspace.sessionIdentity ?? undefined} workspaceDraftId={page.workspaceDraftId}
        visible={props.visible && page.id === activePageId} width={props.width}
        layout={layout} onLayoutChange={setLayout} closePage={closePage} registerCloseHandler={registerCloseHandler}
        onSendMessage={props.onSendMessage} onOpenLink={props.onOpenLink} />)}
    </div>
  </aside>;
});
