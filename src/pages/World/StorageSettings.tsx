import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Database, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWorldStore } from '@/stores/world';
import { configureStorage, operationWorld, sameWorld, storageStatus, type StorageStatus, type StorageInput, type StorageTransferInput } from '@/stores/world/client';
import type { BlobRef, OperationResponse, WorldCommand } from '@/types/world';
import { DataTable, Field, selectClass } from './components';
import { FixedRecord } from './Definitions';
import { AccessSettings } from './AccessSettings';
import { EvaluationSettings } from './EvaluationSettings';
import { useWorldConfirmation } from './WorldConfirmation';

export function StorageConfiguration() {
  const { t } = useTranslation('world');
  const state = useWorldStore();
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [kind, setKind] = useState<Exclude<StorageInput['kind'], 'initial'>>('credentials');
  const [storageId, setStorageId] = useState('');
  const [connectionString, setConnectionString] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [checkingArchive, setCheckingArchive] = useState(false);
  const archiveVersion = useRef(0);
  useEffect(() => { void storageStatus().then(setStatus, () => setMessage('storage.statusFailed')); }, []);
  const configuration = status?.outcome === 'available' ? status : null;
  const configurationLabel = !status ? t('atelier.storage.configurationLoading') : !configuration
    ? t('atelier.storage.configurationUnavailable') : configuration.configured
      ? t('storage.configured') : t('atelier.storage.configurationPending');
  const description = state.description && state.world && sameWorld(state.description.world, state.world) ? state.description : null;
  const opened = state.storageOpen;
  const openError = opened && 'error' in opened ? opened.error : null;
  const checkingOriginal = opened?.outcome === 'unknown';
  const blocked = busy || checkingArchive || state.storageOpening || state.loading || state.busy || state.operationBusy
    || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy;
  const openMessage = message.startsWith('storage.open.');
  const openLabel = state.storageOpening ? 'storage.open.opening' : opened?.outcome === 'opened'
    ? !opened.worlds.length ? 'storage.open.noAccess' : !state.world ? 'storage.open.chooseWorld' : 'storage.open.opened'
      : opened?.outcome === 'not-configured' ? 'storage.open.notConfigured'
        : opened?.outcome === 'unknown' ? 'storage.open.unknown' : opened?.outcome === 'not-attempted' ? 'storage.open.notAttempted' : null;
  const enableStorage = async () => {
    if (blocked) return;
    setBusy(true); setMessage('');
    try {
      await state.openStorage(checkingOriginal || !connectionString.trim() ? undefined : { connectionString: connectionString.trim() });
      setConnectionString('');
      try { setStatus(await storageStatus()); }
      catch { setMessage('storage.statusFailed'); }
    } catch { setMessage('storage.open.blocked'); }
    finally { setBusy(false); }
  };
  return <div className="min-w-0 space-y-5">
    <section className="world-panel world-settings-summary flex flex-wrap items-center justify-between gap-4 p-5" aria-label={t('atelier.storage.summaryTitle')}>
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[hsl(var(--shell-border))] text-muted-foreground"><Database className="h-5 w-5" aria-hidden="true" /></span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><h2 className="break-all text-base font-semibold">{state.world?.worldId ?? t('shell.noWorld')}</h2>{description && <span className="world-status" data-status={description.status}>{t(`shell.status.${description.status}`)}</span>}</div>
          <p className="mt-1 break-all text-xs text-muted-foreground">{state.world?.tenantId}{description && ` · ${t('atelier.shell.revision', { revision: description.revision })}`}{description?.activeRelease && ` · ${t('settings.currentRelease', { release: description.activeRelease })}`}</p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('settings.privateStorage')} · {configurationLabel}</p>
    </section>

    <section className="world-panel min-w-0" aria-busy={state.storageOpening}>
      <header className="world-panel-header"><h2>{t('storage.open.title')}</h2><p>{t('storage.open.hint')}</p></header>
      <form className="world-panel-body space-y-4" onSubmit={event => { event.preventDefault(); void enableStorage(); }}>
        <Field label={t('storage.connection')}><Input className="h-9 text-sm" type="password" value={connectionString} onChange={event => setConnectionString(event.target.value)} placeholder={t('storage.connectionPlaceholder')} autoComplete="off" required={!configuration?.configured && !checkingOriginal} disabled={blocked || checkingOriginal} /></Field>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('storage.credentialsHint')}</p>
          <Button type="submit" size="sm" disabled={blocked || (!checkingOriginal && !connectionString.trim() && !configuration?.configured)}>{t(checkingOriginal ? 'storage.open.checkOriginal' : state.storageOpening ? 'storage.open.opening' : 'storage.open.connect')}</Button>
        </div>
        {openLabel && <p className="text-sm leading-relaxed" role="status">{t(openLabel)}</p>}
        {message && (openMessage || message === 'storage.statusFailed') && <p className="text-sm leading-relaxed" role="status">{t(message)}</p>}
        {opened?.outcome === 'opened' && <p className="break-all font-mono text-xs text-muted-foreground">{t('storage.open.storageId')} · {opened.storageId}</p>}
        {opened?.outcome === 'unknown' && (opened.world || opened.commitId) && <DataTable columns={[t('storage.initial.receipt'), t('storage.result')]} rows={[
          [t('storage.initial.world'), opened.world ? `${opened.world.tenantId} / ${opened.world.worldId}` : t('storage.notReturned')],
          [t('storage.initial.commitId'), opened.commitId ?? t('storage.notReturned')],
        ]} />}
        {openError && <div className="space-y-3" role="alert"><p className="text-sm text-destructive">{t(`storage.open.reasons.${openError.reason}`)}</p><DataTable columns={[t('storage.diagnostic.title'), t('storage.diagnostic.result')]} rows={[
          [t('storage.diagnostic.source'), openError.source], [t('storage.diagnostic.reason'), openError.reason], [t('storage.diagnostic.code'), openError.code], [t('storage.diagnostic.stage'), openError.stage], [t('storage.diagnostic.id'), openError.diagnosticId],
        ]} /><details className="rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('storage.diagnostic.recovery')}</summary><div className="mt-3 space-y-3"><FixedRecord value={openError.recovery} /><FixedRecord value={openError.details} /></div></details></div>}
      </form>
    </section>

    <section className="world-panel min-w-0">
      <header className="world-panel-header"><h2>{t('settings.dailyManagement')}</h2><p>{t('settings.onDemand')}</p></header>
      <fieldset className="min-w-0 px-5" disabled={state.storageOpening}>
        <AccessSettings />
        <EvaluationSettings />
        <ArchiveManagement key={JSON.stringify([state.world, state.description?.incarnation])} checking={checkingArchive} setChecking={setCheckingArchive} version={archiveVersion} />
      </fieldset>
    </section>

    <details className="world-panel world-settings-advanced group/advanced min-w-0">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 p-5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 group-open/advanced:rotate-0" aria-hidden="true" />
        <span className="font-semibold">{t('settings.advancedStorage')}</span>
        <span className="text-xs text-muted-foreground">{t('settings.advancedStorageHint')}</span>
      </summary>
      <fieldset className="min-w-0 border-t border-[hsl(var(--shell-border))] px-5" disabled={state.storageOpening}>
        <details className="world-settings-row group/connection min-w-0 border-b border-[hsl(var(--shell-border))]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <span className="min-w-0"><span className="block text-sm font-medium">{t('atelier.storage.connectionTitle')}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t('atelier.storage.connectionDescription')}</span></span>
            <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground group-open/connection:rotate-0" aria-hidden="true" />
          </summary>
          <form className="space-y-4 pb-5" onSubmit={event => {
          event.preventDefault();
          if (blocked || checkingOriginal) return;
          setBusy(true); setMessage('');
          const input: StorageInput = kind === 'credentials' ? { kind, storageId, connectionString } : { kind, connectionString };
          void configureStorage(input).then(async result => {
            setConnectionString('');
            setMessage(result.outcome === 'saved' ? 'storage.saved'
              : result.outcome === 'unknown' ? 'storage.saveUnknown'
                : result.reason === 'unauthorized' ? 'storage.unauthorized'
                  : result.reason === 'already-configured' ? 'storage.alreadyConfigured' : 'storage.invalid');
            setStatus(await storageStatus());
          }).catch(() => setMessage('storage.saveUnconfirmed')).finally(() => setBusy(false));
        }}>
          <div className="grid min-w-0 gap-4 [@container(min-width:760px)]:grid-cols-2">
            <Field label={t('storage.purpose')}><select className={`${selectClass} w-full`} value={kind} disabled={blocked || checkingOriginal} onChange={event => setKind(event.target.value as typeof kind)}><option value="credentials">{t('storage.purposes.credentials')}</option><option value="target">{t('storage.purposes.target')}</option></select></Field>
            {kind === 'credentials' && <Field label={t('storage.existing')}><select className={`${selectClass} w-full`} required value={storageId} onChange={event => setStorageId(event.target.value)}><option value="">{t('storage.selectExisting')}</option>{configuration && [configuration.initialStorageId, ...configuration.targetStorageIds].filter((id): id is string => Boolean(id)).map(id => <option key={id} value={id}>{id}</option>)}</select></Field>}
            <div className="min-w-0 [@container(min-width:760px)]:col-span-2"><Field label={t('storage.connection')}><Input className="h-9 text-sm" type="password" value={connectionString} onChange={event => setConnectionString(event.target.value)} placeholder={t('storage.connectionPlaceholder')} autoComplete="off" required disabled={blocked || checkingOriginal} /></Field></div>
          </div>
          <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('storage.credentialsHint')}</p>
          <div className="flex flex-wrap justify-end gap-2"><Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => { void storageStatus().then(setStatus, () => setMessage('storage.statusFailed')); }}>{t('storage.refresh')}</Button><Button type="submit" size="sm" disabled={blocked || checkingOriginal}>{t('storage.save')}</Button></div>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.storage.verificationBoundary')}</p>
          {message && !openMessage && message !== 'storage.statusFailed' && <p className="text-sm leading-relaxed" role="status">{t(message)}</p>}
          <dl className="grid min-w-0 gap-3 rounded-lg border border-[hsl(var(--shell-border))] p-3 text-xs">
            <div><dt className="text-muted-foreground">{t('atelier.storage.summaryInitialStorage')}</dt><dd className="mt-1 break-all font-mono">{configuration ? configuration.initialStorageId ?? t('storage.notReturned') : configurationLabel}</dd></div>
            <div><dt className="text-muted-foreground">{t('atelier.storage.summarySavedTargets')}</dt><dd className="mt-1 break-all font-mono">{configuration ? configuration.targetStorageIds.join(' / ') || t('shared.empty') : configurationLabel}</dd></div>
            <div><dt className="text-muted-foreground">{t('atelier.storage.summaryRegisteredTargets')}</dt><dd className="mt-1 break-all font-mono">{configuration ? configuration.registeredTargetStorageIds.join(' / ') || t('shared.empty') : configurationLabel}</dd></div>
          </dl>
          </form>
        </details>

        <StorageTransfer key={JSON.stringify(state.world)} status={status} />
        <WorldDeletion key={JSON.stringify([state.world, state.description?.incarnation])} checking={checkingArchive} version={archiveVersion} />
      </fieldset>
    </details>
    <p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.storage.boundaryReceipts')}</p>
  </div>;
}

