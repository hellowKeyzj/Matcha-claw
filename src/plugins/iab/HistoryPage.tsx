import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Globe, History, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as Popover from '@radix-ui/react-popover';
import type { IabHistoryEntry, IabHistoryPage } from '@/types/desktop/iab';
import { iabCommand, IabProjectionDiscarded, onIabEvent, reportIabError } from './store';
import { IabConfirmation } from './IabConfirmation';

export function HistoryPage({ tabId, visible }: { tabId: string; visible: boolean }) {
  const { t, i18n } = useTranslation('iab');
  const [page, setPage] = useState<IabHistoryPage>({ entries: [], total: 0, nextOffset: null });
  const { entries, nextOffset } = page;
  const [query, setQuery] = useState('');
  const [range, setRange] = useState(0);
  const [selected, setSelected] = useState(new Set<string>());
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirmation, setConfirmation] = useState<string[] | 'all' | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const actionRunning = useRef(false);
  const projection = useRef(page);
  const filters = useRef({ query, range });
  const active = useRef<{ query: string; range: number; from?: number } | null>(null);
  const inflight = useRef<Promise<void> | null>(null);
  const pending = useRef<'refresh' | 'more' | null>(null);
  const load = useCallback(function load(more = false): Promise<void> {
    if (!active.current || document.hidden) return Promise.resolve();
    if (more && (projection.current.nextOffset === null || projection.current.nextOffset >= 3_000)) return Promise.resolve();
    if (more && inflight.current) return inflight.current;
    if (pending.current !== 'refresh') pending.current = more ? 'more' : 'refresh';
    request.current++;
    setLoading(true);
    if (inflight.current) return inflight.current;
    inflight.current = (async () => {
      while (pending.current && active.current && !document.hidden) {
        const mode = pending.current; pending.current = null;
        const context = active.current;
        const current = request.current;
        const offset = mode === 'more' ? projection.current.nextOffset : 0;
        if (offset === null || offset >= 3_000) continue;
        if (mode === 'refresh') {
          const from = new Date();
          from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - Math.max(0, context.range - 1));
          context.from = context.range ? from.getTime() : undefined;
        }
        const limit = Math.min(3_000 - offset, mode === 'more' ? 50 : Math.max(50, projection.current.entries.length));
        try {
          const result = await iabCommand({ action: 'history-query', query: { query: context.query, from: context.from, offset, limit } });
          if (active.current !== context || document.hidden || current !== request.current || result.resultType !== 'history') continue;
          projection.current = { ...result.page, entries: offset ? [...projection.current.entries, ...result.page.entries] : result.page.entries,
            nextOffset: result.page.nextOffset !== null && result.page.nextOffset < 3_000 ? result.page.nextOffset : null };
          setPage(projection.current); setError(false);
          if (!offset) {
            const ids = new Set(result.page.entries.map((entry) => entry.id));
            setSelected((previous) => new Set([...previous].filter((id) => ids.has(id))));
          }
        } catch (error) { if (active.current === context && !document.hidden && current === request.current && !(error instanceof IabProjectionDiscarded)) setError(true); }
        finally { if (active.current === context && !document.hidden && current === request.current && !pending.current) setLoading(false); }
      }
    })().finally(() => {
      inflight.current = null;
      if (pending.current) void load(pending.current === 'more');
    });
    return inflight.current;
  }, []);
  useLayoutEffect(() => {
    const invalidate = () => { request.current++; pending.current = null; };
    active.current = visible ? { query, range } : null;
    invalidate();
    if (!visible) { setConfirmation(null); return; }
    if (filters.current.query !== query || filters.current.range !== range) {
      filters.current = { query, range };
      projection.current = { entries: [], total: 0, nextOffset: null };
      setPage(projection.current);
    }
    setBusy(actionRunning.current);
    const unsubscribe = onIabEvent((event) => { if (event.type === 'history-changed') void load(); });
    const wake = () => { invalidate(); if (!document.hidden) { setBusy(actionRunning.current); void load(); } };
    document.addEventListener('visibilitychange', wake);
    void load();
    return () => { active.current = null; invalidate(); unsubscribe(); document.removeEventListener('visibilitychange', wake); };
  }, [visible, query, range, load]);
  const favicons = useMemo(() => {
    const origins = new Map<string, string>();
    for (const entry of entries) {
      const origin = new URL(entry.url).origin;
      if (entry.faviconUrl && !origins.has(origin)) origins.set(origin, entry.faviconUrl);
    }
    return origins;
  }, [entries]);
  const groups = useMemo(() => {
    const days = new Map<string, IabHistoryEntry[]>();
    for (const entry of entries) {
      const day = new Date(entry.visitedAt).toDateString();
      const rows = days.get(day) ?? []; rows.push(entry); days.set(day, rows);
    }
    return [...days];
  }, [entries]);
  const date = useMemo(() => new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' }), [i18n.language]);
  const time = useMemo(() => new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }), [i18n.language]);
  const remove = async () => {
    const context = active.current;
    if (!context || document.hidden || !confirmation || actionRunning.current) return;
    actionRunning.current = true; setBusy(true); setError(false);
    try {
      await iabCommand({ action: 'history-remove', ids: confirmation });
      if (!active.current || document.hidden) return;
      if (active.current === context) setConfirmation((current) => current === confirmation ? null : current);
      await load();
    } catch (error) { if (active.current === context && !document.hidden && !(error instanceof IabProjectionDiscarded)) setError(true); }
    finally { actionRunning.current = false; if (active.current && !document.hidden) setBusy(false); }
  };
  return <section data-browser-chrome aria-label={t('history')} className="h-full overflow-y-auto bg-card text-foreground" style={{ scrollbarGutter: 'stable' }}
    onKeyDown={(event) => { if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); input.current?.focus(); } }}>
    <div className="mx-auto max-w-[1000px] px-5 py-8 sm:px-8">
      <div className="mb-7 flex items-center gap-3"><History aria-hidden="true" className="h-5 w-5 text-muted-foreground" /><h1 className="text-xl font-semibold">{t('history')}</h1></div>
      <div role="search" className="flex h-10 items-center gap-2 rounded-xl border border-border/70 px-3 focus-within:ring-1 focus-within:ring-ring">
        <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input ref={input} data-iab-internal-search value={query} maxLength={1000} aria-label={t('historySearch')} placeholder={t('historySearch')}
          onChange={(event) => { setQuery(event.target.value); setSelected(new Set()); }} className="iab-field flex-1" />
        {query && <button type="button" className="iab-icon" aria-label={t('clearSearch')} onClick={() => { setQuery(''); setSelected(new Set()); input.current?.focus(); }}><X aria-hidden="true" className="h-3.5 w-3.5" /></button>}
        <Popover.Root><Popover.Trigger asChild><button type="button" className="iab-icon data-[state=open]:bg-secondary" aria-label={t('filter')} title={t('filter')}><SlidersHorizontal aria-hidden="true" className="h-4 w-4" /></button></Popover.Trigger>
          <Popover.Portal><Popover.Content align="end" sideOffset={6} collisionPadding={12} aria-label={t('filter')} aria-describedby={undefined} className="z-50 w-44 rounded-xl border border-border/70 bg-card p-1.5 text-foreground shadow-elevated outline-none">
            {[0, 1, 7, 30].map((days) => <Popover.Close key={days} asChild><button type="button" onClick={() => { setRange(days); setSelected(new Set()); }} aria-pressed={range === days} className={`h-9 w-full cursor-pointer rounded-lg px-3 text-left text-[13px] hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${range === days ? 'bg-secondary' : ''}`}>{t(`range${days}`)}</button></Popover.Close>)}
          </Popover.Content></Popover.Portal>
        </Popover.Root>
      </div>
      <div className="mb-4 mt-7 flex min-h-9 flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-medium">{selected.size ? t('selected', { count: selected.size }) : t(`range${range}`)}</h2>
        <button type="button" className="iab-action flex h-8 items-center gap-2 bg-secondary" disabled={!entries.length || loading || busy} onClick={() => setConfirmation(selected.size ? [...selected] : 'all')}><Trash2 aria-hidden="true" className="h-3.5 w-3.5" />{t(selected.size ? 'deleteSelected' : 'clearHistory')}</button>
      </div>
      {error && <div role="alert" className="mb-4 flex items-center justify-between gap-3 text-xs text-destructive">{t('failed')}<button type="button" className="iab-action" onClick={() => void load()}>{t('retry')}</button></div>}
      {loading && !entries.length ? <p role="status" className="py-16 text-center text-[13px] text-muted-foreground">{t('loading')}</p> : entries.length ? <div className="space-y-6">{groups.map(([day, rows]) => <div key={day} className="space-y-2">
        <button type="button" aria-expanded={!collapsed.has(day) || !!query} onClick={() => setCollapsed((previous) => { const next = new Set(previous); if (next.has(day)) next.delete(day); else next.add(day); return next; })}
          className="flex h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">
          {date.format(rows[0].visitedAt)}<ChevronDown aria-hidden="true" className={`h-4 w-4 text-muted-foreground transition-transform motion-reduce:transition-none ${!collapsed.has(day) || query ? 'rotate-180' : ''}`} />
        </button>
        {(!collapsed.has(day) || query) && <div className="divide-y divide-border/30">{rows.map((entry) => {
          const url = new URL(entry.url);
          const favicon = entry.faviconUrl ?? favicons.get(url.origin);
          return <div key={entry.id} className="flex min-h-12 items-center gap-3 px-2 py-1.5 text-[13px] transition-colors hover:bg-secondary/60 focus-within:bg-secondary/60">
            <input type="checkbox" checked={selected.has(entry.id)} aria-label={t('selectEntry', { title: entry.title || entry.url })} onChange={() => setSelected((previous) => { const next = new Set(previous); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; })} className="h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary" />
            {favicon ? <img src={favicon} alt="" className="h-4 w-4 shrink-0 object-contain" /> : <Globe aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />}
            <button type="button" onClick={() => void iabCommand({ action: 'navigate', tabId, url: entry.url }).catch(reportIabError)} title={entry.url}
              className="min-w-0 flex-1 cursor-pointer truncate rounded px-0 py-1 text-left font-normal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><span className="min-w-0 truncate">{entry.title || url.hostname}<span className="ml-2 text-xs text-muted-foreground">{url.hostname}</span></span></button>
            <time dateTime={new Date(entry.visitedAt).toISOString()} className="shrink-0 text-xs tabular-nums text-muted-foreground">{time.format(entry.visitedAt)}</time>
            <button type="button" className="iab-icon" aria-label={t('deleteEntry', { title: entry.title || entry.url })} title={t('delete')} onClick={() => setConfirmation([entry.id])}><Trash2 aria-hidden="true" className="h-3.5 w-3.5" /></button>
          </div>;
        })}</div>}
      </div>)}</div> : <p role="status" className="py-16 text-center text-[13px] text-muted-foreground">{t(query || range ? 'noResults' : 'historyEmpty')}</p>}
      {nextOffset !== null && <div className="mt-5 text-center"><button type="button" className="iab-action" disabled={loading || busy} onClick={() => void load(true)}>{t(loading ? 'loading' : 'loadMore')}</button></div>}
    </div>
    <IabConfirmation open={confirmation !== null} title={t('deleteHistory')} message={t(confirmation === 'all' ? 'clearHistoryDescription' : 'deleteHistoryDescription')}
      confirmLabel={t('delete')} onConfirm={remove} onCancel={() => { if (!busy) setConfirmation(null); }} error={error} />
  </section>;
}
