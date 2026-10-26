import { useEffect, useId, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Globe2, History, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { observeWorld, useWorldStore } from '@/stores/world';
import { sameWorld, WorldRequestError } from '@/stores/world/client';
import type { ObjectView } from '@/types/world';
import { Empty } from './components';
import { Materials } from './Materials';
import { Objects } from './Objects';
import { Operations } from './Operations';
import { Definitions, FixedRecord } from './Definitions';
import { Actions } from './Actions';
import { Changes } from './Changes';
import { Settings } from './Settings';
import { WORLD_PAGES } from './navigation';
import { WorldConfirmationProvider } from './WorldConfirmation';
import './world.css';

export default function World() {
  return <WorldConfirmationProvider><WorldWorkspace /></WorldConfirmationProvider>;
}

function WorldWorkspace() {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [switching, setSwitching] = useState(false);
  const [showOperations, setShowOperations] = useState(false);
  const [actionTarget, setActionTarget] = useState<ObjectView | null>(null);
  const selectionId = useId();
  const recordsId = useId();
  const path = location.pathname.replace(/\/$/, '');
  const settingsPage = path === '/world/settings';
  const page = WORLD_PAGES.find(page => page.path === path) ?? WORLD_PAGES[0];
  const requestedTab = searchParams.get('tab');
  const tab = requestedTab === 'materials' || requestedTab === 'actions' ? requestedTab : 'data';
  const settingsTab = requestedTab === 'capabilities' || requestedTab === 'operations' ? requestedTab : 'storage';
  useEffect(() => {
    const stop = observeWorld();
    void useWorldStore.getState().openStorage().catch(() => undefined);
    return stop;
  }, []);
  const error = state.error instanceof Error ? state.error.message : state.error ? t('shell.readFailed') : null;
  const failure = state.error instanceof WorldRequestError ? state.error.failure : null;
  const operations = state.operations.filter(item => state.world && sameWorld(item.world, state.world));
  const upload = state.upload && state.world && sameWorld(state.upload.world, state.world) ? state.upload : null;
  const worlds = state.storageOpen?.outcome === 'opened' ? state.storageOpen.worlds : [];
  const blocked = state.storageOpening || state.busy || state.operationBusy || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy;
  const projectionBlocked = state.loading || !state.projectionReady || blocked;
  const openOperations = () => {
    if (settingsPage) navigate('/world/settings?tab=operations');
    else setShowOperations(value => !value);
  };
  const unavailable = (
    <div className="world-atelier-content">
      <Empty
        icon={<Globe2 className="h-8 w-8" />}
        title={!state.world ? t(state.storageOpen?.outcome === 'opened' && !worlds.length ? 'storage.open.noAccess' : 'shell.noWorld') : state.description
          ? t('shell.unavailable', { status: t(`shell.status.${state.description.status}`) })
          : state.loading ? t('shell.reading') : error ? t('shell.readFailed') : t('atelier.shell.statusUnknown')}
        action={<>
          <Button size="sm" asChild><Link to="/world/settings">{t('shell.openSettings')}</Link></Button>
          {!state.world && worlds.length > 0 && <Button size="sm" variant="outline" onClick={() => setSwitching(true)}>{t('shell.openExisting')}</Button>}
        </>}
      />
    </div>
  );
  const ready = state.world && state.description?.status === 'ready';
  return (
    <div className="world-workspace">
      <div className="world-context-bar">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <Globe2 aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto min-h-8 max-w-full gap-2 whitespace-normal px-2 py-1 text-left"
            aria-label={t(state.world ? 'shell.switchWorld' : 'shell.openExisting')}
            aria-expanded={switching}
            aria-controls={selectionId}
            onClick={() => setSwitching(value => !value)}
          >
            <span className="min-w-0 break-all">{state.world?.worldId ?? t('shell.openExisting')}</span>
            <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          </Button>
          {state.description && (
            <span className="world-status" data-status={state.description.status}>
              {t(`shell.status.${state.description.status}`)}
            </span>
          )}
          {state.description?.activeRelease && <span className="max-w-48 truncate text-xs text-muted-foreground" title={state.description.activeRelease}>{t('atelier.shell.activeRelease', { id: state.description.activeRelease })}</span>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!state.world}
            aria-expanded={settingsPage ? settingsTab === 'operations' : showOperations}
            aria-controls={settingsPage ? undefined : recordsId}
            onClick={openOperations}
          >
            <History aria-hidden="true" className="mr-2 h-4 w-4" />
            {t('shell.records')}{operations.length ? ` · ${operations.length}` : ''}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            title={t('shell.refresh')}
            disabled={!state.world || state.loading || state.storageOpening}
            onClick={() => { void state.refresh(); }}
          >
            <RefreshCw aria-hidden="true" className={`h-4 w-4 motion-reduce:animate-none ${state.loading ? 'animate-spin' : ''}`} />
            <span className="sr-only">{t('shell.refresh')}</span>
          </Button>
        </div>
      </div>
      <div className="world-page">
        <div className="world-page-inner">
          <div className="world-page-heading">
            <header className="world-heading"><h1>{t(page.key)}</h1></header>
            <div className="world-notices space-y-3">
              {switching && (
                <section id={selectionId} className="world-panel">
                  <div className="world-panel-header"><h2 className="text-sm font-medium">{t('shell.openExisting')}</h2></div>
                  <div className="world-panel-body space-y-3">
                    {worlds.length ? <ul className="space-y-2" aria-label={t('shell.availableWorlds')}>
                      {worlds.map(world => <li key={JSON.stringify([world.tenantId, world.worldId])}>
                        <Button
                          type="button"
                          size="sm"
                          variant={state.world && sameWorld(world, state.world) ? 'secondary' : 'outline'}
                          className="h-auto min-h-9 max-w-full justify-start gap-3 whitespace-normal py-2 text-left"
                          disabled={blocked || state.loading}
                          aria-pressed={Boolean(state.world && sameWorld(world, state.world))}
                          onClick={() => {
                            void state.selectWorld(world)
                              .then(loaded => { if (loaded) setSwitching(false); setActionTarget(null); })
                              .catch(() => undefined);
                          }}
                        >
                          <span className="break-all">{world.worldId}</span>
                          <span className="break-all text-xs text-muted-foreground">{world.tenantId}</span>
                        </Button>
                      </li>)}
                    </ul> : <p className="text-sm text-muted-foreground">{t(state.storageOpen?.outcome === 'opened' ? 'storage.open.noAccess' : 'storage.open.connectFirst')}</p>}
                    {!worlds.length && <Link className="text-xs text-foreground underline underline-offset-4" to="/world/settings">{t('shell.openSettings')}</Link>}
                  </div>
                </section>
              )}
              {error && (
                <div className="world-panel border-destructive/30 p-4 text-sm" role="alert">
                  <p className="break-words">{error}</p>
                  {failure && (
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer">{t('shell.diagnostic')}</summary>
                      <div className="mt-3 space-y-3">
                        <p className="break-words">
                          {failure.code} · {failure.stage} · {t('shell.diagnosticId', { id: failure.diagnosticId })}
                        </p>
                        <p>{failure.recovery.kind === 'refresh' ? t('shell.recovery.refresh')
                          : failure.recovery.kind === 'read_commit' ? t('shell.recovery.commit')
                            : failure.recovery.kind === 'resume_operation' ? t('shell.recovery.resume') : t('shell.recovery.receipt')}</p>
                        <FixedRecord value={failure.recovery} />
                        <FixedRecord value={failure.details} />
                      </div>
                    </details>
                  )}
                </div>
              )}
              {state.pending && (
                <div className="world-panel flex flex-wrap items-center justify-between gap-3 p-4 text-sm" role="status">
                  <span>{t('shell.pendingRequest')}</span>
                  <Button type="button" size="sm" variant="outline" disabled={state.operationBusy} onClick={() => { void state.retryPending(); }}>
                    {t('shell.retryOriginal')}
                  </Button>
                </div>
              )}
              {state.pendingOperation && (
                <div className="world-panel flex flex-wrap items-center justify-between gap-3 p-4 text-sm" role="status">
                  <span>{t('shell.pendingOperation')}</span>
                  <Button type="button" size="sm" variant="outline" onClick={() => {
                    if (settingsPage) navigate('/world/settings?tab=operations');
                    else setShowOperations(true);
                  }}>
                    {t('shell.openRecords')}
                  </Button>
                </div>
              )}
              {state.loading && <p className="text-sm text-muted-foreground" role="status">{t('shell.reading')}</p>}
              {upload?.transferId && (
                <p className="break-all text-xs text-muted-foreground">
                  {t('shell.uploadTransferId')} · <output aria-label={t('shell.uploadTransferId')}>{upload.transferId}</output>
                </p>
              )}
              {upload?.submission && upload.submission.kind !== 'import_materials' && (
                <details className="text-xs text-muted-foreground" data-upload-submission={upload.submission.requestId}>
                  <summary className="cursor-pointer">{t('shell.diagnostic')}</summary>
                  <FixedRecord value={{ world: upload.submission.world, requestId: upload.submission.requestId, kind: upload.submission.kind }} />
                  {upload.submission.failure && <div className="mt-2 space-y-2 text-destructive" role="alert"><p>{upload.submission.failure.message}</p><FixedRecord value={upload.submission.failure} /></div>}
                </details>
              )}
              {state.busy && (
                <p className="break-words text-sm text-muted-foreground" role="status">
                  {upload ? t('shell.uploadProgress', {
                    name: upload.name,
                    state: upload.state,
                    received: upload.received.toLocaleString(),
                    total: upload.total.toLocaleString(),
                  }) : t('shell.processing')}
                  {upload && <Button type="button" size="sm" variant="ghost" onClick={state.cancelUpload}>{t('materials.upload.cancel')}</Button>}
                </p>
              )}
              {state.notice && <p className="break-words text-sm text-muted-foreground" role="status">{state.notice}</p>}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            {!settingsPage && showOperations && <div id={recordsId} className="world-atelier-content"><Operations /></div>}
            <fieldset className="min-w-0" disabled={!settingsPage && projectionBlocked}>
            <Routes key={settingsPage ? 'settings' : state.workspaceVersion}>
              <Route index element={ready ? (
                <Tabs className="world-data-tabs" value={tab} onValueChange={value => navigate(value === 'data' ? '/world' : `/world?tab=${value}`)}>
                  <TabsList variant="line" aria-label={t('pages.data')}>
                    <TabsTrigger value="data">{t('shell.tabs.data')}</TabsTrigger>
                    <TabsTrigger value="materials">{t('shell.tabs.materials')}</TabsTrigger>
                    <TabsTrigger value="actions">{t('shell.tabs.actions')}</TabsTrigger>
                  </TabsList>
                  <TabsContent className="world-data-content" value="data">
                    <Objects
                      addMaterials={mode => navigate(`/world?tab=materials&mode=${mode}`)}
                      proposeAction={object => { setActionTarget(object); navigate('/world?tab=actions'); }}
                    />
                  </TabsContent>
                  <TabsContent className="world-data-content" value="materials"><Materials /></TabsContent>
                  <TabsContent className="world-data-content" value="actions"><Actions target={actionTarget} /></TabsContent>
                </Tabs>
              ) : unavailable} />
              <Route path="model" element={ready ? <Definitions /> : unavailable} />
              <Route path="changes" element={ready ? <Changes /> : unavailable} />
              <Route path="settings" element={<Settings projectionBlocked={projectionBlocked} />} />
              <Route path="*" element={<Navigate to="/world" replace />} />
            </Routes>
            </fieldset>
          </div>
        </div>
      </div>
      <footer className="world-footer">
        <span className="min-w-0 truncate" title={state.world ? `${state.world.tenantId} / ${state.world.worldId}` : undefined}>{state.world ? `${state.world.tenantId} / ${state.world.worldId}` : t('shell.noWorld')}</span>
        {state.description && <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>{t('atelier.shell.revision', { revision: state.description.revision })}</span>
          <span>{t('atelier.shell.incarnation', { incarnation: state.description.incarnation })}</span>
        </div>}
      </footer>
    </div>
  );
}
