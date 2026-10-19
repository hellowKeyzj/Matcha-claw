import { useCallback, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import './board.css';
import { ArrowDown, ArrowUp, GripVertical, MoreHorizontal, Pencil, RefreshCw, ShieldCheck, ShieldX, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RuntimeContentHost } from '@/components/runtime-surfaces/RuntimeContentHost';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { boardIdentityKey, type BoardIdentity, type BoardOp, type BoardOperation, type BoardTab, type BoardWidget } from '@/types/board';
import { BOARD_GRID_COLUMNS, BOARD_GRID_GAP, BOARD_GRID_ROW_HEIGHT, effectiveBoardWidgetRows, exactBoardWidgetHeightPx, layout, nudge, previewDrag, resize, type BoardGridItem, type BoardGridRect } from './board-layout';

interface BoardGridProps {
  identity: BoardIdentity;
  revision: number;
  widgets: readonly BoardWidget[];
  tabs: readonly BoardTab[];
  busy: boolean;
  mutate: (ops: BoardOp[]) => Promise<boolean>;
  submit: (operation: BoardOperation) => Promise<boolean>;
  onEdit: (widget: BoardWidget) => void;
  onRemove: (widget: BoardWidget) => void;
  onRefresh: () => Promise<void> | void;
  onSendMessage?: (text: string) => Promise<void> | void;
  onOpenLink?: (url: string) => Promise<void> | void;
}

type Gesture = {
  mode: 'move' | 'resize';
  name: string;
  pointerId: number;
  revision: number;
  x: number;
  y: number;
  w: number;
  h: number;
  items: BoardGridItem[];
  preview: BoardGridItem[];
  tabId?: string;
  valid: boolean;
};

const CHROME_HEIGHT = 38;
const GRID_PADDING = 12;
const SIZE_PRESETS = [{ w: 3, h: 3 }, { w: 6, h: 4 }, { w: 8, h: 6 }, { w: 12, h: 8 }];
const widgetKey = (widget: BoardWidget) => JSON.stringify([widget.name, widget.revision, widget.instanceId]);

export function BoardGrid({ identity, revision, widgets, tabs, busy, mutate, submit, onEdit, onRemove, onRefresh, onSendMessage, onOpenLink }: BoardGridProps) {
  const { t } = useTranslation('chat');
  const gridRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Gesture | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const heightKeys = useMemo(() => new Set(widgets.map(widgetKey)), [widgets]);
  const reportHeight = useCallback((key: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0 || !heightKeys.has(key)) return;
    setHeights((current) => current[key] === height ? current : { ...Object.fromEntries(Object.entries(current).filter(([entry]) => heightKeys.has(entry))), [key]: height });
  }, [heightKeys]);
  const ordered = [...widgets].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const items = ordered.map((widget) => ({ name: widget.name, order: widget.position, w: widget.sizeW, h: effectiveBoardWidgetRows(widget, heights[widgetKey(widget)], CHROME_HEIGHT) }));
  const activePreview = preview?.revision === revision && !busy ? preview : null;
  const rects = layout(activePreview?.preview ?? items);
  const byName = new Map(rects.map((rect) => [rect.name, rect]));
  const identityKey = boardIdentityKey(identity);

  function beginGesture(mode: Gesture['mode'], widget: BoardWidget, event: PointerEvent<HTMLButtonElement>) {
    if (busy || event.button !== 0 || gestureRef.current?.revision === revision) return;
    event.preventDefault();
    const rect = byName.get(widget.name);
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const gesture: Gesture = { mode, name: widget.name, pointerId: event.pointerId, revision, x: event.clientX, y: event.clientY, w: rect.w, h: rect.h, items, preview: items, valid: mode === 'resize' };
    gestureRef.current = gesture;
    setPreview({ ...gesture });
  }

  function updateGesture(event: PointerEvent): Gesture | null {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId || gesture.revision !== revision || busy) return null;
    const grid = gridRef.current;
    if (!grid) return null;
    const bounds = grid.getBoundingClientRect();
    const columnWidth = Math.max(1, (bounds.width - GRID_PADDING * 2 - BOARD_GRID_GAP * (BOARD_GRID_COLUMNS - 1)) / BOARD_GRID_COLUMNS);
    if (gesture.mode === 'resize') {
      gesture.preview = resize(gesture.items, gesture.name, gesture.w + Math.round((event.clientX - gesture.x) / (columnWidth + BOARD_GRID_GAP)), gesture.h + Math.round((event.clientY - gesture.y) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP)));
    } else {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const root = grid.closest('[data-board-root]');
      const tab = target?.closest<HTMLElement>('[data-board-tab-id]');
      gesture.tabId = tab && root?.contains(tab) && tabs.some((item) => item.tabId === tab.dataset.boardTabId) && tab.dataset.boardTabId !== widgets[0]?.tabId ? tab.dataset.boardTabId : undefined;
      gesture.valid = !!gesture.tabId || !!target && grid.contains(target);
      if (gesture.tabId || !gesture.valid) {
        gesture.preview = gesture.items;
      } else {
        const card = target?.closest<HTMLElement>('[data-board-widget]');
        gesture.preview = previewDrag(gesture.preview, gesture.name, {
          name: card?.dataset.boardWidget,
          x: Math.floor((event.clientX - bounds.left - GRID_PADDING) / (columnWidth + BOARD_GRID_GAP)),
          y: Math.floor((event.clientY - bounds.top - GRID_PADDING) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP)),
        });
      }
    }
    setPreview({ ...gesture });
    return gesture;
  }

  function cancelGesture() {
    gestureRef.current = null;
    setPreview(null);
  }

  function finishGesture(event: PointerEvent) {
    if (event.pointerId !== gestureRef.current?.pointerId) return;
    const gesture = updateGesture(event);
    cancelGesture();
    if (!gesture || !gesture.valid) return;
    const item = gesture.preview.find((candidate) => candidate.name === gesture.name);
    const original = gesture.items.find((candidate) => candidate.name === gesture.name);
    if (!item || !original) return;
    if (gesture.mode === 'resize') {
      if (item.w !== gesture.w || item.h !== gesture.h) void mutate([{ kind: 'widget_resize', name: gesture.name, sizeW: item.w, sizeH: item.h, heightMode: 'fixed' }]);
    } else if (gesture.tabId || item.order !== original.order) {
      void mutate([{ kind: 'widget_move', name: gesture.name, ...(gesture.tabId ? { tabId: gesture.tabId } : { position: item.order }) }]);
    }
  }

  function nudgeWidget(widget: BoardWidget, direction: 'left' | 'right' | 'up' | 'down') {
    if (busy) return;
    const moved = nudge(items, widget.name, direction).find((item) => item.name === widget.name);
    const original = items.find((item) => item.name === widget.name);
    if (moved && original && moved.order !== original.order) void mutate([{ kind: 'widget_move', name: widget.name, position: moved.order }]);
  }

  function handleKeyDown(widget: BoardWidget, event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Escape') { cancelGesture(); return; }
    const directions: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault();
    if (event.altKey) { nudgeWidget(widget, direction); return; }
    const index = ordered.findIndex((item) => item.name === widget.name);
    const target = ordered[Math.max(0, Math.min(ordered.length - 1, index + (direction === 'left' || direction === 'up' ? -1 : 1)))];
    Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-board-widget]') ?? []).find((element) => element.dataset.boardWidget === target?.name)?.focus();
  }

  return <div ref={gridRef} role="list" aria-label={t('board.gridLabel', { defaultValue: 'Board widgets' })} className="matcha-board-grid grid min-w-0 p-3" style={{ padding: GRID_PADDING, gridTemplateColumns: `repeat(${BOARD_GRID_COLUMNS}, minmax(0, 1fr))`, gridAutoRows: BOARD_GRID_ROW_HEIGHT, gap: BOARD_GRID_GAP }} onPointerMove={updateGesture} onPointerUp={finishGesture} onPointerCancel={(event) => { if (event.pointerId === gestureRef.current?.pointerId) cancelGesture(); }} onLostPointerCapture={(event) => { if (event.pointerId === gestureRef.current?.pointerId) cancelGesture(); }} onKeyDown={(event) => { if (event.key === 'Escape' && gestureRef.current) { event.preventDefault(); cancelGesture(); } }}>
    {/* Keep DOM order independent of native position: moving an iframe node reloads it. */}
    {[...widgets].sort((a, b) => a.name.localeCompare(b.name)).map((widget) => {
      const rect = byName.get(widget.name);
      if (!rect) return null;
      return <BoardWidgetCell key={`${identityKey}:${widgetKey(widget)}`} identity={identity} widget={widget} rect={rect} tabs={tabs} logicalIndex={ordered.indexOf(widget)} count={ordered.length} busy={busy} dragging={activePreview?.name === widget.name} contentHeight={heights[widgetKey(widget)]} reportHeight={reportHeight} submit={submit} mutate={mutate} onEdit={onEdit} onRemove={onRemove} onRefresh={onRefresh} onSendMessage={onSendMessage} onOpenLink={onOpenLink} onNudge={nudgeWidget} onGesture={beginGesture} onKeyDown={handleKeyDown} />;
    })}
  </div>;
}

