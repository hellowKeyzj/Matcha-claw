import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '../store';
import { commitWorldEvaluation, prepareWorldEvaluation, sameWorld, worldEvaluationStatus } from '../store/client';
import type { WorldEvaluationCommitResult, WorldEvaluationIdentity, WorldEvaluationIssue, WorldEvaluationSummary, WorldEvaluationStatusResult } from '@/types/world-evaluation';
import { DataTable } from './components';
import { FixedRecord } from './Definitions';
import { useWorldConfirmation } from './WorldConfirmation';

type PreparedEvaluation = { ticket: string; summary: WorldEvaluationSummary; basis: string };

export function EvaluationSettings() {
  const world = useWorldStore(state => state.world);
  return <EvaluationConfiguration key={JSON.stringify(world)} />;
}

function EvaluationConfiguration() {
  const { t } = useTranslation('world');
  const confirm = useWorldConfirmation();
  const state = useWorldStore();
  const [prepared, setPrepared] = useState<PreparedEvaluation | null>(null);
  const [original, setOriginal] = useState<WorldEvaluationIdentity | null>(null);
  const [result, setResult] = useState<WorldEvaluationCommitResult | null>(null);
  const [status, setStatus] = useState<{ basis: string; result: WorldEvaluationStatusResult } | null>(null);
  const [issue, setIssue] = useState<WorldEvaluationIssue | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const working = useRef(false);
  const version = useRef(0);
  const ticket = useRef<PreparedEvaluation | null>(null);
  const world = state.world;
  const description = world && state.description && sameWorld(state.description.world, world) ? state.description : null;
  const basis = JSON.stringify([world, description?.incarnation, description?.revision]);
  const ready = description?.status === 'ready';
  const blocked = busy || state.loading || state.busy || state.operationBusy || Boolean(state.pending)
    || Boolean(state.pendingOperation) || state.transferBusy;
  const current = useCallback((read: number) => {
    const latest = useWorldStore.getState();
    const description = latest.world && latest.description && sameWorld(latest.description.world, latest.world) ? latest.description : null;
    return mounted.current && read === version.current && world && latest.world && sameWorld(latest.world, world)
      && JSON.stringify([latest.world, description?.incarnation, description?.revision]) === basis;
  }, [world, basis]);
  const canWrite = () => {
    const latest = useWorldStore.getState();
    return latest.description?.status === 'ready' && !latest.loading && !latest.busy && !latest.operationBusy
      && !latest.pending && !latest.pendingOperation && !latest.transferBusy;
  };
  const configuration = status?.basis === basis ? status.result : null;
  const preview = prepared?.basis === basis && ticket.current === prepared ? prepared : null;
  const originalSaved = original && configuration?.outcome === 'available' && configuration.configured && configuration.commitId === original.commitId;
  const checkingOriginal = Boolean(original && !originalSaved && (!result || result.outcome === 'unknown'));
  const issues = [issue, configuration?.outcome === 'unavailable' ? configuration.error : null].filter(value => value !== null);
  const identity = original ?? (preview ? preview.summary : configuration?.outcome === 'available' && configuration.commitId
    ? { world: configuration.world, commitId: configuration.commitId } : null);
  const canChoose = ready && !blocked && !preview && !checkingOriginal && configuration?.outcome === 'available'
    && !configuration.configured && !configuration.commitId && result?.outcome !== 'confirmed';
  const readStatus = useCallback(async (read: number) => {
    if (!world || !current(read)) return;
    setStatus(null);
    try {
      const next = await worldEvaluationStatus({ world });
      if (!current(read)) return;
      if (next.outcome === 'available' && !sameWorld(next.world, world)) {
        setNotice('evaluationSettings.receiptMismatch');
        return;
      }
      setStatus({ basis, result: next });
    } catch { if (current(read)) setNotice('evaluationSettings.statusUnconfirmed'); }
  }, [world, basis, current]);
  const checkStatus = async () => {
    if (!world || blocked || preview || working.current || !current(version.current)) return;
    working.current = true; setBusy(true);
    try { await readStatus(++version.current); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    void readStatus(++version.current);
    return () => {
      const held = ticket.current;
      ticket.current = null;
      if (held) void commitWorldEvaluation({ world: held.summary.world, ticket: held.ticket, accept: false }).catch(() => undefined);
    };
  }, [readStatus]);

  const prepare = async () => {
    if (!world || !canChoose || working.current || !current(version.current) || !canWrite()) return;
    working.current = true; setBusy(true); setNotice(''); setIssue(null);
    const read = ++version.current;
    try {
      const next = await prepareWorldEvaluation({ world });
      if (next.outcome === 'prepared') {
        if (!current(read) || !sameWorld(next.summary.world, world)) {
          await commitWorldEvaluation({ world, ticket: next.ticket, accept: false });
          if (current(read)) setNotice('evaluationSettings.receiptMismatch');
          return;
        }
        const held = { ticket: next.ticket, summary: next.summary, basis };
        ticket.current = held; setPrepared(held); setOriginal(null); setResult(null);
      } else if (current(read)) {
        setNotice(next.outcome === 'cancel' ? 'evaluationSettings.cancelled' : 'evaluationSettings.notAttempted');
        if (next.outcome === 'not-attempted') setIssue(next.error);
      }
    } catch { if (current(read)) setNotice('evaluationSettings.prepareUnconfirmed'); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const commit = async (accept: boolean) => {
    const held = ticket.current;
    if (!world || !preview || !held || held !== preview || !ready || blocked || working.current || !current(version.current) || !canWrite()) return;
    working.current = true; setBusy(true); setNotice('');
    const read = ++version.current;
    let dispatched = false;
    try {
      const accepted = accept && await confirm(t('evaluationSettings.confirm', {
        world: `${world.tenantId} / ${world.worldId}`, commitId: held.summary.commitId,
      }));
      if (ticket.current !== held) return;
      ticket.current = null;
      const apply = accepted && Boolean(current(read)) && canWrite();
      if (current(read)) setPrepared(null);
      if (!apply) {
        const cancelled = await commitWorldEvaluation({ world, ticket: held.ticket, accept: false });
        if (!current(read)) return;
        setNotice(cancelled.outcome === 'cancel' ? 'evaluationSettings.cancelled' : 'evaluationSettings.releaseUnconfirmed');
        if ('error' in cancelled) setIssue(cancelled.error);
        return;
      }
      setOriginal({ world, commitId: held.summary.commitId }); setResult(null); setStatus(null); setIssue(null);
      dispatched = true;
      const next = await commitWorldEvaluation({ world, ticket: held.ticket, accept: true });
      if (!current(read)) return;
      if (('world' in next && (!sameWorld(next.world, world) || next.commitId !== held.summary.commitId))
        || (next.outcome === 'confirmed' && (!sameWorld(next.receipt.world, world) || next.receipt.commitId !== held.summary.commitId))) {
        setNotice('evaluationSettings.receiptMismatch');
      } else {
        setResult(next);
        if ('error' in next) setIssue(next.error);
      }
    } catch { if (current(read)) setNotice(dispatched ? 'evaluationSettings.responseUnconfirmed' : 'evaluationSettings.releaseUnconfirmed'); }
    finally {
      if (dispatched && current(read)) await readStatus(read);
      working.current = false; if (mounted.current) setBusy(false);
    }
  };
  const outcome = result?.outcome === 'cancel' ? 'cancelled' : result?.outcome === 'not-attempted' ? 'notAttempted' : result?.outcome;
  const statusLabel = !configuration ? 'statusUnread' : configuration.outcome === 'unavailable' ? 'statusUnavailable'
    : configuration.configured ? 'configured' : configuration.commitId ? 'unknown' : 'notConfigured';
  const summaryLabel = !configuration ? 'storage.notReturned' : configuration.outcome === 'unavailable' ? 'atelier.storage.configurationUnavailable'
    : configuration.configured ? 'evaluationSettings.configured' : configuration.commitId ? 'storage.initial.pendingStatus' : 'atelier.storage.configurationPending';
  return <details className="world-settings-row group/evaluation min-w-0 border-b border-[hsl(var(--shell-border))]" aria-busy={busy}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <span className="min-w-0"><span className="block text-sm font-medium">{t('settings.evaluationTitle')}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t('settings.evaluationHint')}</span></span>
      <span className="flex shrink-0 items-center gap-2"><span className="text-xs text-muted-foreground">{t(summaryLabel)}</span><ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground group-open/evaluation:rotate-0" aria-hidden="true" /></span>
    </summary>
    <div className="space-y-4 pb-5">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('evaluationSettings.hint')}</p>
      <p className="text-sm leading-relaxed">{t('evaluationSettings.isolation')}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('evaluationSettings.authorizationBoundary')}</p>
      {!ready && <p className="text-sm text-muted-foreground">{t('shell.openFirst')}</p>}
      <p className="text-sm leading-relaxed" role="status">{t(`evaluationSettings.${statusLabel}`)}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!canChoose} onClick={() => { void prepare(); }}>{t('evaluationSettings.chooseConfiguration')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={!world || blocked || Boolean(preview)} onClick={() => { void checkStatus(); }}>{t(checkingOriginal ? 'evaluationSettings.checkOriginal' : 'storage.refresh')}</Button>
      </div>
      {preview && <div className="space-y-3 border-t border-[hsl(var(--shell-border))] pt-4">
        <h3 className="text-sm font-medium">{t('evaluationSettings.summary')}</h3>
        <DataTable columns={[t('storage.diagnostic.title'), t('storage.result')]} rows={[
          [t('storage.initial.world'), `${preview.summary.world.tenantId} / ${preview.summary.world.worldId}`],
          [t('storage.initial.commitId'), preview.summary.commitId],
          [t('evaluationSettings.principalCount'), preview.summary.principalCount], [t('evaluationSettings.grantCount'), preview.summary.grantCount],
          [t('evaluationSettings.policyCount'), preview.summary.policyCount], [t('evaluationSettings.retentionPolicyCount'), preview.summary.retentionPolicyCount],
          [t('evaluationSettings.caseAccess'), `${preview.summary.caseAccess.policyId} / ${preview.summary.caseAccess.revision}${preview.summary.caseAccess.labels.length ? ` · ${preview.summary.caseAccess.labels.join(' / ')}` : ''}`],
          [t('evaluationSettings.caseRetention'), `${preview.summary.caseRetention.policyId} / ${preview.summary.caseRetention.revision}`],
        ]} />
        <p className="text-xs leading-relaxed text-muted-foreground">{t('evaluationSettings.retentionHint')}</p>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={blocked || !ready} onClick={() => { void commit(true); }}>{t('evaluationSettings.apply')}</Button><Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => { void commit(false); }}>{t('evaluationSettings.cancel')}</Button></div>
      </div>}
      {identity && !preview && <DataTable columns={[t('evaluationSettings.submission'), t('storage.result')]} rows={[
        [t('storage.initial.world'), `${identity.world.tenantId} / ${identity.world.worldId}`], [t('storage.initial.commitId'), identity.commitId],
      ]} />}
      {original && configuration?.outcome === 'available' && configuration.commitId && configuration.commitId !== original.commitId && <p className="text-sm leading-relaxed" role="alert">{t('evaluationSettings.statusCommitMismatch', { commitId: configuration.commitId })}</p>}
      {outcome && <p className="text-sm leading-relaxed" role={result?.outcome === 'rejected' || result?.outcome === 'not-attempted' ? 'alert' : 'status'}>{t(`evaluationSettings.${outcome}`)}</p>}
      {notice && <p className="text-sm leading-relaxed" role="status">{t(notice)}</p>}
      {checkingOriginal && <p className="text-xs leading-relaxed text-muted-foreground">{t('evaluationSettings.checkHint')}</p>}
      {issues.map((issue, index) => <div className="space-y-3" role="alert" key={index}><DataTable columns={[t('storage.diagnostic.title'), t('storage.diagnostic.result')]} rows={[
        [t('storage.diagnostic.source'), issue.source], [t('storage.diagnostic.reason'), issue.reason],
        [t('storage.diagnostic.code'), issue.code], [t('storage.diagnostic.stage'), issue.stage], [t('storage.diagnostic.id'), issue.diagnosticId],
      ]} /><details className="rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('storage.diagnostic.recovery')}</summary><div className="mt-3 space-y-3"><FixedRecord value={issue.recovery} /><FixedRecord value={issue.details} /></div></details></div>)}
    </div>
  </details>;
}
