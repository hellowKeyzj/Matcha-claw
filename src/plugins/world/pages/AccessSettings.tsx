import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorldStore } from '../store';
import { commitWorldAccess, prepareWorldAccess, sameWorld } from '../store/client';
import type { WorldAccessIdentity, WorldAccessImportResult, WorldAccessIssue, WorldAccessPrepareResult } from '@/types/world-access';
import { DataTable } from './components';
import { FixedRecord } from './Definitions';
import { useWorldConfirmation } from './WorldConfirmation';

type PreparedAccess = Extract<WorldAccessPrepareResult, { outcome: 'prepared' }> & { basis: string };

export function AccessSettings() {
  const { t } = useTranslation('world');
  const confirm = useWorldConfirmation();
  const location = useLocation();
  const state = useWorldStore();
  const [prepared, setPrepared] = useState<PreparedAccess | null>(null);
  const [original, setOriginal] = useState<WorldAccessIdentity | null>(null);
  const [result, setResult] = useState<WorldAccessImportResult | null>(null);
  const [issue, setIssue] = useState<WorldAccessIssue | null>(null);
  const [busy, setBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const working = useRef(false);
  const version = useRef(0);
  const ticket = useRef<PreparedAccess | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const world = state.world;
  const description = world && state.description && sameWorld(state.description.world, world) ? state.description : null;
  const basis = JSON.stringify([location.key, world, description?.incarnation, description?.revision]);
  const currentBasis = useRef(basis);
  currentBasis.current = basis;
  useEffect(() => () => {
    version.current++;
    const held = ticket.current;
    ticket.current = null;
    if (held) void commitWorldAccess({ world: held.summary.world, ticket: held.ticket, accept: false }).catch(() => undefined);
  }, [basis]);
  const ready = description?.status === 'ready';
  const blocked = busy || state.loading || state.busy || state.operationBusy || Boolean(state.pending)
    || Boolean(state.pendingOperation) || state.transferBusy;
  const preview = prepared?.basis === basis && ticket.current === prepared ? prepared : null;
  const identity = result && 'world' in result ? result : original;
  const checkingOriginal = unconfirmed || Boolean(original);
  const status = result?.outcome === 'cancel' ? 'cancelled' : result?.outcome === 'not-attempted' ? 'notAttempted' : result?.outcome;
  const current = (read: number) => {
    const latest = useWorldStore.getState();
    return mounted.current && read === version.current && currentBasis.current === basis && world && latest.world
      && sameWorld(latest.world, world) && latest.description && sameWorld(latest.description.world, world)
      && JSON.stringify([location.key, latest.world, latest.description.incarnation, latest.description.revision]) === basis;
  };
  const canWrite = () => {
    const latest = useWorldStore.getState();
    return latest.description?.status === 'ready' && !latest.loading && !latest.busy && !latest.operationBusy
      && !latest.pending && !latest.pendingOperation && !latest.transferBusy;
  };
  const prepare = async () => {
    if (!world || !ready || blocked || preview || working.current || !current(version.current) || !canWrite()
      || (original && !sameWorld(original.world, world))) return;
    working.current = true; setBusy(true); setNotice('');
    if (!original) { setResult(null); setIssue(null); }
    const read = ++version.current;
    try {
      const next = await prepareWorldAccess({ world });
      if (next.outcome === 'prepared') {
        if (!current(read) || !sameWorld(next.summary.world, world)
          || (original && (next.summary.commitId !== original.commitId || next.summary.grantId !== original.grantId))) {
          await commitWorldAccess({ world: next.summary.world, ticket: next.ticket, accept: false });
          if (current(read)) setNotice('access.receiptMismatch');
          return;
        }
        const held = { ...next, basis };
        ticket.current = held; setPrepared(held);
      } else if (current(read)) {
        if (original) setNotice(next.outcome === 'cancel' ? 'access.cancelled' : 'access.notAttempted');
        else setResult(next);
        if (next.outcome === 'not-attempted') setIssue(next.error);
      }
    } catch { if (current(read)) setNotice('access.notAttempted'); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  const commit = async (accept: boolean) => {
    const held = ticket.current;
    if (!world || !preview || !held || held !== preview || blocked || working.current
      || (accept && (!ready || !current(version.current) || !canWrite()))) return;
    working.current = true; setBusy(true); setNotice('');
    const read = ++version.current;
    let dispatched = false;
    try {
      const accepted = accept && await confirm([
        t('access.title'), `${t('storage.initial.world')}: ${world.tenantId} / ${world.worldId}`,
        `${t('storage.initial.commitId')}: ${held.summary.commitId}`, `${t('access.grantId')}: ${held.summary.grantId}`,
      ].join('\n'));
      if (ticket.current !== held) return;
      ticket.current = null; setPrepared(null);
      const apply = accepted && Boolean(current(read)) && canWrite();
      if (apply) {
        setOriginal({ world, commitId: held.summary.commitId, grantId: held.summary.grantId });
        setIssue(null);
        dispatched = true;
      }
      const next = await commitWorldAccess({ world: held.summary.world, ticket: held.ticket, accept: apply });
      if (!current(read)) return;
      if (next.outcome === 'cancel' || next.outcome === 'not-attempted') {
        if (original) setNotice(next.outcome === 'cancel' ? 'access.cancelled' : 'access.notAttempted');
        else setResult(next);
        if (next.outcome === 'not-attempted') setIssue(next.error);
        return;
      }
      if (!sameWorld(next.world, world) || next.commitId !== held.summary.commitId || next.grantId !== held.summary.grantId
        || (next.outcome === 'confirmed' && (!sameWorld(next.receipt.world, world) || next.receipt.commitId !== held.summary.commitId))) {
        setUnconfirmed(true); setNotice('access.receiptMismatch');
        return;
      }
      setResult(next); setIssue('error' in next ? next.error : null); setUnconfirmed(false);
      if (next.outcome === 'confirmed' || next.outcome === 'rejected') setOriginal(null);
    } catch {
      if (current(read)) {
        if (dispatched) setUnconfirmed(true);
        setNotice(dispatched ? 'access.responseUnconfirmed' : 'access.notAttempted');
      }
    } finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  return <details className="world-settings-row group/access min-w-0 border-b border-[hsl(var(--shell-border))]" aria-busy={busy}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <span className="min-w-0"><span className="block text-sm font-medium">{t('settings.accessTitle')}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t('settings.accessHint')}</span></span>
      <span className="flex shrink-0 items-center gap-2">{busy ? <span className="text-xs text-muted-foreground">{t('shell.processing')}</span> : (status || checkingOriginal) && <span className="text-xs text-muted-foreground">{t(checkingOriginal ? 'access.checkOriginal' : `access.${status}`)}</span>}<ChevronDown className="h-4 w-4 shrink-0 -rotate-90 text-muted-foreground group-open/access:rotate-0" aria-hidden="true" /></span>
    </summary>
    <div className="space-y-4 pb-5">
      <p className="text-xs leading-relaxed text-muted-foreground">{t('access.hint')}</p>
      {!ready && <p className="text-sm text-muted-foreground">{t('shell.openFirst')}</p>}
      <Button type="button" size="sm" variant="outline" disabled={!ready || blocked || Boolean(preview) || Boolean(original && world && !sameWorld(original.world, world))} onClick={() => { void prepare(); }}>{t(checkingOriginal ? 'access.checkOriginal' : 'access.chooseConfiguration')}</Button>
      {preview && <div className="space-y-3 border-t border-[hsl(var(--shell-border))] pt-4">
        <pre data-testid="world-access-preview" tabIndex={0} className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[hsl(var(--shell-border))] p-3 text-xs">{preview.summary.preview}</pre>
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={blocked || !ready} onClick={() => { void commit(true); }}>{t('common:actions.confirm')}</Button><Button type="button" size="sm" variant="outline" disabled={blocked} onClick={() => { void commit(false); }}>{t('common:actions.cancel')}</Button></div>
      </div>}
      {status && <p className="text-sm leading-relaxed" role={result?.outcome === 'rejected' || result?.outcome === 'not-attempted' ? 'alert' : 'status'}>{t(`access.${status}`)}</p>}
      {notice && <p className="text-sm leading-relaxed" role="status">{t(notice)}</p>}
      {identity && <DataTable columns={[t('storage.initial.receipt'), t('storage.result')]} rows={[
        [t('storage.initial.world'), `${identity.world.tenantId} / ${identity.world.worldId}`],
        [t('storage.initial.commitId'), identity.commitId], [t('access.grantId'), identity.grantId],
      ]} />}
      {checkingOriginal && <p className="text-xs leading-relaxed text-muted-foreground">{t('access.checkHint')}</p>}
      {result?.outcome === 'confirmed' && <details className="rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('access.receipt')}</summary><div className="mt-3"><FixedRecord value={result.receipt} /></div></details>}
      {issue && <div className="space-y-3" role="alert"><DataTable columns={[t('storage.diagnostic.title'), t('storage.diagnostic.result')]} rows={[
        [t('storage.diagnostic.source'), issue.source], [t('storage.diagnostic.reason'), issue.reason],
        [t('storage.diagnostic.code'), issue.code], [t('storage.diagnostic.stage'), issue.stage], [t('storage.diagnostic.id'), issue.diagnosticId],
      ]} /><details className="rounded-lg border border-[hsl(var(--shell-border))] p-3"><summary className="cursor-pointer text-sm">{t('storage.diagnostic.recovery')}</summary><div className="mt-3 space-y-3"><FixedRecord value={issue.recovery} /><FixedRecord value={issue.details} /></div></details></div>}
    </div>
  </details>;
}
