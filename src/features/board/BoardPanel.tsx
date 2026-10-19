import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeft, ArrowRight, LayoutDashboard, Maximize2, Minimize2, MoreHorizontal, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useBoardStore } from '@/stores/board';
import { boardIdentityKey, type BoardChatDock, type BoardIdentity, type BoardOp, type BoardOperation, type BoardTab, type BoardWidget } from '@/types/board';
import { BoardGrid } from './BoardGrid';
import { BoardWidgetEditor } from './BoardWidgetEditor';

export interface BoardPanelProps {
  identity: BoardIdentity;
  onChatDockChange?: (dock: BoardChatDock) => void;
  onFullscreenChange?: (fullscreen: boolean) => void;
  onSendMessage?: (text: string) => Promise<void> | void;
  onOpenLink?: (url: string) => Promise<void> | void;
}

type BoardDialog =
  | { kind: 'tab-create' }
  | { kind: 'tab-rename' | 'tab-delete'; tab: BoardTab }
  | { kind: 'widget-remove'; widget: BoardWidget };

const EMPTY_TABS: BoardTab[] = [];
const EMPTY_WIDGETS: BoardWidget[] = [];
const CHAT_DOCKS = ['left', 'right', 'bottom', 'hidden'] as const;

export function BoardPanel(props: BoardPanelProps) {
  return <BoardPanelSession key={boardIdentityKey(props.identity)} {...props} />;
}

