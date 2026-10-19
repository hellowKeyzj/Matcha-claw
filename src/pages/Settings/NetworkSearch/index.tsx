import { AlertCircle, Check, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Advanced } from './Advanced';
import { Runtimes } from './Runtimes';
import { Sources } from './Sources';
import { useNetworkSearch } from './useNetworkSearch';
import './network-search.css';

export default function NetworkSearch() {
  const { t } = useTranslation('settings');
  const { snapshot, draft, dirty, conflict, pending, loading, error, run, updateDraft, discard } = useNetworkSearch();
  const busy = pending !== null || snapshot?.service.phase === 'preparing' || snapshot?.service.phase === 'starting';
  let validation = '';
  if (draft) {
    if (!/^(?:all|auto|[a-zA-Z]{2,3}(?:[-_][a-zA-Z]{2,4})?)$/.test(draft.language)
      || !Number.isInteger(draft.resultCount) || draft.resultCount < 1 || draft.resultCount > 10
      || !Number.isInteger(draft.requestTimeoutSeconds) || draft.requestTimeoutSeconds < 1 || draft.requestTimeoutSeconds > 120) {
      validation = t('networkSearch.invalidDefaults');
    }
    if (draft.categories.length === 0) validation = t('networkSearch.categoryRequired');
    if (draft.proxyUrl) {
      try {
        const url = new URL(draft.proxyUrl);
        if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)
          || !url.hostname || url.username || url.password || url.pathname && url.pathname !== '/'
          || draft.proxyUrl.split('://')[1]?.includes('@') || draft.proxyUrl.length > 2048
          || url.search || url.hash || /\s/.test(draft.proxyUrl)) validation = t('networkSearch.invalidProxy');
      } catch { validation = t('networkSearch.invalidProxy'); }
    }
  }

  const saveStatus = pending === 'save' ? 'saving'
    : pending ? `operation.${pending}`
      : conflict ? 'configChanged'
        : dirty ? 'unsaved'
          : error != null || snapshot?.service.error ? 'needsAttention'
            : snapshot && snapshot.appliedRevision !== snapshot.revision ? 'notApplied' : 'saved';

  return <section className="network-search" aria-label={t('networkSearch.title')} aria-busy={loading || pending !== null}>
    <header className="network-search-header">
      <h2 className="text-2xl font-semibold tracking-[-0.025em]">{t('networkSearch.title')}</h2>
      <div className="flex flex-wrap items-center gap-4">
        {snapshot && <Badge role="status" variant={snapshot.service.phase === 'running' ? 'success' : snapshot.service.phase === 'failed' ? 'destructive' : 'secondary'}>{t(`networkSearch.servicePhase.${snapshot.service.phase}`)}</Badge>}
        {draft && <div className="flex items-center gap-3"><Label htmlFor="network-search-enabled" className="text-sm">{t('networkSearch.enabled')}</Label><Switch id="network-search-enabled" checked={draft.enabled} disabled={busy} onCheckedChange={(enabled) => updateDraft({ enabled })} /></div>}
      </div>
    </header>
    {error != null && <div role="alert" className="network-search-error mt-5"><p>{conflict ? t('networkSearch.conflict') : error instanceof Error ? error.message : String(error)}</p><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void run('refresh')}><RefreshCw aria-hidden className="h-3.5 w-3.5" />{t('networkSearch.refresh')}</Button></div>}
    {snapshot?.service.error && <p role="alert" className="network-search-error mt-4">{snapshot.service.error}</p>}
    {pending && (!snapshot || !draft) && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden className="h-4 w-4 animate-spin" />{t(`networkSearch.operation.${pending}`)}</p>}
    {snapshot && draft ? <>
      <Tabs defaultValue="sources" className="network-search-tab-layout">
        <TabsList variant="line" className="network-search-tabs flex w-full border-b border-border" aria-label={t('networkSearch.title')}>
          <TabsTrigger value="sources">{t('networkSearch.sources')}</TabsTrigger>
          <TabsTrigger value="runtimes">{t('networkSearch.runtimes')}</TabsTrigger>
          <TabsTrigger value="advanced">{t('networkSearch.advanced')}</TabsTrigger>
        </TabsList>
        <TabsContent value="sources" className="network-search-panel"><Sources snapshot={snapshot} draft={draft} disabled={busy} onChange={updateDraft} /></TabsContent>
        <TabsContent value="runtimes" className="network-search-panel"><Runtimes snapshot={snapshot} draft={draft} disabled={busy} onChange={updateDraft} /></TabsContent>
        <TabsContent value="advanced" className="network-search-panel"><Advanced snapshot={snapshot} draft={draft} disabled={busy} pending={pending} onChange={updateDraft} onAction={(action) => void run(action)} /></TabsContent>
      </Tabs>
      <footer className="network-search-save-bar">
        <div className="network-search-save-row">
          <details className="network-search-save-details">
            <summary aria-label={t('networkSearch.configDetails')}>
              {pending ? <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin" />
                : saveStatus === 'saved' ? <Check aria-hidden className="h-4 w-4 shrink-0" />
                  : saveStatus === 'unsaved' ? <span aria-hidden className="mx-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-600 dark:bg-amber-400" />
                    : <AlertCircle aria-hidden className="h-4 w-4 shrink-0" />}
              <span aria-live="polite">{t(`networkSearch.${saveStatus}`)}</span>
              <ChevronDown aria-hidden className="network-search-save-chevron h-3.5 w-3.5 shrink-0" />
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">{t('networkSearch.revisions', { saved: snapshot.revision, applied: snapshot.appliedRevision ?? t('networkSearch.notApplied') })}</p>
          </details>
          <div className="network-search-save-actions">
            {(dirty || conflict) && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={discard}>{t(conflict ? 'networkSearch.reloadConfig' : 'networkSearch.discard')}</Button>}
            <Button type="button" size="sm" disabled={busy || (!dirty && snapshot.appliedRevision === snapshot.revision) || conflict || !!validation} onClick={() => void run('save')}>{pending === 'save' && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}{t('networkSearch.saveApply')}</Button>
          </div>
        </div>
        {conflict && <p role="alert" className="network-search-warning w-full">{t('networkSearch.conflict')}</p>}
        {dirty && validation && <p role="alert" className="network-search-error w-full">{validation}</p>}
        {!dirty && snapshot.appliedRevision !== snapshot.revision && <p className="network-search-warning w-full">{t('networkSearch.savedNotApplied')}</p>}
      </footer>
    </> : loading ? <div role="status" className="space-y-4 py-8"><span className="sr-only">{t('networkSearch.loading')}</span><div className="h-10 rounded-lg bg-muted" /><div className="h-44 rounded-xl bg-muted/60" /></div>
      : <Button type="button" variant="outline" className="mt-6" disabled={busy} onClick={() => void run('refresh')}><RefreshCw aria-hidden className="h-4 w-4" />{t('networkSearch.retry')}</Button>}
  </section>;
}