function ArchiveManagement({ checking, setChecking, version }: { checking: boolean; setChecking: (checking: boolean) => void; version: RefObject<number> }) {
  const { t } = useTranslation('world');
  const confirm = useWorldConfirmation();
  const navigate = useNavigate();
  const state = useWorldStore();
  const [includeMaterials, setIncludeMaterials] = useState(false);
  const [backup, setBackup] = useState<Extract<OperationResponse, { kind: 'result' }>['result'] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selection = useRef({ backup, checking });
  selection.current = { backup, checking };
  useEffect(() => () => { version.current++; setChecking(false); }, [version, setChecking]);
  const world = state.world;
  const description = world && state.description && sameWorld(state.description.world, world) ? state.description : null;
  const ready = description?.status === 'ready';
  const blocked = checking || state.loading || state.busy || state.operationBusy || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy;
  const manifest = backup?.result?.kind === 'backup' ? backup.result.result.manifest : null;
  const submit = async (command: WorldCommand, message?: string) => {
    if (!world || !description || !ready || blocked) return;
    const read = version.current;
    const archive = backup;
    const basis = JSON.stringify([world, description.incarnation, description.revision, description.activeReleaseHead]);
    const current = () => {
      const latest = useWorldStore.getState();
      return read === version.current && !selection.current.checking && (command.kind !== 'restore' || selection.current.backup === archive)
        && latest.world && sameWorld(latest.world, world) && latest.description && sameWorld(latest.description.world, world)
        && latest.description.status === 'ready' && JSON.stringify([latest.world, latest.description.incarnation, latest.description.revision, latest.description.activeReleaseHead]) === basis
        && !latest.loading && !latest.busy && !latest.operationBusy && !latest.pending && !latest.pendingOperation && !latest.transferBusy;
    };
    if (!current() || (message && !await confirm(message)) || !current()) return;
    setError(''); setNotice('');
    try {
      const result = await useWorldStore.getState().command(command);
      if (read !== version.current) return;
      if (result.kind !== 'accepted' || !sameWorld(result.result.world, world)) throw new Error(t('operations.errors.receiptMismatch'));
      setNotice(t('archive.pending'));
      navigate('/world/settings?tab=operations');
    } catch (error) { if (read === version.current) setError(error instanceof Error ? error.message : t('operations.errors.unknown')); }
  };
  return <>
    <details className="world-settings-row group/backup min-w-0 border-b border-[hsl(var(--shell-border))]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0"><span className="block text-sm font-medium">{t('settings.backupTitle')}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t('settings.backupHint')}</span></span>
        <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground group-open/backup:rotate-0" aria-hidden="true" />
      </summary>
      <div className="space-y-4 pb-5">
        {!ready && <p className="text-sm text-muted-foreground">{t('shell.openFirst')}</p>}
        {description && <DataTable columns={[t('storage.initial.receipt'), t('storage.result')]} rows={[[t('storage.initial.world'), `${description.world.tenantId} / ${description.world.worldId}`], [t('atelier.shell.incarnation', { incarnation: description.incarnation }), description.incarnation], [t('packages.revision'), description.revision]]} />}
        <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" disabled={blocked} checked={includeMaterials} onChange={event => setIncludeMaterials(event.target.checked)} />{t('archive.includeMaterials')}</label>
        <Button type="button" size="sm" variant="outline" disabled={!ready || blocked || !description?.activeRelease} onClick={() => { if (description?.activeRelease) void submit({ kind: 'backup', request: { expectedRelease: description.activeRelease, includeMaterials } }); }}>{t('archive.backup')}</Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('archive.hint')}</p>
      </div>
    </details>
    <details className="world-settings-row group/restore min-w-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span className="min-w-0"><span className="block text-sm font-medium">{t('settings.restoreTitle')}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t('settings.restoreHint')}</span></span>
        <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground group-open/restore:rotate-0" aria-hidden="true" />
      </summary>
      <div className="space-y-4 pb-5" aria-busy={checking}>
        {!ready && <p className="text-sm text-muted-foreground">{t('shell.openFirst')}</p>}
        {description && <p className="break-all text-xs text-muted-foreground">{description.world.tenantId} / {description.world.worldId} · {t('atelier.shell.incarnation', { incarnation: description.incarnation })} · {t('atelier.shell.revision', { revision: description.revision })}</p>}
        <Field label={t('archive.manifest')}><input type="file" accept="application/json,.json" className="max-w-full text-sm" disabled={!ready || blocked} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          const read = ++version.current;
          setBackup(null); setError(''); setNotice(''); setChecking(false);
          if (!file || !world || !description) return;
          setChecking(true);
          void (async () => {
            if (file.size > 8 * 1024 * 1024) throw new Error(t('archive.invalid'));
            const original = JSON.parse(await file.text()) as Extract<OperationResponse, { kind: 'result' }>['result'] | null;
            const blob: BlobRef | undefined = original?.result?.kind === 'backup' ? original.result.result?.manifest : undefined;
            if (!original?.accepted?.world || !sameWorld(original.accepted.world, world)
              || typeof original.accepted.operationId !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(original.accepted.operationId)
              || original.phase !== 'completed' || !blob || typeof blob.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(blob.digest)
              || typeof blob.byteSize !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(blob.byteSize) || BigInt(blob.byteSize) > 18_446_744_073_709_551_615n) throw new Error(t('archive.invalid'));
            const response = await operationWorld({ kind: 'result', request: { world, operationId: original.accepted.operationId } });
            if (read !== version.current) return;
            const confirmed = response.kind === 'result' ? response.result : null;
            if (!confirmed || !sameWorld(confirmed.accepted.world, world) || confirmed.accepted.operationId !== original.accepted.operationId
              || confirmed.phase !== 'completed' || confirmed.result?.kind !== 'backup'
              || (confirmed.disclosure.kind === 'summary' && confirmed.disclosure.withheld.includes('result_details'))
              || confirmed.result.result.manifest.digest !== blob.digest || confirmed.result.result.manifest.byteSize !== blob.byteSize) throw new Error(t('archive.invalid'));
            setBackup(confirmed);
          })().catch(error => { if (read === version.current) setError(error instanceof Error ? error.message : t('archive.invalid')); })
            .finally(() => { if (read === version.current) setChecking(false); });
        }} /></Field>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('archive.manifestHint')}</p>
        {backup && manifest && <FixedRecord value={{ accepted: backup.accepted, manifest }} />}
        <Button type="button" size="sm" variant="outline" disabled={!ready || blocked || !manifest} onClick={() => { if (description && manifest) void submit({ kind: 'restore', request: { expectedIncarnation: description.incarnation, manifest } }, t('archive.confirmRestore')); }}>{t('archive.restore')}</Button>
      </div>
    </details>
    <div className="space-y-2 pb-5">
      <Link className="text-xs text-muted-foreground underline underline-offset-4" to="/world/settings?tab=operations">{t('shell.openRecords')}</Link>
      {notice && <p className="text-sm" role="status">{notice}</p>}
      {error && <p className="break-words text-sm text-destructive" role="alert">{error}</p>}
    </div>
  </>;
}