function BoardPanelSession({ identity: initialIdentity, onChatDockChange, onFullscreenChange, onSendMessage, onOpenLink }: BoardPanelProps) {
  const { t } = useTranslation('chat');
  // The keyed panel owns one exact native session, including its in-flight UI.
  const [identity] = useState(initialIdentity);
  const identityKey = boardIdentityKey(identity);
  const storeIdentity = useBoardStore((state) => state.identity);
  const storedSnapshot = useBoardStore((state) => state.snapshot);
  const storedStatus = useBoardStore((state) => state.status);
  const storedError = useBoardStore((state) => state.error);
  const activeTabId = useBoardStore((state) => state.activeTabId);
  const command = useBoardStore((state) => state.command);
  const open = useBoardStore((state) => state.open);
  const close = useBoardStore((state) => state.close);
  const refresh = useBoardStore((state) => state.refresh);
  const execute = useBoardStore((state) => state.execute);
  const selectTab = useBoardStore((state) => state.selectTab);
  const clearCommand = useBoardStore((state) => state.clearCommand);
  const matchesIdentity = storeIdentity !== null && boardIdentityKey(storeIdentity) === identityKey;
  const snapshot = matchesIdentity ? storedSnapshot : null;
  const status = matchesIdentity ? storedStatus : 'loading';
  const error = matchesIdentity ? storedError : null;
  const tabs = useMemo(() => snapshot ? [...snapshot.tabs].sort((a, b) => a.position - b.position || a.tabId.localeCompare(b.tabId)) : EMPTY_TABS, [snapshot]);
  const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? tabs[0];
  const chatDock = activeTab?.chatDock;
  const selectedTabId = activeTab?.tabId;
  const widgets = snapshot?.widgets ?? EMPTY_WIDGETS;
  const activeWidgets = activeTab ? widgets.filter((widget) => widget.tabId === activeTab.tabId) : EMPTY_WIDGETS;
  const [dialog, setDialog] = useState<BoardDialog | null>(null);
  const [editor, setEditor] = useState<{ widget?: BoardWidget } | null>(null);
  const [pending, setPending] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const pendingRef = useRef(false);
  const rootRef = useRef<HTMLElement>(null);
  const fullscreenCallback = useRef(onFullscreenChange);
  const tabDrag = useRef<string | null>(null);
  const canMutate = status === 'ready' && !pending;

  useEffect(() => {
    void open(identity);
    return close;
  }, [identity, open, close]);

  useEffect(() => { fullscreenCallback.current = onFullscreenChange; }, [onFullscreenChange]);
  useEffect(() => () => fullscreenCallback.current?.(false), []);

  useEffect(() => {
    if (chatDock) onChatDockChange?.(chatDock);
  }, [selectedTabId, chatDock, onChatDockChange]);

  useEffect(() => {
    if (!matchesIdentity || !command) return;
    if (command.kind === 'set_chat_dock') {
      onChatDockChange?.(command.dock);
    } else {
      if (!tabs.some((tab) => tab.tabId === command.tabId)) return;
      selectTab(command.tabId);
      Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-board-tab-id]') ?? [])
        .find((element) => element.dataset.boardTabId === command.tabId)?.focus();
    }
    clearCommand();
  }, [matchesIdentity, command, tabs, onChatDockChange, selectTab, clearCommand]);

  async function submit(operation: BoardOperation): Promise<boolean> {
    if (pendingRef.current || !canMutate) return false;
    pendingRef.current = true;
    setPending(true);
    try {
      await execute(operation);
      setAnnouncement(t('board.saved', { defaultValue: 'Board changes saved.' }));
      return true;
    } catch {
      // execute preserves the typed native failure in the single store projection.
      return false;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  const mutate = (ops: BoardOp[]) => submit({ method: 'board.update', ops });

  function reorderTab(tabId: string, targetIndex: number) {
    const orderedIds = tabs.map((tab) => tab.tabId);
    const from = orderedIds.indexOf(tabId);
    const to = Math.max(0, Math.min(orderedIds.length - 1, targetIndex));
    if (from < 0 || from === to) return;
    orderedIds.splice(from, 1);
    orderedIds.splice(to, 0, tabId);
    void mutate([{ kind: 'tabs_reorder', tabIds: orderedIds }]);
  }

  async function confirmDialog(title: string): Promise<boolean> {
    if (!dialog) return false;
    switch (dialog.kind) {
      case 'tab-create': {
        const tabId = `tab-${crypto.randomUUID().slice(0, 12)}`;
        const saved = await mutate([{ kind: 'tab_create', tabId, title }]);
        if (saved) selectTab(tabId);
        return saved;
      }
      case 'tab-rename': return mutate([{ kind: 'tab_update', tabId: dialog.tab.tabId, title }]);
      case 'tab-delete': return mutate([{ kind: 'tab_delete', tabId: dialog.tab.tabId }]);
      case 'widget-remove': return mutate([{ kind: 'widget_remove', name: dialog.widget.name }]);
    }
  }

  return (
    <section ref={rootRef} data-board-root className="flex h-full min-h-0 min-w-0 flex-col bg-background" aria-label={t('board.title', { defaultValue: 'Board' })} aria-busy={pending || status === 'loading'}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <LayoutDashboard className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{t('board.title', { defaultValue: 'Board' })}</h2>
        {snapshot && <span className="text-[10px] tabular-nums text-muted-foreground" title={t('board.revision', { defaultValue: 'Native revision' })}>r{snapshot.revision}</span>}
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={pending || status === 'loading'} onClick={() => void refresh()} aria-label={t('board.refresh', { defaultValue: 'Refresh board' })}>
          <RefreshCw className={cn('h-3.5 w-3.5', status === 'loading' && 'animate-spin')} aria-hidden="true" />
        </Button>
        {onFullscreenChange && <Button variant="ghost" size="icon" className="h-8 w-8" aria-pressed={fullscreen} aria-label={t(fullscreen ? 'board.exitFullscreen' : 'board.fullscreen', { defaultValue: fullscreen ? 'Exit fullscreen' : 'Fullscreen board' })} onClick={() => {
          const next = !fullscreen;
          onFullscreenChange(next);
          setFullscreen(next);
        }}>{fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</Button>}
        <Button variant="outline" size="sm" className="h-8 px-2.5" disabled={!canMutate || !activeTab} onClick={() => setEditor({})}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />{t('board.pinWidget', { defaultValue: 'Pin widget' })}
        </Button>
      </header>

      {error && <div role="alert" data-board-error={error.code} className="flex shrink-0 items-start gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs">
        <div className="min-w-0 flex-1"><strong className="block font-medium">{t(`board.failure.${error.code}`, { defaultValue: error.code === 'unsupported' ? 'This runtime does not support Board.' : 'Board operation could not be confirmed.' })}</strong><p className="mt-1 break-words text-muted-foreground">{error.message}</p>{error.code === 'unknown' && <p className="mt-1">{t('board.unknownOutcomeHint', { defaultValue: 'The outcome is not confirmed. The current board has been reread; repeating the operation may execute it twice.' })}</p>}</div>
        <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2" disabled={pending || status === 'loading'} onClick={() => void refresh()}>{t('board.refresh', { defaultValue: 'Refresh board' })}</Button>
      </div>}
      {pending && <p role="status" className="shrink-0 px-3 py-1 text-xs text-muted-foreground">{t('board.saving', { defaultValue: 'Saving native board changes…' })}</p>}

      {(snapshot || status === 'ready') && <nav className="flex shrink-0 items-center gap-1 border-b border-border/50 px-2 py-1" aria-label={t('board.tabsLabel', { defaultValue: 'Board tabs' })}>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist" aria-label={t('board.tabsLabel', { defaultValue: 'Board tabs' })}>
          {tabs.map((tab, index) => <button key={tab.tabId} type="button" role="tab" id={`board-tab-${tab.tabId}`} aria-controls="board-tab-panel" aria-selected={tab.tabId === activeTab?.tabId} tabIndex={tab.tabId === activeTab?.tabId ? 0 : -1} data-board-tab-id={tab.tabId} className={cn('shrink-0 rounded-lg px-3 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40', tab.tabId === activeTab?.tabId ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60')} draggable={canMutate} onClick={() => selectTab(tab.tabId)} onDragStart={(event) => {
            tabDrag.current = tab.tabId;
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', tab.tabId);
          }} onDragOver={(event) => { if (tabDrag.current && canMutate) event.preventDefault(); }} onDrop={(event) => {
            event.preventDefault();
            if (tabDrag.current && canMutate) reorderTab(tabDrag.current, index);
            tabDrag.current = null;
          }} onDragEnd={() => { tabDrag.current = null; }} onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : Math.max(0, Math.min(tabs.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
            if (event.altKey) { if (canMutate) reorderTab(tab.tabId, nextIndex); return; }
            const next = tabs[nextIndex];
            if (!next) return;
            selectTab(next.tabId);
            Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-board-tab-id]') ?? []).find((element) => element.dataset.boardTabId === next.tabId)?.focus();
          }}>{tab.title}</button>)}
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" disabled={!canMutate} onClick={() => setDialog({ kind: 'tab-create' })} aria-label={t('board.createTab', { defaultValue: 'Create tab' })}><Plus className="h-3.5 w-3.5" /></Button>
        {activeTab && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t('board.tabMenu', { defaultValue: 'Tab menu' })}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={!canMutate} onSelect={() => setDialog({ kind: 'tab-rename', tab: activeTab })}>{t('board.renameTab', { defaultValue: 'Rename tab' })}</DropdownMenuItem>
            <DropdownMenuItem disabled={!canMutate || tabs[0]?.tabId === activeTab.tabId} onSelect={() => reorderTab(activeTab.tabId, tabs.indexOf(activeTab) - 1)}><ArrowLeft className="h-3.5 w-3.5" />{t('board.moveTabEarlier', { defaultValue: 'Move tab earlier' })}</DropdownMenuItem>
            <DropdownMenuItem disabled={!canMutate || tabs[tabs.length - 1]?.tabId === activeTab.tabId} onSelect={() => reorderTab(activeTab.tabId, tabs.indexOf(activeTab) + 1)}><ArrowRight className="h-3.5 w-3.5" />{t('board.moveTabLater', { defaultValue: 'Move tab later' })}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('board.chatDock', { defaultValue: 'Chat position' })}</DropdownMenuLabel>
            {CHAT_DOCKS.map((dock) => <DropdownMenuItem key={dock} disabled={!canMutate || dock === activeTab.chatDock} onSelect={() => void mutate([{ kind: 'tab_update', tabId: activeTab.tabId, chatDock: dock }])}><span className="w-3 text-center" aria-hidden="true">{dock === activeTab.chatDock ? '•' : ''}</span>{t(`board.dock.${dock}`, { defaultValue: dock === 'hidden' ? 'Hidden' : dock[0].toUpperCase() + dock.slice(1) })}</DropdownMenuItem>)}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive" disabled={!canMutate || tabs.length === 1 && activeWidgets.length > 0} onSelect={() => setDialog({ kind: 'tab-delete', tab: activeTab })}>{t('board.deleteTab', { defaultValue: 'Delete tab' })}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>}
      </nav>}

      <div id="board-tab-panel" role="tabpanel" aria-labelledby={activeTab ? `board-tab-${activeTab.tabId}` : undefined} className="min-h-0 flex-1 overflow-auto">
        {status === 'loading' && !snapshot ? <p role="status" className="p-6 text-sm text-muted-foreground">{t('board.loading', { defaultValue: 'Loading native board…' })}</p>
          : status === 'unavailable' ? <div className="p-6 text-sm text-muted-foreground">{t('board.unavailable', { defaultValue: 'Board is unavailable for this session. Refresh to try again.' })}</div>
            : !activeTab ? <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"><LayoutDashboard className="h-7 w-7 text-muted-foreground/50" /><p className="text-sm text-muted-foreground">{t('board.noTabs', { defaultValue: 'Create a tab to start your board.' })}</p><Button variant="outline" size="sm" disabled={!canMutate} onClick={() => setDialog({ kind: 'tab-create' })}>{t('board.createTab', { defaultValue: 'Create tab' })}</Button></div>
              : activeWidgets.length === 0 ? <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"><LayoutDashboard className="h-7 w-7 text-muted-foreground/50" /><strong className="text-sm font-medium">{t('board.emptyTitle', { defaultValue: 'A place for things worth keeping' })}</strong><p className="max-w-64 text-xs text-muted-foreground">{t('board.emptyHint', { defaultValue: 'Pin HTML, an MCP App, a canvas, or a native plugin to this tab.' })}</p><Button variant="outline" size="sm" disabled={!canMutate} onClick={() => setEditor({})}>{t('board.pinWidget', { defaultValue: 'Pin widget' })}</Button></div>
                : <BoardGrid key={activeTab.tabId} identity={identity} revision={snapshot?.revision ?? 0} widgets={activeWidgets} tabs={tabs} busy={!canMutate} mutate={mutate} submit={submit} onEdit={(widget) => setEditor({ widget })} onRemove={(widget) => setDialog({ kind: 'widget-remove', widget })} onRefresh={refresh} onSendMessage={onSendMessage} onOpenLink={onOpenLink} />}
      </div>
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
      {dialog && <BoardChangeDialog key={dialog.kind === 'tab-create' ? dialog.kind : dialog.kind === 'widget-remove' ? dialog.widget.name : dialog.tab.tabId} dialog={dialog} pending={pending} onClose={() => setDialog(null)} onConfirm={confirmDialog} />}
      {editor && activeTab && <BoardWidgetEditor widget={editor.widget} tabId={activeTab.tabId} widgets={widgets} onClose={() => setEditor(null)} onSubmit={submit} />}
    </section>
  );
}