function BoardWidgetCell({ identity, widget, rect, tabs, logicalIndex, count, busy, dragging, contentHeight, reportHeight, submit, mutate, onEdit, onRemove, onRefresh, onSendMessage, onOpenLink, onNudge, onGesture, onKeyDown }: {
  identity: BoardIdentity;
  widget: BoardWidget;
  rect: BoardGridRect;
  tabs: readonly BoardTab[];
  logicalIndex: number;
  count: number;
  busy: boolean;
  dragging: boolean;
  contentHeight?: number;
  reportHeight: (key: string, height: number) => void;
  submit: BoardGridProps['submit'];
  mutate: BoardGridProps['mutate'];
  onEdit: BoardGridProps['onEdit'];
  onRemove: BoardGridProps['onRemove'];
  onRefresh: BoardGridProps['onRefresh'];
  onSendMessage?: BoardGridProps['onSendMessage'];
  onOpenLink?: BoardGridProps['onOpenLink'];
  onNudge: (widget: BoardWidget, direction: 'up' | 'down') => void;
  onGesture: (mode: Gesture['mode'], widget: BoardWidget, event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (widget: BoardWidget, event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation('chat');
  const fenceKey = widgetKey(widget);
  const reportContentHeight = useCallback((height: number) => reportHeight(fenceKey, height), [fenceKey, reportHeight]);
  const needsGrant = widget.grantState === 'pending' || widget.grantState === 'rejected';
  const declaredTools = widget.declared?.tools ?? [];
  const declaredOrigins = widget.declared?.netOrigins ?? [];
  const grant = (decision: 'granted' | 'rejected') => {
    if (widget.instanceId) void submit({ method: 'board.widget.grant', name: widget.name, revision: widget.revision, instanceId: widget.instanceId, decision });
  };
  const resizeTo = (w: number, h: number) => void mutate([{ kind: 'widget_resize', name: widget.name, sizeW: w, sizeH: h, heightMode: 'fixed' }]);
  const autoHeight = !dragging ? exactBoardWidgetHeightPx(widget, contentHeight, CHROME_HEIGHT) : undefined;
  return <div role="listitem" aria-posinset={logicalIndex + 1} aria-setsize={count} tabIndex={0} aria-label={widget.title || widget.name} aria-describedby={`board-widget-help-${widget.name}`} data-board-widget={widget.name} className={cn('matcha-board-widget relative flex min-h-0 min-w-0 flex-col self-start overflow-hidden rounded-xl border border-border/70 bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring/40', dragging && 'z-10 border-ring/60 shadow-elevated')} style={{ '--board-widget-rows': rect.h, '--board-widget-order': logicalIndex, gridColumn: `${rect.x + 1} / span ${rect.w}`, gridRow: `${rect.y + 1} / span ${rect.h}`, height: autoHeight === undefined ? '100%' : Math.min(autoHeight, rect.h * BOARD_GRID_ROW_HEIGHT + (rect.h - 1) * BOARD_GRID_GAP) } as CSSProperties} onKeyDown={(event) => onKeyDown(widget, event)}>
    <div className="flex h-[38px] shrink-0 items-center gap-1 border-b border-border/40 px-1.5">
      <button type="button" className="touch-none rounded p-1 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-40" disabled={busy} aria-label={t('board.widget.drag', { defaultValue: 'Move widget. Alt + arrow keys reorders.' })} onPointerDown={(event) => onGesture('move', widget, event)} onKeyDown={(event) => {
        if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'ArrowDown' || event.key === 'ArrowRight')) { event.preventDefault(); onNudge(widget, event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? 'up' : 'down'); }
      }}><GripVertical className="h-3.5 w-3.5" /></button>
      <span className="min-w-0 flex-1 truncate text-xs font-medium" title={widget.title || widget.name}>{widget.title || widget.name}</span>
      {widget.grantState === 'granted' && <ShieldCheck className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t('board.widget.granted', { defaultValue: 'Native grant approved' })} />}
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t('board.widget.menuLabel', { defaultValue: 'Widget menu' })}><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="max-h-[70vh] overflow-y-auto">
        <DropdownMenuItem disabled={busy} onSelect={() => onEdit(widget)}><Pencil className="h-3.5 w-3.5" />{t('board.widget.replaceContent', { defaultValue: 'Replace content' })}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || logicalIndex === 0} onSelect={() => onNudge(widget, 'up')}><ArrowUp className="h-3.5 w-3.5" />{t('board.widget.moveEarlier', { defaultValue: 'Move earlier' })}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || logicalIndex === count - 1} onSelect={() => onNudge(widget, 'down')}><ArrowDown className="h-3.5 w-3.5" />{t('board.widget.moveLater', { defaultValue: 'Move later' })}</DropdownMenuItem>
        {tabs.length > 1 && <><DropdownMenuSeparator /><DropdownMenuLabel>{t('board.widget.moveToTab', { defaultValue: 'Move to tab' })}</DropdownMenuLabel>{tabs.filter((tab) => tab.tabId !== widget.tabId).map((tab) => <DropdownMenuItem key={tab.tabId} disabled={busy} onSelect={() => void mutate([{ kind: 'widget_move', name: widget.name, tabId: tab.tabId }])}>{tab.title}</DropdownMenuItem>)}</>}
        <DropdownMenuSeparator /><DropdownMenuLabel>{t('board.widget.resize', { defaultValue: 'Resize' })}</DropdownMenuLabel>
        {SIZE_PRESETS.map((size) => <DropdownMenuItem key={size.w} disabled={busy} onSelect={() => resizeTo(size.w, size.h)}>{size.w} × {size.h}</DropdownMenuItem>)}
        {widget.contentKind === 'html' && <DropdownMenuItem disabled={busy} onSelect={() => void mutate([{ kind: 'widget_resize', name: widget.name, sizeW: widget.sizeW, sizeH: effectiveBoardWidgetRows(widget, contentHeight, CHROME_HEIGHT), heightMode: widget.heightMode === 'fixed' ? 'auto' : 'fixed' }])}>{t(widget.heightMode === 'fixed' ? 'board.widget.autoHeight' : 'board.widget.fixHeight', { defaultValue: widget.heightMode === 'fixed' ? 'Fit content height' : 'Fix current height' })}</DropdownMenuItem>}
        <DropdownMenuItem disabled={busy} onSelect={() => void onRefresh()}><RefreshCw className="h-3.5 w-3.5" />{t('board.widget.refresh', { defaultValue: 'Refresh native view' })}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="space-y-1 px-2.5 py-2 text-[10px] text-muted-foreground"><p>{widget.name} · r{widget.revision}</p>{widget.instanceId && <p className="max-w-64 break-all">{t('board.widget.instance', { defaultValue: 'Instance' })}: {widget.instanceId}</p>}<p>{t('board.widget.grantState', { defaultValue: 'Grant' })}: {t(`board.grant.${widget.grantState}`, { defaultValue: widget.grantState })}</p>{[...declaredTools, ...declaredOrigins, ...(widget.declaredSummary ?? [])].map((capability, index) => <p key={`${index}:${capability}`} className="max-w-64 break-words">{capability}</p>)}</div>
        <DropdownMenuItem className="text-destructive" disabled={busy} onSelect={() => onRemove(widget)}><Trash2 className="h-3.5 w-3.5" />{t('board.widget.remove', { defaultValue: 'Remove widget' })}</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
    </div>
    <span id={`board-widget-help-${widget.name}`} className="sr-only">{t('board.widget.keyboardHelp', { defaultValue: 'Arrow keys focus widgets. Alt + arrow keys reorders. Use the resize handle or the menu to change size.' })}</span>
    <div className={cn('min-h-0 flex-1 overflow-auto', (widget.presentation ?? 'card') === 'card' && 'p-3')}>
      {needsGrant ? <div className="flex min-h-full flex-col items-start justify-center gap-3 p-3 text-xs">
        <div className="flex items-center gap-2"><ShieldX className="h-4 w-4 text-muted-foreground" /><strong>{t(widget.grantState === 'rejected' ? 'board.widget.rejected' : 'board.widget.pending', { defaultValue: widget.grantState === 'rejected' ? 'Widget permission rejected' : 'Widget needs your permission' })}</strong></div>
        <p className="text-muted-foreground">{t('board.widget.grantHint', { defaultValue: 'This decision applies only to this native revision and instance.' })} r{widget.revision}</p>
        {declaredOrigins.length > 0 && <div><strong className="font-medium">{t('board.widget.networkOrigins', { defaultValue: 'Network origins' })}</strong>{declaredOrigins.map((origin) => <p key={origin} className="break-all text-muted-foreground">{origin}</p>)}</div>}
        {declaredTools.length > 0 && <div><strong className="font-medium">{t('board.widget.tools', { defaultValue: 'Tools and data' })}</strong>{declaredTools.map((tool) => <p key={tool} className="break-all text-muted-foreground">{tool}</p>)}</div>}
        {widget.declaredSummary?.map((summary, index) => <p key={index} className="break-words text-muted-foreground">{summary}</p>)}
        {widget.instanceId ? <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => grant('granted')}>{t(widget.grantState === 'rejected' ? 'board.widget.allowAgain' : 'board.widget.allow', { defaultValue: widget.grantState === 'rejected' ? 'Allow this revision' : 'Allow' })}</Button>{widget.grantState === 'pending' && <Button variant="outline" size="sm" disabled={busy} onClick={() => grant('rejected')}>{t('board.widget.reject', { defaultValue: 'Reject' })}</Button>}</div> : <Button variant="outline" size="sm" disabled={busy} onClick={() => void onRefresh()}>{t('board.widget.refreshFence', { defaultValue: 'Refresh before granting' })}</Button>}
      </div> : <RuntimeContentHost source={{ kind: 'board', identity, widget }} onSendMessage={onSendMessage} onOpenLink={onOpenLink} onRefresh={onRefresh} onHeightChange={reportContentHeight} className="h-full min-h-0 w-full" />}
    </div>
    <button type="button" aria-label={t('board.widget.resizeHandle', { defaultValue: 'Resize widget. Arrow keys adjust size.' })} disabled={busy} className="absolute bottom-0 right-0 h-5 w-5 touch-none cursor-se-resize rounded-tl-md text-muted-foreground/60 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 disabled:opacity-40" onPointerDown={(event) => onGesture('resize', widget, event)} onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const width = Math.max(1, Math.min(12, widget.sizeW + (event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0)));
      const height = Math.max(1, Math.min(20, rect.h + (event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0)));
      if (width !== widget.sizeW || height !== rect.h) resizeTo(width, height);
    }}><svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true"><path d="M5 13 13 5M9 13l4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button>
  </div>;
}
