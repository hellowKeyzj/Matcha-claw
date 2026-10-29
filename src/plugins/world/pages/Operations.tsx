import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '../store';
import { operationWorld, queryWorld, sameWorld, WorldRequestError } from '../store/client';
import type { OperationPhase, OperationRequest, OperationResponse } from '@/types/world';
import { DataTable, Empty, Field, selectClass, TextField } from './components';
import { FixedRecord } from './Definitions';
import { MaterialReadback } from './MaterialReadback';

type Receipt = Extract<OperationResponse, { kind: 'status' }>['result'];
const settled = new Set<OperationPhase>(['completed', 'failed', 'cancelled_before_commit', 'cancelled_after_commit']);

export function Operations() {
  const { t } = useTranslation('world');
  const navigate = useNavigate();
  const world = useWorldStore(state => state.world);
  const description = useWorldStore(state => state.description);
  const reading = useWorldStore(state => state.loading || Boolean(state.error));
  const operations = useWorldStore(state => state.operations).filter(item => world && sameWorld(item.world, world));
  const [id, setId] = useState('');
  const [manualId, setManualId] = useState('');
  const [filter, setFilter] = useState('');
  const [received, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState('');
  const [archiveReadback, setArchiveReadback] = useState<{ key: string; complete: boolean | null; incarnation?: string; revision?: string } | null>(null);
  const readbackVersion = useRef(0);
  const busy = useWorldStore(state => state.operationBusy);
  const pending = useWorldStore(state => state.pendingOperation);
  const pendingKey = pending && (pending.kind === 'resume' || pending.kind === 'cancel' ? pending.request.key : pending.request);
  const selected = id || (pendingKey && world && sameWorld(pendingKey.world, world) ? pendingKey.operationId : operations[0]?.operationId);
  const receipt = received && world && sameWorld(received.accepted.world, world) && received.accepted.operationId === selected ? received : null;
  const selection = useRef({ world, selected });
  selection.current = { world, selected };
  useEffect(() => { setId(''); setManualId(''); setReceipt(null); setError(''); }, [world?.tenantId, world?.worldId]);
  const updateReceipt = (next: Receipt) => {
    const current = selection.current;
    if (!current.world || !sameWorld(current.world, next.accepted.world) || current.selected !== next.accepted.operationId) return;
    setReceipt(previous => previous && previous.accepted.operationId === next.accepted.operationId
      && sameWorld(previous.accepted.world, next.accepted.world)
      && BigInt(previous.accepted.revision) > BigInt(next.accepted.revision) ? previous : next);
  };
  useEffect(() => {
    if (!world || !selected) { setReceipt(null); return; }
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setReceipt(null); setError('');
    const read = async () => {
      try {
        const response = await operationWorld({ kind: 'status', request: { world, operationId: selected } });
        if (!current) return;
        if (response.kind !== 'status' || response.result.accepted.operationId !== selected || !sameWorld(response.result.accepted.world, world)) throw new Error(t('operations.errors.receiptMismatch'));
        updateReceipt(response.result); setError('');
        if (!settled.has(response.result.phase)) timer = setTimeout(() => { void read(); }, ['commit_indeterminate', 'effect_indeterminate', 'retained'].includes(response.result.phase) ? 5000 : 1500);
      } catch (error) {
        if (current) { setReceipt(null); setError(error instanceof Error ? error.message : t('operations.errors.readFailed')); timer = setTimeout(() => { void read(); }, 5000); }
      }
    };
    void read();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [world, selected, t]);
  const send = async (request: OperationRequest) => {
    if (useWorldStore.getState().operationBusy) return;
    useWorldStore.setState({ operationBusy: true }); setError('');
    const key = request.kind === 'resume' || request.kind === 'cancel' ? request.request.key : request.request;
    let confirmed = false;
    try {
      const response = await operationWorld(request);
      if (response.kind !== request.kind) throw new Error(t('operations.errors.responseMismatch'));
      const accepted = response.kind === 'resume' ? response.result : response.kind === 'cancel' ? response.result.receipt.accepted : response.result.accepted;
      if (!sameWorld(accepted.world, key.world) || accepted.operationId !== key.operationId) throw new Error(t('operations.errors.receiptMismatch'));
      confirmed = true;
      useWorldStore.setState({ pendingOperation: null });
      let latest: Receipt;
      if (response.kind === 'resume') {
        useWorldStore.getState().trackOperation(response.result);
        const result = await operationWorld({ kind: 'result', request: key });
        if (result.kind !== 'result' || !sameWorld(result.result.accepted.world, key.world) || result.result.accepted.operationId !== key.operationId) throw new Error(t('operations.errors.receiptMismatch'));
        latest = result.result;
      } else latest = response.kind === 'cancel' ? response.result.receipt : response.result;
      updateReceipt(latest);
      if (settled.has(latest.phase)) await useWorldStore.getState().refresh();
    } catch (error) {
      if (!confirmed && (request.kind === 'resume' || request.kind === 'cancel')) useWorldStore.setState({ pendingOperation: error instanceof WorldRequestError ? null : request });
      if (selection.current.world && sameWorld(selection.current.world, key.world) && selection.current.selected === key.operationId) setError(error instanceof Error ? error.message : t('operations.errors.unknown'));
    } finally { useWorldStore.setState({ operationBusy: false }); }
  };
  const withheld = receipt?.disclosure.kind === 'summary' ? receipt.disclosure.withheld : [];
  const action = !withheld.includes('result_details') && receipt?.result?.kind === 'action' ? receipt.result.result : null;
  const sources = withheld.includes('effects') ? [] : Array.from(new Map([
    ...(receipt?.effects ?? []), ...(action?.sourceReceipts ?? []),
  ].map(effect => [effect.id, effect])).values());
  const commit = receipt?.commit ?? action?.commit;
  const archive = receipt?.phase === 'completed' && !withheld.includes('result_details')
    && (receipt.result?.kind === 'backup' || receipt.result?.kind === 'restore' || (receipt.result?.kind === 'delete' && receipt.result.result.deleted)) ? receipt : null;
  const archiveKey = archive ? JSON.stringify([archive.accepted, archive.result]) : '';
  const archiveReceipt = useRef<Receipt | null>(null);
  archiveReceipt.current = archive;
  const checkArchive = useCallback(async (original: Receipt) => {
    const result = original.result;
    if (!result || (result.kind !== 'backup' && result.kind !== 'restore' && result.kind !== 'delete')) return;
    const key = JSON.stringify([original.accepted, result]);
    const version = ++readbackVersion.current;
    const current = () => version === readbackVersion.current && selection.current.world
      && sameWorld(selection.current.world, original.accepted.world) && selection.current.selected === original.accepted.operationId;
    setArchiveReadback({ key, complete: null });
    let complete = false;
    let basis: { incarnation: string; revision: string } | undefined;
    try {
      if (useWorldStore.getState().busy || useWorldStore.getState().operationBusy || useWorldStore.getState().pending || useWorldStore.getState().pendingOperation || useWorldStore.getState().transferBusy) {
        if (current()) setArchiveReadback({ key, complete: false });
        return;
      }
      const description = await queryWorld(original.accepted.world, { kind: 'discover', request: { includeCapabilities: true } }, 'discover');
      if (!current()) return;
      const incarnation = BigInt(original.accepted.incarnation) + (result.kind === 'backup' ? 0n : 1n);
      const matches = sameWorld(description.world, original.accepted.world) && BigInt(description.incarnation) === incarnation
        && (result.kind === 'delete' ? description.status === 'retained' && result.result.deleted
          : description.status === 'ready' && (result.kind !== 'restore' || description.activeRelease === result.result.releaseId));
      if (matches) {
        const loaded = await useWorldStore.getState().refresh();
        if (!current()) return;
        const state = useWorldStore.getState();
        const latest = state.description;
        complete = Boolean(state.world && sameWorld(state.world, original.accepted.world) && latest
          && sameWorld(latest.world, description.world) && latest.incarnation === description.incarnation
          && latest.revision === description.revision && latest.status === description.status
          && latest.activeRelease === description.activeRelease && !state.loading && !state.error
          && (result.kind === 'delete' || loaded));
        if (complete) basis = { incarnation: description.incarnation, revision: description.revision };
      }
    } catch { /* A current read failure does not change the confirmed operation result. */ }
    if (current()) setArchiveReadback({ key, complete, ...basis });
  }, []);
  useEffect(() => {
    setArchiveReadback(null);
    if (archiveReceipt.current) void checkArchive(archiveReceipt.current);
    return () => { readbackVersion.current++; };
  }, [archiveKey, checkArchive]);
  const readbackComplete = archiveReadback?.complete && !reading && description && world && sameWorld(description.world, world)
    && description.incarnation === archiveReadback.incarnation && description.revision === archiveReadback.revision;
  const records = operations.map(item => ({ operationId: item.operationId, revision: item.revision }));
  if (selected && !records.some(item => item.operationId === selected)) records.unshift({ operationId: selected, revision: receipt?.accepted.revision ?? '' });
  const visible = records.filter(item => item.operationId.toLowerCase().includes(filter.trim().toLowerCase()));
  const progress = receipt ? withheld.includes('progress_counts') ? t('operations.countsWithheld')
    : `${receipt.progress.completed}${receipt.progress.total != null ? ` / ${receipt.progress.total}` : ''}` : t('atelier.logs.unread');
  const trace: { key: string; at: string; title: string; detail: ReactNode }[] = [];
  if (receipt) {
    for (const effect of sources) trace.push({
      key: `effect:${effect.id}`, at: effect.observedAt, title: t(`operations.disposition.${effect.disposition}`),
      detail: <><p className="break-all">{effect.sourceId}</p><p className="mt-1 break-all font-mono">{effect.id}</p></>,
    });
    for (const verification of action?.verifications ?? []) trace.push({
      key: `verification:${verification.id}`, at: verification.verifiedAt, title: t('actions.receipts.verification'),
      detail: <><p>{t(`actions.verdict.${verification.verdict}`)}</p><p className="mt-1 break-all font-mono">{verification.id}</p></>,
    });
    if (commit) trace.push({ key: `commit:${commit.commitId}`, at: commit.committedAt, title: t('atelier.logs.commitReceipt'), detail: <p className="break-all font-mono">{commit.commitId}</p> });
    trace.push({ key: 'latest', at: receipt.updatedAt, title: t('atelier.logs.latestReceipt'), detail: <><p>{t(`operations.phase.${receipt.phase}`)}</p><p className="mt-1">{receipt.progress.stage} · {progress}</p>{receipt.progress.runId && <p className="mt-1 break-all font-mono">{receipt.progress.runId}</p>}{receipt.progress.stepId && <p className="mt-1 break-all font-mono">{receipt.progress.stepId}</p>}</> });
    trace.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  }
  return <section className="min-w-0 space-y-5" aria-label={t('operations.title')}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-base font-semibold">{t('operations.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{t('atelier.logs.timelineDescription')}</p></div>
      <Button type="button" size="sm" variant="outline" disabled={!world || !selected || busy || Boolean(pending)} onClick={() => { if (world && selected) void send({ kind: 'status', request: { world, operationId: selected } }); }}>{t('operations.refreshReceipt')}</Button>
    </header>
    {pending && <div className="world-panel flex flex-wrap items-center justify-between gap-3 p-4 text-sm" role="status"><div className="min-w-0"><p>{t('operations.pending')}</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{pendingKey?.world.tenantId} / {pendingKey?.world.worldId} / {pendingKey?.operationId}</p></div><Button size="sm" variant="outline" disabled={busy} onClick={() => { void send(pending); }}>{t('operations.retryOriginal')}</Button></div>}
    <section className="world-panel" aria-label={t('operations.findHistory')}>
      <form className="world-panel-body flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); if (!busy && !pending) setId(manualId.trim()); }}>
        <div className="min-w-0 flex-1"><TextField label={t('operations.operationId')} value={manualId} onChange={setManualId} placeholder="operationId" /></div>
        <Button type="submit" size="sm" variant="outline" disabled={!world || !manualId.trim() || busy || Boolean(pending)}>{t('operations.findHistory')}</Button>
      </form>
    </section>
    <div className="world-logs-layout items-start">
      <div className="min-w-0 space-y-5">
        <section className="world-panel min-w-0" aria-labelledby="world-operation-timeline">
          <header className="world-panel-header"><div className="min-w-0"><h2 id="world-operation-timeline" className="text-sm font-semibold">{t('atelier.logs.timeline')}</h2>{selected && <p className="mt-2 break-all font-mono text-xs text-muted-foreground">{selected}</p>}</div>{receipt && <span className="world-status" data-status={receipt.phase}>{t(`operations.phase.${receipt.phase}`)}</span>}</header>
          <div className="world-panel-body space-y-5">
            {receipt ? <>
              <p className="text-xs leading-relaxed text-muted-foreground">{t('operations.acceptedNotice')}</p>
              <dl className="grid gap-4 border-y border-[hsl(var(--shell-border))] py-4 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-muted-foreground">{t('operations.currentStage')}</dt><dd className="mt-1 break-words font-medium">{receipt.progress.stage}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t('atelier.logs.selectedProgress')}</dt><dd className="mt-1 tabular-nums">{progress}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{t('atelier.logs.observed')}</dt><dd className="mt-1"><time dateTime={receipt.updatedAt}>{new Date(receipt.updatedAt).toLocaleString()}</time></dd></div>
                <div><dt className="text-xs text-muted-foreground">{t('operations.cancelLabel')}</dt><dd className="mt-1">{t(`operations.cancelState.${receipt.cancellation}`)}</dd></div>
              </dl>
              <p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.logs.traceDescription')}</p>
              <ol className="world-trace">{trace.map(item => <li className="min-w-0" key={item.key} aria-current={item.key === 'latest' ? 'step' : undefined}><div className="flex flex-wrap items-baseline justify-between gap-2"><h3 className="text-sm font-medium">{item.title}</h3><time className="text-xs text-muted-foreground" dateTime={item.at}>{new Date(item.at).toLocaleString()}</time></div><div className="mt-2 text-xs leading-relaxed text-muted-foreground">{item.detail}</div></li>)}</ol>
              {commit && <p className="break-all text-xs text-muted-foreground">{t('operations.commit', { id: commit.commitId })}</p>}
              {receipt.failure && <div className="rounded-lg border border-destructive/30 p-3 text-sm" role="alert"><p className="break-words">{receipt.failure.message}</p><p className="mt-2 break-all text-xs">{receipt.failure.code} · {receipt.failure.stage} · {t('shell.diagnosticId', { id: receipt.failure.diagnosticId })}</p><details className="mt-3"><summary className="cursor-pointer text-xs">{t('atelier.logs.recovery')}</summary><div className="mt-2"><FixedRecord value={receipt.failure.recovery} /></div></details></div>}
              <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || Boolean(pending)} onClick={() => { void send({ kind: 'result', request: { world: receipt.accepted.world, operationId: receipt.accepted.operationId } }); }}>{t('operations.finalReceipt')}</Button>{!settled.has(receipt.phase) && <Button size="sm" variant="outline" disabled={busy || Boolean(pending)} onClick={() => { void send({ kind: 'cancel', request: { key: { world: receipt.accepted.world, operationId: receipt.accepted.operationId }, expectedRevision: receipt.accepted.revision } }); }}>{t('operations.cancel')}</Button>}{['admitted', 'running', 'waiting_dependency', 'retained', 'commit_indeterminate', 'effect_indeterminate'].includes(receipt.phase) && <Button size="sm" variant="outline" disabled={busy || Boolean(pending)} onClick={() => { void send({ kind: 'resume', request: { key: { world: receipt.accepted.world, operationId: receipt.accepted.operationId }, expectedRevision: receipt.accepted.revision, requestId: crypto.randomUUID() } }); }}>{t('operations.resume')}</Button>}</div>
              <p className="text-xs leading-relaxed text-muted-foreground">{t('operations.cancellation', { status: t(`operations.cancelState.${receipt.cancellation}`) })}</p>
            </> : selected ? !error && <p className="text-sm text-muted-foreground" role="status">{t('atelier.logs.reading')}</p> : <Empty>{t('atelier.logs.selectTrace')}</Empty>}
            {error && <p className="break-words text-sm text-destructive" role="alert">{error}</p>}
          </div>
        </section>
        {receipt && <section className="world-panel min-w-0" aria-label={t('operations.resultAndReceipts')}>
          <header className="world-panel-header"><h2 className="text-sm font-semibold">{t('operations.resultAndReceipts')}</h2></header>
          <div className="world-panel-body min-w-0 space-y-4">
            {!!withheld.length && <p className="rounded-lg border border-[hsl(var(--shell-border))] bg-[hsl(var(--shell-surface-muted))] p-3 text-sm leading-relaxed text-muted-foreground">{t('operations.withheld', { details: withheld.map(item => t(`operations.detail.${item}`)).join(' / ') })}</p>}
            {archive && <div className="space-y-3 rounded-lg border border-[hsl(var(--shell-border))] p-3">
              <div className="flex flex-wrap gap-2">
                {archive.result?.kind === 'backup' && <Button type="button" size="sm" variant="outline" onClick={() => {
                  const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' }));
                  const anchor = document.createElement('a');
                  anchor.href = url; anchor.download = 'world-backup-receipt.json'; anchor.rel = 'noopener';
                  document.body.append(anchor);
                  try { anchor.click(); } finally { anchor.remove(); URL.revokeObjectURL(url); }
                }}>{t('archive.download')}</Button>}
                <Button type="button" size="sm" variant="outline" disabled={busy || Boolean(pending) || (archiveReadback?.key === archiveKey && archiveReadback.complete === null)} onClick={() => { void checkArchive(archive); }}>{t('archive.readback')}</Button>
              </div>
              {archive.result?.kind === 'backup' && <p className="text-xs leading-relaxed text-muted-foreground">{t('archive.manifestHint')}</p>}
              {archiveReadback?.key === archiveKey && <p className="text-sm" role="status">{t(archiveReadback.complete === null ? 'shell.reading' : readbackComplete ? 'archive.readbackComplete' : 'archive.readbackIncomplete')}</p>}
            </div>}
            {!withheld.includes('result_details') && receipt.result?.kind === 'materials' && <div className="space-y-3"><DataTable columns={[t('operations.confirmedResult'), t('operations.count')]} rows={[[t('operations.sourceVersions'), receipt.result.result.sourceVersions.length], [t('operations.parseArtifacts'), receipt.result.result.parseArtifacts.length], [t('operations.candidates'), receipt.result.result.candidates.length], [t('operations.drafts'), receipt.result.result.drafts.length]]} /><div className="flex flex-wrap gap-2">{receipt.result.result.drafts.map(draft => <Button key={`${draft.runId}:${draft.stepId}:${draft.revision}`} size="sm" variant="outline" onClick={() => { useWorldStore.getState().reviewMaterialDraft(draft); navigate('/world?tab=materials'); }}>{t('operations.reviewDraft', { revision: draft.revision })}</Button>)}</div></div>}
            {!withheld.includes('result_details') && receipt.result?.kind === 'materials' && <MaterialReadback key={receipt.accepted.operationId} sources={receipt.result.result.sourceVersions} artifacts={receipt.result.result.parseArtifacts} />}
            {!withheld.includes('result_details') && receipt.result?.kind === 'delete' && <div className="space-y-3"><p className="text-sm">{receipt.result.result.deleted ? t('operations.deleted') : t('operations.deletionPending')}</p><DataTable columns={[t('operations.retainedKind'), t('operations.count')]} rows={receipt.result.result.retained.map(item => [t(`operations.retained.${item.kind}`), item.count])} empty={t('operations.noRetained')} /><p className="text-xs text-muted-foreground">{t('operations.separateCounts')}</p></div>}
            {receipt.result && (!withheld.includes('result_details') || receipt.result.kind === 'evaluation_summary') && <details className="min-w-0 rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('atelier.logs.resultDetails')}</summary><div className="mt-3 min-w-0"><FixedRecord value={receipt.result} /></div></details>}
            {!withheld.includes('effects') && <details className="min-w-0 rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('atelier.logs.sourceReceipts')}<span className="ml-2 text-xs tabular-nums text-muted-foreground">{sources.length}</span></summary><div className="mt-3 space-y-3"><DataTable columns={[t('operations.source'), t('operations.effect'), t('operations.observedAt')]} rows={sources.map(effect => [effect.sourceId, t(`operations.disposition.${effect.disposition}`), new Date(effect.observedAt).toLocaleString()])} empty={t('actions.receipts.noSource')} />{!!sources.length && <FixedRecord value={sources} />}</div></details>}
            {action && <details className="min-w-0 rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('actions.receipts.verification')}</summary><div className="mt-3 space-y-3"><DataTable columns={[t('actions.receipts.verification'), t('actions.receipts.verdict'), t('actions.receipts.verifiedAt')]} rows={action.verifications.map(item => [item.id, t(`actions.verdict.${item.verdict}`), new Date(item.verifiedAt).toLocaleString()])} empty={t('actions.receipts.noVerification')} />{!!action.verifications.length && <FixedRecord value={action.verifications} />}</div></details>}
            {commit && !withheld.includes('committed_revisions') && <details className="min-w-0 rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('atelier.logs.commitReceipt')}</summary><div className="mt-3"><FixedRecord value={commit} /></div></details>}
            {receipt.failure && !withheld.includes('failure_details') && <details className="min-w-0 rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('operations.failureDetails')}</summary><div className="mt-3 min-w-0"><FixedRecord value={receipt.failure.details} /></div></details>}
            <details className="min-w-0 rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('atelier.logs.identity')}</summary><div className="mt-3 min-w-0"><FixedRecord value={{ accepted: receipt.accepted, runId: receipt.progress.runId, stepId: receipt.progress.stepId }} /></div></details>
          </div>
        </section>}
      </div>
      <aside className="world-panel min-w-0" aria-labelledby="world-operation-records">
        <header className="world-panel-header"><h2 id="world-operation-records" className="text-sm font-semibold">{t('operations.sessionRecords')}</h2><span className="text-xs tabular-nums text-muted-foreground">{operations.length}</span></header>
        <div className="world-panel-body space-y-4">
          <p className="text-xs leading-relaxed text-muted-foreground">{t('atelier.logs.scope')}</p>
          <TextField label={t('atelier.logs.search')} value={filter} onChange={setFilter} required={false} />
          <Field label={t('operations.select')}><select className={`${selectClass} w-full`} disabled={busy || Boolean(pending)} value={selected ?? ''} onChange={event => setId(event.target.value)}><option value="">{t('operations.select')}</option>{operations.map((item, index) => <option key={item.operationId} value={item.operationId}>{t('operations.recordLabel', { number: operations.length - index, id: item.operationId.slice(-8) })}</option>)}{selected && !operations.some(item => item.operationId === selected) && <option value={selected}>{selected}</option>}</select></Field>
        </div>
        {visible.length ? <ul className="max-h-[32rem] overflow-y-auto border-t border-[hsl(var(--shell-border))]">{visible.map(item => {
          const current = receipt?.accepted.operationId === item.operationId ? receipt : null;
          return <li key={item.operationId} className="border-b border-[hsl(var(--shell-border))] last:border-b-0"><button type="button" className={`w-full space-y-2 px-5 py-4 text-left hover:bg-[hsl(var(--shell-surface-muted))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50 ${selected === item.operationId ? 'bg-[hsl(var(--shell-surface-muted))]' : ''}`} disabled={busy || Boolean(pending)} onClick={() => setId(item.operationId)} aria-pressed={selected === item.operationId}>
            <span className="block break-all font-mono text-xs">{item.operationId}</span>
            <span className="flex flex-wrap items-center justify-between gap-2"><span className="world-status text-xs" data-status={current?.phase ?? 'unread'}>{current ? t(`operations.phase.${current.phase}`) : t('atelier.logs.unread')}</span><span className="text-xs text-muted-foreground">{t('atelier.logs.revision')} {current?.accepted.revision ?? item.revision}</span></span>
            {current && <span className="block break-words text-xs text-muted-foreground">{current.progress.stage} · {new Date(current.updatedAt).toLocaleString()}</span>}
          </button></li>;
        })}</ul> : <Empty>{t(records.length ? 'atelier.logs.noMatches' : 'atelier.logs.noRecords')}</Empty>}
        <footer className="border-t border-[hsl(var(--shell-border))] px-5 py-3 text-xs text-muted-foreground">{t('atelier.logs.shown', { shown: visible.length, total: records.length })}</footer>
      </aside>
    </div>
  </section>;
}