function BoardChangeDialog({ dialog, pending, onClose, onConfirm }: { dialog: BoardDialog; pending: boolean; onClose: () => void; onConfirm: (title: string) => Promise<boolean> }) {
  const { t } = useTranslation('chat');
  const isName = dialog.kind === 'tab-create' || dialog.kind === 'tab-rename';
  const [title, setTitle] = useState(dialog.kind === 'tab-rename' ? dialog.tab.title : '');
  const heading = dialog.kind === 'tab-create' ? t('board.createTab', { defaultValue: 'Create tab' }) : dialog.kind === 'tab-rename' ? t('board.renameTab', { defaultValue: 'Rename tab' }) : dialog.kind === 'tab-delete' ? t('board.deleteTab', { defaultValue: 'Delete tab' }) : t('board.widget.remove', { defaultValue: 'Remove widget' });
  return <Dialog.Root open onOpenChange={(next) => { if (!next && !pending) onClose(); }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px]" /><Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(400px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-5 shadow-elevated" onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }} onPointerDownOutside={(event) => { if (pending) event.preventDefault(); }}>
    <Dialog.Title className="text-sm font-semibold">{heading}</Dialog.Title>
    <Dialog.Description className="mt-2 text-xs text-muted-foreground">{isName ? t('board.tabNameHint', { defaultValue: 'Choose a name for this native board tab.' }) : dialog.kind === 'tab-delete' ? t('board.deleteTabHint', { defaultValue: 'Widgets move to the first remaining tab. A nonempty last tab cannot be deleted.' }) : t('board.removeWidgetHint', { defaultValue: 'Remove this widget from the native board. This does not delete its source.' })}</Dialog.Description>
    <form className="mt-4 space-y-4" onSubmit={async (event) => { event.preventDefault(); if (!pending && (!isName || title.trim() && [...title.trim()].length <= 80) && await onConfirm(title.trim())) onClose(); }}>
      {isName ? <label className="block space-y-2 text-xs"><span>{t('board.tabName', { defaultValue: 'Tab name' })}</span><Input value={title} onChange={(event) => { const value = event.target.value; setTitle(value); event.target.setCustomValidity([...value.trim()].length > 80 ? t('board.tabNameTooLong', { defaultValue: 'Use at most 80 characters.' }) : ''); }} required maxLength={160} disabled={pending} autoFocus /></label> : <p className="break-words text-sm font-medium">{dialog.kind === 'widget-remove' ? dialog.widget.title || dialog.widget.name : dialog.kind === 'tab-delete' ? dialog.tab.title : ''}</p>}
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onClose}>{t('board.cancel', { defaultValue: 'Cancel' })}</Button><Button type="submit" variant={isName ? 'default' : 'destructive'} size="sm" disabled={pending || isName && (!title.trim() || [...title.trim()].length > 80)}>{pending ? t('board.saving', { defaultValue: 'Saving native board changes…' }) : isName ? t('board.save', { defaultValue: 'Save' }) : heading}</Button></div>
    </form>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