function WorldDeletion({ checking, version }: { checking: boolean; version: RefObject<number> }) {
  const { t } = useTranslation('world');
  const confirm = useWorldConfirmation();
  const navigate = useNavigate();
  const state = useWorldStore();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const world = state.world;
  const description = world && state.description && sameWorld(state.description.world, world) ? state.description : null;
  const ready = description?.status === 'ready';
  const blocked = checking || state.loading || state.busy || state.operationBusy || Boolean(state.pending) || Boolean(state.pendingOperation) || state.transferBusy;
  const submit = async () => {
    if (!world || !description || !ready || blocked) return;
    const read = version.current;
    const basis = JSON.stringify([world, description.incarnation, description.revision, description.activeReleaseHead]);
    const current = () => {
      const latest = useWorldStore.getState();
      return read === version.current && latest.world && sameWorld(latest.world, world) && latest.description
        && sameWorld(latest.description.world, world) && latest.description.status === 'ready'
        && JSON.stringify([latest.world, latest.description.incarnation, latest.description.revision, latest.description.activeReleaseHead]) === basis
        && !latest.loading && !latest.busy && !latest.operationBusy && !latest.pending && !latest.pendingOperation && !latest.transferBusy;
    };
    if (!current() || !await confirm([
      t('archive.confirmDelete'), `${t('storage.initial.world')}: ${world.tenantId} / ${world.worldId}`,
      t('atelier.shell.incarnation', { incarnation: description.incarnation }), t('atelier.shell.revision', { revision: description.revision }),
    ].join('\n')) || !current()) return;
    setError(''); setNotice('');
    try {
      const result = await useWorldStore.getState().command({ kind: 'delete_world', request: { expectedIncarnation: description.incarnation, expectedRevision: description.revision } });
      if (read !== version.current) return;
      if (result.kind !== 'accepted' || !sameWorld(result.result.world, world)) throw new Error(t('operations.errors.receiptMismatch'));
      setNotice(t('archive.pending'));
      navigate('/world/settings?tab=operations');
    } catch (error) { if (read === version.current) setError(error instanceof Error ? error.message : t('operations.errors.unknown')); }
  };
  return <details className="world-settings-row group/deletion min-w-0">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <span className="min-w-0"><span className="block text-sm font-medium">{t('archive.delete')}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t('settings.deleteHint')}</span></span>
      <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground group-open/deletion:rotate-0" aria-hidden="true" />
    </summary>
    <div className="space-y-4 pb-5">
      {!ready && <p className="text-sm text-muted-foreground">{t('shell.openFirst')}</p>}
      {description && <DataTable columns={[t('storage.initial.receipt'), t('storage.result')]} rows={[[t('storage.initial.world'), `${description.world.tenantId} / ${description.world.worldId}`], [t('atelier.shell.incarnation', { incarnation: description.incarnation }), description.incarnation], [t('packages.revision'), description.revision]]} />}
      <p className="text-xs leading-relaxed text-muted-foreground">{t('archive.confirmDelete')}</p>
      <Button type="button" size="sm" variant="destructive" disabled={!ready || blocked} onClick={() => { void submit(); }}>{t('archive.delete')}</Button>
      {notice && <p className="text-sm" role="status">{notice}</p>}
      {error && <p className="break-words text-sm text-destructive" role="alert">{error}</p>}
    </div>
  </details>;
}

