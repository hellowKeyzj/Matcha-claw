import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Copy, ListChecks, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { CALL_MODULES, CALL_STATUSES } from '@/lib/call-log';
import { useCallsStore } from '@/stores/calls';
import type { CallModule, CallRecord, CallStatus } from '@/types/call-log';
import { callDuration, callFields, changedCallFields, isTechnicalField, type CallField } from './call-presentation';

function DetailValue({ value, technical = false }: { value: unknown; technical?: boolean }) {
  const { t } = useTranslation('common');
  if (value === null || value === undefined) return <span className="text-muted-foreground">{t('calls.cleared')}</span>;
  if (typeof value === 'boolean') return <>{t(value ? 'calls.yes' : 'calls.no')}</>;
  if (typeof value === 'string') return <>{technical ? value : t(`calls.values.${value}`, { defaultValue: value })}</>;
  if (typeof value === 'number') return <>{value}</>;
  if (Array.isArray(value)) return <ul className="space-y-2">{value.map((item, index) => <li key={index}><DetailValue value={item} technical={technical} /></li>)}</ul>;
  if (typeof value === 'object' && value) return <dl className="space-y-1">{Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => <div key={key}><dt className="text-muted-foreground">{t(`calls.fields.${key}`, { defaultValue: key })}</dt><dd><DetailValue value={item} technical={technical} /></dd></div>)}</dl>;
  throw new Error('Invalid decoded call detail');
}

function DetailFields({ fields }: { fields: CallField[] }) {
  const { t } = useTranslation('common');
  return <dl className="divide-y divide-border/50 text-sm">
    {fields.map((field) => <div key={field.path.join('.')} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 py-2.5">
      <dt className="break-words text-muted-foreground">{field.path.map((key) => t(`calls.fields.${key}`, { defaultValue: key })).join(' · ')}</dt>
      <dd className={`min-w-0 break-words font-medium ${isTechnicalField(field) ? 'break-all font-mono text-xs leading-5' : ''}`}><DetailValue value={field.value} technical={isTechnicalField(field)} /></dd>
    </div>)}
  </dl>;
}

function StatusBadge({ status }: { status: CallStatus }) {
  const { t } = useTranslation('common');
  const variant = status === 'succeeded' ? 'success' : status === 'failed' || status === 'rejected' ? 'destructive' : status === 'waiting' || status === 'unknown' ? 'warning' : 'secondary';
  return <Badge variant={variant}>{t(`calls.statuses.${status}`)}</Badge>;
}

