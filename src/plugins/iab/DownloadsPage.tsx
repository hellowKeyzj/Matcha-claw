import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, MoreHorizontal, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import * as Popover from '@radix-ui/react-popover';
import type { IabDownload, IabDownloadCommand } from '@/types/desktop/iab';
import { iabCommand, IabProjectionDiscarded, onIabEvent } from './store';
import { IabConfirmation } from './IabConfirmation';
import { DownloadIcon } from './DownloadIcon';

function formatBytes(bytes: number, language: string) {
  const scale = Math.min(3, Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024)));
  return new Intl.NumberFormat(language, { style: 'unit', unit: ['byte', 'kilobyte', 'megabyte', 'gigabyte'][scale], unitDisplay: scale ? 'short' : 'long', maximumFractionDigits: scale ? 1 : 0 }).format(bytes / 1024 ** scale);
}

function DownloadRow({ entry, busy, onAction }: { entry: IabDownload; busy: boolean; onAction: (command: IabDownloadCommand) => void }) {
  const { t, i18n } = useTranslation('iab');
  const [menuOpen, setMenuOpen] = useState(false);
  const perform = (command: IabDownloadCommand) => { setMenuOpen(false); onAction(command); };
  const active = entry.status === 'progressing' || entry.status === 'paused' || entry.canResume === true;
  const status = entry.fileMissing ? t('missing') : active ? `${t(entry.status)} · ${formatBytes(entry.receivedBytes, i18n.language)}${entry.totalBytes > 0 ? ` / ${formatBytes(entry.totalBytes, i18n.language)}` : ''}` : entry.status === 'completed' ? null : t(entry.status);
  return <li className="flex items-center gap-3 py-2.5">
    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><DownloadIcon name="description" size={21} /></span>
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button type="button" disabled={entry.status !== 'completed' || entry.fileMissing || busy} title={entry.fileMissing ? t('missingDescription') : entry.filename} onClick={() => perform({ action: 'open', id: entry.id })}
        className={`min-w-0 truncate rounded text-left text-sm outline-none enabled:hover:underline focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default ${entry.fileMissing ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{entry.filename}</button>
      {status && <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">{status}</span>}
    </div>
    <time dateTime={new Date(entry.startedAt).toISOString()} className="shrink-0 whitespace-nowrap text-[13px] tabular-nums text-muted-foreground">{new Intl.DateTimeFormat(i18n.language, { hour: '2-digit', minute: '2-digit' }).format(entry.startedAt)}</time>
    {entry.status === 'completed' && !entry.fileMissing && <button type="button" className="iab-icon" disabled={busy} aria-label={t('showInFolderLabel', { filename: entry.filename })} title={t('showInFolder')} onClick={() => perform({ action: 'show-in-folder', id: entry.id })}><DownloadIcon name="folder" size={18} /></button>}
    {!active ? <button type="button" className="iab-icon" disabled={busy} aria-label={t('removeDownload', { filename: entry.filename })} title={t('remove')} onClick={() => perform({ action: 'remove', id: entry.id })}><DownloadIcon name="close" size={18} /></button>
      : <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}><Popover.Trigger asChild><button type="button" className="iab-icon" disabled={busy} aria-label={t('downloadMore', { filename: entry.filename })} title={t('more')}><MoreHorizontal aria-hidden="true" className="h-[18px] w-[18px]" /></button></Popover.Trigger>
        <Popover.Portal><Popover.Content side="bottom" align="end" sideOffset={4} collisionPadding={12} aria-label={t('downloadMore', { filename: entry.filename })} aria-describedby={undefined} className="z-50 w-44 rounded-xl border border-border bg-card p-1 text-foreground shadow-elevated outline-none">
          <button type="button" className="h-9 w-full rounded-md px-3 text-left text-sm font-normal hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => perform({ action: entry.status === 'progressing' ? 'pause' : 'resume', id: entry.id })}>{t(entry.status === 'progressing' ? 'pause' : 'resume')}</button>
          <button type="button" className="h-9 w-full rounded-md px-3 text-left text-sm font-normal hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => perform({ action: 'cancel', id: entry.id })}>{t('cancel')}</button>
        </Popover.Content></Popover.Portal>
      </Popover.Root>}
  </li>;
}

export function DownloadsPage({ visible }: { visible: boolean }) {
  const { t, i18n } = useTranslation('iab');
  const [entries, setEntries] = useState<IabDownload[]>([]);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(new Map<string, boolean>());
  const [limits, setLimits] = useState(new Map<string, number>());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const request = useRef(0);
  const actionRunning = useRef(false);
  const refresh = useRef<(files?: boolean) => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    let inflight: Promise<void> | null = null;
    let pending = false;
    let refreshFiles = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastEntries: IabDownload[] = [];
    const schedule = () => {
      clearTimeout(timer);
      if (alive && visible && !document.hidden && lastEntries.some((entry) => entry.status === 'progressing')) timer = setTimeout(() => { void load(); }, 1000);
    };
    const load = (files = false): Promise<void> => {
      if (!alive || !visible || document.hidden) return Promise.resolve();
      refreshFiles ||= files;
      if (inflight) { pending = true; request.current++; return inflight; }
      clearTimeout(timer);
      inflight = (async () => {
        do {
          pending = false;
          const current = ++request.current;
          const checkFiles = refreshFiles; refreshFiles = false;
          try {
            const result = await iabCommand({ action: 'downloads-list', refreshFileState: checkFiles });
            if (!alive || current !== request.current || pending || result.resultType !== 'downloads') continue;
            lastEntries = result.entries; setEntries(result.entries); setError(false);
          } catch (error) { if (alive && current === request.current && !pending && !(error instanceof IabProjectionDiscarded)) setError(true); }
          finally { if (alive && current === request.current && !pending) setLoading(false); }
        } while (alive && pending && visible && !document.hidden);
      })().finally(() => { inflight = null; schedule(); });
      return inflight;
    };
    refresh.current = load;
    const wake = () => { clearTimeout(timer); if (!document.hidden) void load(true); };
    const unsubscribe = onIabEvent((event) => { if (event.type === 'downloads-changed') void load(); });
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    void load(true);
    return () => { alive = false; mounted.current = false; clearTimeout(timer); unsubscribe(); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, [visible]);
  const runAction = useCallback(async (command: IabDownloadCommand | 'clear') => {
    if (actionRunning.current) return;
    actionRunning.current = true; setBusy(true); setError(false);
    request.current++;
    try {
      await iabCommand(command === 'clear' ? { action: 'downloads-clear' } : { action: 'download', command });
      if (!mounted.current) return;
      if (command === 'clear') setConfirmation(false);
      await refresh.current(true);
    } catch (error) { if (mounted.current && !(error instanceof IabProjectionDiscarded)) setError(true); }
    finally { actionRunning.current = false; if (mounted.current) setBusy(false); }
  }, []);
  const groups = useMemo(() => {
    const text = query.trim().toLocaleLowerCase(i18n.language);
    const days = new Map<string, IabDownload[]>();
    for (const entry of entries) {
      if (text && !entry.filename.toLocaleLowerCase(i18n.language).includes(text)) continue;
      const day = new Date(entry.startedAt).toDateString();
      const rows = days.get(day) ?? []; rows.push(entry); days.set(day, rows);
    }
    return [...days];
  }, [entries, query, i18n.language]);
  const date = useMemo(() => new Intl.DateTimeFormat(i18n.language, { year: 'numeric', month: 'long', day: 'numeric' }), [i18n.language]);
  const canClear = entries.some((entry) => entry.status !== 'progressing' && entry.status !== 'paused' && !entry.canResume);
  return <section data-browser-chrome aria-label={t('downloadHistory')} className="h-full overflow-y-auto bg-card text-foreground" style={{ scrollbarGutter: 'stable' }}
    onKeyDown={(event) => { if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); input.current?.focus(); } }}>
    <div className="mx-auto max-w-[1000px] px-5 py-10 sm:px-8">
      <h1 className="mb-8 text-2xl font-semibold">{t('downloadHistory')}</h1>
      <div role="search" className="flex h-10 items-center gap-2 rounded-full border border-border/70 px-3 focus-within:ring-1 focus-within:ring-ring"><Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input ref={input} data-iab-internal-search value={query} maxLength={1000} onChange={(event) => { setQuery(event.target.value); setLimits(new Map()); }} aria-label={t('downloadSearch')} placeholder={t('downloadSearch')} className="iab-field flex-1" />
        {query && <button type="button" className="iab-icon" aria-label={t('clearSearch')} onClick={() => { setQuery(''); setLimits(new Map()); input.current?.focus(); }}><X aria-hidden="true" className="h-3.5 w-3.5" /></button>}
      </div>
      <div className="mb-4 mt-7 flex min-h-9 flex-wrap items-center justify-between gap-2"><h2 className="text-[13px] font-medium">{t('range0')}</h2><button type="button" className="iab-action bg-secondary" disabled={!canClear || loading || busy} onClick={() => setConfirmation(true)}>{t('clearDownloads')}</button></div>
      {error && !confirmation && <div role="alert" className="mb-4 flex items-center justify-between gap-3 text-xs text-destructive">{t('failed')}<button type="button" className="iab-action" onClick={() => void refresh.current(true)}>{t('retry')}</button></div>}
      {loading ? <p role="status" className="py-16 text-center text-[13px] text-muted-foreground">{t('loading')}</p> : groups.length ? <div className="space-y-6">{groups.map(([day, rows], index) => {
        const isExpanded = !!query || (expanded.get(day) ?? index === 0);
        const limit = limits.get(day) ?? 20;
        return <div key={day} className="overflow-hidden rounded-xl border border-border/60">
          <button type="button" aria-expanded={isExpanded} onClick={() => setExpanded((previous) => new Map(previous).set(day, !isExpanded))} className="flex h-12 w-full items-center justify-between px-4 text-sm font-medium hover:bg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring">{date.format(rows[0].startedAt)}<ChevronDown aria-hidden="true" className={`h-4 w-4 text-muted-foreground transition-transform motion-reduce:transition-none ${isExpanded ? 'rotate-180' : ''}`} /></button>
          {isExpanded && <><ul className="mx-4 divide-y divide-border/30 border-t border-border/40">{rows.slice(0, limit).map((entry) => <DownloadRow key={entry.id} entry={entry} busy={busy} onAction={(command) => void runAction(command)} />)}</ul>{rows.length > limit && <div className="mx-4 border-t border-border/40 py-3 text-center"><button type="button" className="iab-action" onClick={() => setLimits((previous) => new Map(previous).set(day, limit + 20))}>{t('loadMore')}</button></div>}</>}
        </div>;
      })}</div> : <p role="status" className="py-16 text-center text-[13px] text-muted-foreground">{t(query ? 'noResults' : 'downloadsEmpty')}</p>}
    </div>
    <IabConfirmation open={confirmation} title={t('clearDownloads')} message={t('clearDownloadsDescription')} confirmLabel={t('clearDownloads')} onConfirm={() => runAction('clear')} onCancel={() => { if (!busy) setConfirmation(false); }} error={error} />
  </section>;
}