function StorageTransfer({ status }: { status: StorageStatus | null }) {
  const { t } = useTranslation('world');
  const confirm = useWorldConfirmation();
  const state = useWorldStore();
  const [target, setTarget] = useState('');
  const targetAvailable = status?.outcome === 'available' && status.registeredTargetStorageIds.includes(target);
  const confirmationVersion = useRef(0);
  useLayoutEffect(() => () => { confirmationVersion.current++; }, [target, targetAvailable]);
  const world = state.world;
  useEffect(() => {
    if (world) void useWorldStore.getState().transferStorage({ action: 'status', world });
  }, [world]);
  const result = state.storageTransfer;
  const transfer = result?.outcome === 'status' ? result.transfer : null;
  const terminal = transfer?.phase === 'activated' || transfer?.phase === 'aborted';
  const targets = status?.outcome === 'available' ? status.registeredTargetStorageIds : [];
  const blocked = state.transferBusy || state.busy || state.operationBusy || Boolean(state.pendingOperation);
  const confirmTransfer = async (input: StorageTransferInput, message: string) => {
    if (!world || blocked || (input.action !== 'prepare' && input.action !== 'abort')) return;
    if (input.action === 'prepare' && (input.targetStorageId !== target || !targetAvailable)) return;
    const read = confirmationVersion.current;
    const basis = JSON.stringify([world, state.description?.incarnation, state.description?.revision, state.description?.activeReleaseHead]);
    const transferBasis = JSON.stringify(result);
    const current = () => {
      const latest = useWorldStore.getState();
      return read === confirmationVersion.current && latest.world && sameWorld(latest.world, world)
        && (!latest.description || sameWorld(latest.description.world, world))
        && JSON.stringify([latest.world, latest.description?.incarnation, latest.description?.revision, latest.description?.activeReleaseHead]) === basis
        && JSON.stringify(latest.storageTransfer) === transferBasis
        && !latest.loading && !latest.busy && !latest.operationBusy && !latest.pending && !latest.pendingOperation && !latest.transferBusy;
    };
    if (!current() || !await confirm(message) || !current()) return;
    void useWorldStore.getState().transferStorage(input);
  };
  return <details className="world-settings-row group/transfer min-w-0 border-b border-[hsl(var(--shell-border))]">
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <span className="min-w-0"><span className="block text-sm font-medium">{t('storage.transfer.title')}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t('storage.transfer.hint')}</span></span>
      <ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground group-open/transfer:rotate-0" aria-hidden="true" />
    </summary>
    <div className="space-y-4 pb-5">
      <form className="flex flex-wrap items-end gap-3" onSubmit={event => {
        event.preventDefault();
        if (!world || blocked || !targetAvailable || (result?.outcome !== 'not-found' && !terminal)) return;
        void confirmTransfer({ action: 'prepare', world, targetStorageId: target }, t('storage.transfer.confirmPrepare'));
      }}><div className="min-w-0 flex-1 basis-64"><Field label={t('storage.transfer.target')}><select className={`${selectClass} w-full`} required value={target} onChange={event => setTarget(event.target.value)} disabled={blocked}><option value="">{t('storage.transfer.selectTarget')}</option>{targets.map(id => <option key={id} value={id}>{id}</option>)}</select></Field></div><Button size="sm" variant="outline" disabled={!world || blocked || !targetAvailable || (result?.outcome !== 'not-found' && !terminal)}>{t('storage.transfer.prepare')}</Button></form>
      {!targets.length && <p className="text-sm text-muted-foreground">{t('storage.transfer.noTargets')}</p>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!world || state.transferBusy} onClick={() => { if (world) { const transferId = transfer?.transferId ?? (result?.outcome === 'unknown' ? result.transferId : undefined); void state.transferStorage(transferId ? { action: 'status', transferId } : { action: 'status', world }); } }}>{t('storage.transfer.check')}</Button>{transfer && !terminal && <><Button size="sm" disabled={blocked} onClick={() => { void state.transferStorage({ action: 'resume', transferId: transfer.transferId }); }}>{t('storage.transfer.resume')}</Button><Button size="sm" variant="outline" disabled={blocked} onClick={() => { void confirmTransfer({ action: 'abort', transferId: transfer.transferId }, t('storage.transfer.confirmAbort')); }}>{t('storage.transfer.abort')}</Button></>}</div>
      {transfer && <><DataTable columns={[t('storage.transfer.receipt'), t('storage.result')]} rows={[
        [t('storage.transfer.id'), transfer.transferId], [t('storage.transfer.target'), transfer.targetStorageId], [t('storage.status'), t(`storage.transfer.phases.${transfer.phase}`)], [t('storage.transfer.action'), transfer.action === 'resume' ? t('storage.transfer.resumeAction') : t('storage.transfer.abortAction')],
      ]} />{transfer.error && <p className="break-words text-sm text-destructive" role="alert">{transfer.error.message} · {transfer.error.code} · {t('storage.diagnostic.id')} {transfer.error.diagnosticId}</p>}<p className="text-xs leading-relaxed text-muted-foreground">{t('storage.transfer.receiptHint')}</p></>}
      {result?.outcome === 'not-found' && <p className="text-sm text-muted-foreground">{t('storage.transfer.notFound')}</p>}
      {result?.outcome === 'unknown' && <p className="break-words text-sm text-muted-foreground" role="status">{t('storage.transfer.unknown')}{result.transferId ? ` · ${result.transferId}` : ''}</p>}
      {result?.outcome === 'not-attempted' && <p className="text-sm text-destructive" role="alert">{result.reason === 'unauthorized' ? t('storage.transfer.unauthorized') : result.reason === 'restart-required' ? t('storage.transfer.restartRequired') : result.reason === 'transfer-conflict' ? t('storage.transfer.conflict') : t('storage.transfer.invalid')}</p>}
    </div>
  </details>;
}