export default function CallsPage() {
  const { t, i18n } = useTranslation('common');
  const { query, page, loading, error, selectedId, detail, history, detailLoading, historyLoading, detailError,
    loadPage, refresh, selectCall, loadMoreHistory, subscribe } = useCallsStore();
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const selectedButton = useRef<HTMLButtonElement | null>(null);
  const formatTime = (time: number) => new Date(time).toLocaleString(i18n.language);
  const operationName = (call: CallRecord) => t(`calls.commands.${call.command.replaceAll('.', '_')}`, { defaultValue: call.command });
  const moduleName = (module: CallModule) => t(`calls.modules.${module}`, { defaultValue: module });
  const selected = detail ?? page.items.find((call) => call.callId === selectedId);
  const fields = detail ? callFields(detail.detail) : [];
  const resultFields = fields.filter((field) => !isTechnicalField(field)).sort((a, b) => {
    const priority = ['diagnostic', 'error', 'failure', 'reason', 'outcome'];
    const rank = (field: CallField) => priority.includes(field.path[0]) ? priority.indexOf(field.path[0]) : priority.length;
    return rank(a) - rank(b);
  });
  const technicalFields = fields.filter(isTechnicalField);

  useEffect(() => {
    const unsubscribe = subscribe();
    void loadPage({ ...useCallsStore.getState().query, before: null });
    const selected = useCallsStore.getState().selectedId;
    if (selected) void selectCall(selected);
    return () => { unsubscribe(); void selectCall(null); };
  }, [loadPage, selectCall, subscribe]);

  const filter = (module: CallModule | null, status: CallStatus | null) => {
    setCursors([null]);
    void selectCall(null);
    void loadPage({ module, status, limit: 50 });
  };
  const nextPage = () => {
    if (!page.next) return;
    setCursors([...cursors, page.next]);
    void selectCall(null);
    void loadPage({ ...query, before: page.next });
  };
  const previousPage = () => {
    const previous = cursors.slice(0, -1);
    setCursors(previous);
    void selectCall(null);
    void loadPage({ ...query, before: previous[previous.length - 1] });
  };
  const copyId = async (callId: string) => {
    try { await navigator.clipboard.writeText(callId); toast.success(t('calls.copied')); }
    catch { toast.error(t('calls.copyFailed')); }
  };

  return (
    <div className="min-w-0 space-y-5 text-foreground">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{t('calls.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('calls.description')}</p>
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={refresh}>
          <RefreshCw className={`size-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
          {t('calls.refresh')}
        </Button>
      </header>
      <div className="flex flex-wrap gap-3">
        <label className="min-w-0 flex-1 text-xs text-muted-foreground sm:max-w-52">
          {t('calls.module')}
          <Select className="mt-1 h-10 text-sm" value={query.module ?? ''} onChange={(event) => filter(event.target.value as CallModule || null, query.status ?? null)}>
            <option value="">{t('calls.allModules')}</option>
            {CALL_MODULES.map((module) => <option key={module} value={module}>{moduleName(module)}</option>)}
          </Select>
        </label>
        <label className="min-w-0 flex-1 text-xs text-muted-foreground sm:max-w-48">
          {t('calls.status')}
          <Select className="mt-1 h-10 text-sm" value={query.status ?? ''} onChange={(event) => filter(query.module ?? null, event.target.value as CallStatus || null)}>
            <option value="">{t('calls.allStatuses')}</option>
            {CALL_STATUSES.map((status) => <option key={status} value={status}>{t(`calls.statuses.${status}`)}</option>)}
          </Select>
        </label>
      </div>
      {error && <p role="alert" className="text-sm text-destructive-foreground">{t('calls.loadFailed')}: {error}</p>}
      <div className="overflow-x-auto rounded-xl border border-border/60 bg-card" aria-busy={loading}>
        <table className="w-full text-left text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>{['operation', 'module', 'status', 'start', 'duration'].map((key) => <th key={key} className="whitespace-nowrap px-4 py-3 font-medium">{t(`calls.${key}`)}</th>)}</tr>
          </thead>
          <tbody>
            {page.items.map((call) => (
              <tr key={call.callId} className={`border-t border-border/50 hover:bg-muted/25 ${selectedId === call.callId ? 'bg-accent/50' : ''}`}>
                <td className="px-4 py-3">
                  <button type="button" className="group inline-flex items-center gap-2 rounded text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-haspopup="dialog" onClick={(event) => { selectedButton.current = event.currentTarget; void selectCall(call.callId); }}>
                    <span>{operationName(call)}</span>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
                  </button>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">{moduleName(call.module)}</td>
                <td className="px-4 py-3"><StatusBadge status={call.status} /></td>
                <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums">{formatTime(call.start)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums">{callDuration(call, i18n.language) ?? t('calls.inProgress')}</td>
              </tr>
            ))}
            {!page.items.length && <tr><td colSpan={5} className="px-4 py-10 text-center">
              {loading ? <span role="status" className="text-sm text-muted-foreground">{t('calls.loading')}</span> : <>
                <ListChecks className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden="true" />
                <p className="font-medium">{error ? t('calls.loadFailed') : t('calls.empty')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{error ? error : t('calls.emptyHint')}</p>
              </>}
            </td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-end gap-3">
        <Button variant="outline" size="sm" disabled={loading || cursors.length < 2} onClick={previousPage}>{t('calls.previous')}</Button>
        <span className="text-xs text-muted-foreground">{t('calls.page', { page: cursors.length })}</span>
        <Button variant="outline" size="sm" disabled={loading || !page.next} onClick={nextPage}>{t('calls.next')}</Button>
      </div>
      <Sheet open={selectedId !== null} onOpenChange={(open) => { if (!open) void selectCall(null); }}>
        <SheetContent showCloseButton={false} className="flex w-full flex-col gap-0 bg-card p-0 sm:max-w-[560px] motion-reduce:!animate-none motion-reduce:!transition-none" onCloseAutoFocus={(event) => { event.preventDefault(); selectedButton.current?.focus(); }}>
          <header className="shrink-0 border-b border-border/60 px-6 py-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <SheetDescription className="mb-1 text-xs">{t('calls.detail')}</SheetDescription>
                <SheetTitle className="break-words text-xl">{selected ? operationName(selected) : t('calls.loading')}</SheetTitle>
              </div>
              <SheetClose asChild><Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t('calls.close')}><X className="size-4" /></Button></SheetClose>
            </div>
            {selected && <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <StatusBadge status={selected.status} />
              <span>{moduleName(selected.module)}</span>
              <span>{t('calls.duration')}: {callDuration(selected, i18n.language) ?? t('calls.inProgress')}</span>
            </div>}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" aria-busy={detailLoading}>
            {detailLoading && !detail && <div role="status" className="space-y-3"><span className="sr-only">{t('calls.loading')}</span>{[1, 2, 3].map((line) => <div key={line} className="h-9 animate-pulse rounded bg-muted motion-reduce:animate-none" />)}</div>}
            {detailError && <div role="alert" className="mb-5 space-y-3 text-sm"><p>{t('calls.loadFailed')}: {detailError}</p><Button variant="outline" size="sm" disabled={detailLoading} onClick={() => void selectCall(selectedId)}>{t('calls.retry')}</Button></div>}
            {detail && <div className="space-y-7">
              <section>
                <h3 className="mb-2 text-sm font-semibold">{t('calls.result')}</h3>
                {resultFields.length ? <DetailFields fields={resultFields} /> : <p className="text-sm text-muted-foreground">{t('calls.noDetails')}</p>}
              </section>
              <section>
                <h3 className="text-sm font-semibold">{t('calls.history')}</h3>
                <ol className="mt-4 space-y-5">
                  {history.items.map((transition, index) => {
                    const changed = changedCallFields(history.items[index - 1]?.detail, transition.detail).filter((field) => !isTechnicalField(field));
                    return <li key={transition.revision} className="relative pl-6">
                      <span className="absolute left-0 top-2 size-2 rounded-full bg-border" aria-hidden="true" />
                      {index < history.items.length - 1 && <span className="absolute bottom-[-20px] left-[3px] top-5 w-px bg-border/60" aria-hidden="true" />}
                      <div className="flex flex-wrap items-center justify-between gap-2"><StatusBadge status={transition.status} /><time dateTime={new Date(transition.at).toISOString()} className="text-xs tabular-nums text-muted-foreground">{formatTime(transition.at)}</time></div>
                      {changed.length > 0 && <DetailFields fields={changed} />}
                    </li>;
                  })}
                </ol>
                {!history.items.length && <p className="mt-3 text-sm text-muted-foreground">{t('calls.historyEmpty')}</p>}
                {history.next !== null && <Button variant="outline" size="sm" className="mt-4" disabled={historyLoading || detailLoading} onClick={() => void loadMoreHistory()}>{historyLoading ? t('calls.loading') : t('calls.moreHistory')}</Button>}
              </section>
              <details className="border-t border-border/60 pt-4">
                <summary className="cursor-pointer rounded text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('calls.technical')}</summary>
                <div className="mt-3">
                  <div className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0"><p className="mb-1 text-xs text-muted-foreground">{t('calls.callId')}</p><p className="break-all font-mono text-xs leading-5">{detail.callId}</p></div>
                    <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => void copyId(detail.callId)} aria-label={t('calls.copyId')}><Copy className="size-4" /></Button>
                  </div>
                  <DetailFields fields={[
                    { path: ['command'], value: detail.command },
                    { path: ['revision'], value: detail.revision },
                    { path: ['start'], value: formatTime(detail.start) },
                    ...(detail.end === null ? [] : [{ path: ['end'], value: formatTime(detail.end) }]),
                    ...technicalFields,
                  ]} />
                </div>
              </details>
            </div>}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
