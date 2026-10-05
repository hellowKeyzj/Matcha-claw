import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { waitForCall } from '@/lib/call-log-await';
import { hostWikiCallResult, hostWikiCancelDedup, hostWikiDedupState, hostWikiDetectDuplicates, hostWikiExcludeDuplicates, hostWikiMergeDuplicates, hostWikiResumeDedup, hostWikiRetryDedup } from '@/lib/host-api';
import type { WikiDedupTask, WikiDuplicateGroup } from '@/types/wiki-capabilities';
import { WikiPrimaryButton, WikiSurface } from './WikiChrome';

type GroupEntry = { group: WikiDuplicateGroup; canonicalSlug: string; outcome: 'candidate' | 'excluded' | 'merged' };
type DedupAction = 'dedup.merge' | 'dedup.retry' | 'dedup.resume';

function groupKey(slugs: readonly string[]): string {
  return JSON.stringify([...slugs].sort());
}

export function DedupPanel({ projectId, modelRef, busy, onChanged }: Readonly<{
  projectId: string;
  modelRef: string;
  busy: string | null;
  onChanged(): Promise<void>;
}>) {
  const { t } = useTranslation('wiki');
  const [groups, setGroups] = useState<GroupEntry[]>([]);
  const [confirmation, setConfirmation] = useState<GroupEntry | null>(null);
  const [tasks, setTasks] = useState<WikiDedupTask[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState('');
  const [queueError, setQueueError] = useState('');
  const observing = useRef<AbortController | null>(null);
  const detection = useRef<{ taskId: string; controller: AbortController } | null>(null);
  const submitting = useRef(new Set<string>());
  const queueRead = useRef(0);
  const queueSnapshot = useRef<WikiDedupTask[]>([]);
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);

  const refreshQueue = useCallback(async (signal: AbortSignal, notify = true) => {
    const request = ++queueRead.current;
    const state = await hostWikiDedupState({ projectId });
    if (signal.aborted || request !== queueRead.current) return;
    if (state.projectId !== projectId) throw new Error(t('actions.resultUnconfirmed'));
    setTasks(state.tasks.filter((task) => task.status !== 'done'));
    setGroups((current) => current.map((entry) => state.tasks.some((task) => task.status === 'done' && groupKey(task.group.slugs) === groupKey(entry.group.slugs))
      ? { ...entry, outcome: 'merged' } : entry));
    setQueueError('');
    const settled = queueSnapshot.current.some((previous) => {
      if (previous.paused || (previous.status !== 'pending' && previous.status !== 'processing')) return false;
      const next = state.tasks.find((task) => task.id === previous.id);
      return !next || next.status === 'failed' || next.status === 'done' || next.paused;
    });
    queueSnapshot.current = state.tasks;
    if (settled && notify) await changed.current();
  }, [projectId, t]);

  useEffect(() => {
    const controller = new AbortController();
    observing.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        await refreshQueue(controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted) setQueueError(cause instanceof Error ? cause.message : t('dedup.queueFailed'));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 1000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      const scan = detection.current;
      if (scan) {
        scan.controller.abort();
        void hostWikiCancelDedup({ projectId, taskId: scan.taskId }).catch(() => toast.error(t('dedup.cancelFailed')));
      }
    };
  }, [projectId, refreshQueue, t]);

  async function scan(): Promise<void> {
    const signal = observing.current?.signal;
    if (!signal || signal.aborted || detection.current || busy !== null || !modelRef.trim() || modelRef === 'auto') return;
    const scanTask = { taskId: crypto.randomUUID(), controller: new AbortController() };
    detection.current = scanTask;
    setScanning(true);
    setScanned(false);
    setGroups([]);
    setError('');
    let terminal = false;
    try {
      const receipt = await hostWikiDetectDuplicates({ projectId, taskId: scanTask.taskId, modelRef });
      if (scanTask.controller.signal.aborted || signal.aborted) {
        await hostWikiCancelDedup({ projectId, taskId: scanTask.taskId }).catch(() => toast.error(t('dedup.cancelFailed')));
        return;
      }
      const call = await waitForCall(receipt, 'wiki', { signal: scanTask.controller.signal });
      if (scanTask.controller.signal.aborted || signal.aborted) return;
      if (call.callId !== receipt.callId || call.command !== 'dedup.detect' || call.detail.operation !== 'dedup.detect' || call.status === 'unknown') throw new Error(t('actions.resultUnconfirmed'));
      terminal = true;
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') throw new Error(t('dedup.scanFailed'));
      const result = await hostWikiCallResult({ callId: receipt.callId });
      if (scanTask.controller.signal.aborted || signal.aborted) return;
      if (result.callId !== receipt.callId || result.operation !== 'dedup.detect' || result.result.projectId !== projectId) throw new Error(t('actions.resultUnconfirmed'));
      setGroups(result.result.groups.map((group) => ({ group, canonicalSlug: group.slugs[0], outcome: 'candidate' })));
      setScanned(true);
    } catch (cause) {
      if (!terminal && !scanTask.controller.signal.aborted && !signal.aborted) {
        await hostWikiCancelDedup({ projectId, taskId: scanTask.taskId }).catch(() => toast.error(t('dedup.cancelFailed')));
      }
      if (!scanTask.controller.signal.aborted && !signal.aborted) setError(cause instanceof Error ? cause.message : t('dedup.scanFailed'));
    } finally {
      if (detection.current === scanTask) detection.current = null;
      if (!signal.aborted) setScanning(false);
    }
  }

  async function cancelScan(): Promise<void> {
    const scanTask = detection.current;
    if (!scanTask) return;
    try {
      await hostWikiCancelDedup({ projectId, taskId: scanTask.taskId });
      scanTask.controller.abort();
      if (detection.current === scanTask && !observing.current?.signal.aborted) { setScanning(false); setError(''); }
    } catch {
      if (detection.current === scanTask && !observing.current?.signal.aborted) setError(t('dedup.cancelFailed'));
    }
  }

  async function runMerge(operation: DedupAction, entry?: GroupEntry, task?: WikiDedupTask): Promise<void> {
    const signal = observing.current?.signal;
    const key = groupKey(entry?.group.slugs ?? task!.group.slugs);
    if (!signal || signal.aborted || busy !== null || submitting.current.has(key)) return;
    submitting.current.add(key);
    setPendingKeys(new Set(submitting.current));
    setError('');
    try {
      setConfirmation(null);
      const receipt = operation === 'dedup.merge'
        ? await hostWikiMergeDuplicates({ projectId, group: entry!.group, canonicalSlug: entry!.canonicalSlug })
        : operation === 'dedup.retry'
          ? await hostWikiRetryDedup({ projectId, taskId: task!.id })
          : await hostWikiResumeDedup({ projectId, taskId: task!.id });
      if (signal.aborted) return;
      await refreshQueue(signal).catch(() => { if (!signal.aborted) setQueueError(t('dedup.queueFailed')); });
      const call = await waitForCall(receipt, 'wiki', { signal });
      if (signal.aborted) return;
      if (call.callId !== receipt.callId || call.command !== operation || call.detail.operation !== operation || call.status === 'unknown') throw new Error(t('actions.resultUnconfirmed'));
      const completed = call.status === 'succeeded' && call.detail.outcome === 'completed';
      if (completed) setGroups((current) => current.map((item) => groupKey(item.group.slugs) === key ? { ...item, outcome: 'merged' } : item));
      await refreshQueue(signal, false).catch(() => { if (!signal.aborted) setQueueError(t('dedup.queueFailed')); });
      await changed.current().catch(() => { if (!signal.aborted) setError(t('maintenance.refreshFailed')); });
      if (!signal.aborted && !completed) throw new Error(t('dedup.mergeFailed'));
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : t('dedup.mergeFailed'));
    } finally {
      submitting.current.delete(key);
      if (!signal.aborted) setPendingKeys(new Set(submitting.current));
    }
  }

  async function cancelTask(task: WikiDedupTask): Promise<void> {
    const signal = observing.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const state = await hostWikiCancelDedup({ projectId, taskId: task.id });
      if (signal.aborted) return;
      if (state.projectId !== projectId) throw new Error(t('actions.resultUnconfirmed'));
      queueRead.current++;
      setTasks(state.tasks.filter((item) => item.status !== 'done'));
      await changed.current();
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : t('dedup.cancelFailed'));
    }
  }

  async function exclude(entry: GroupEntry): Promise<void> {
    const signal = observing.current?.signal;
    const key = groupKey(entry.group.slugs);
    if (!signal || signal.aborted || submitting.current.has(key)) return;
    submitting.current.add(key);
    setPendingKeys(new Set(submitting.current));
    try {
      const state = await hostWikiExcludeDuplicates({ projectId, slugs: entry.group.slugs });
      if (signal.aborted) return;
      if (state.projectId !== projectId) throw new Error(t('actions.resultUnconfirmed'));
      queueRead.current++;
      setTasks(state.tasks.filter((item) => item.status !== 'done'));
      setGroups((current) => current.map((item) => groupKey(item.group.slugs) === key ? { ...item, outcome: 'excluded' } : item));
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : t('dedup.excludeFailed'));
    } finally {
      submitting.current.delete(key);
      if (!signal.aborted) setPendingKeys(new Set(submitting.current));
    }
  }

  function taskControls(task: WikiDedupTask) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t(`dedup.status.${task.paused ? 'paused' : task.status}`, { count: task.retryCount })}</span>
        {task.paused ? <Button type="button" size="sm" variant="outline" disabled={busy !== null || pendingKeys.has(groupKey(task.group.slugs))} onClick={() => { void runMerge('dedup.resume', undefined, task); }}><RotateCcw className="h-3.5 w-3.5" />{t('dedup.resume')}</Button> : null}
        {task.status === 'failed' && !task.paused ? <Button type="button" size="sm" variant="outline" disabled={busy !== null || pendingKeys.has(groupKey(task.group.slugs))} onClick={() => { void runMerge('dedup.retry', undefined, task); }}>{t('dedup.retry')}</Button> : null}
        <Button type="button" size="sm" variant="ghost" onClick={() => { void cancelTask(task); }}>{t(task.status === 'failed' ? 'common.delete' : 'common.cancel')}</Button>
        {task.error ? <p className="basis-full text-xs text-destructive">{task.error}</p> : null}
      </div>
    );
  }

  return (
    <WikiSurface className="space-y-4 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Copy className="h-4 w-4" />{t('dedup.title')}</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('dedup.description')}</p>
      {!modelRef.trim() || modelRef === 'auto' ? <p className="text-xs text-muted-foreground">{t('dedup.modelRequired')}</p> : <p className="text-xs text-muted-foreground">{t('dedup.model', { modelRef })}</p>}
      <div className="flex flex-wrap gap-2">
        <WikiPrimaryButton disabled={busy !== null || scanning || !modelRef.trim() || modelRef === 'auto'} onClick={() => { void scan(); }}>{scanning ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{t(scanning ? 'dedup.scanning' : 'dedup.scan')}</WikiPrimaryButton>
        {scanning ? <Button type="button" size="sm" variant="ghost" onClick={() => { void cancelScan(); }}>{t('common.cancel')}</Button> : null}
        <Button type="button" size="sm" variant="outline" onClick={() => { const signal = observing.current?.signal; if (signal) void refreshQueue(signal).catch((cause) => { if (!signal.aborted) setQueueError(cause instanceof Error ? cause.message : t('dedup.queueFailed')); }); }}>{t('dedup.refreshQueue')}</Button>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {queueError ? <p role="alert" className="text-xs text-destructive">{queueError}</p> : null}
      {scanned && groups.length === 0 ? <p role="status" className="text-sm text-muted-foreground">{t('dedup.none')}</p> : null}
      {tasks.length > 0 ? (
        <section className="space-y-3" aria-label={t('dedup.queue')}>
          <h4 className="text-sm font-medium">{t('dedup.queue')} · {tasks.length}</h4>
          {tasks.some((task) => task.paused) ? <p className="text-xs text-muted-foreground">{t('dedup.pausedHint')}</p> : null}
          {tasks.map((task) => <div key={task.id} className="space-y-2 rounded-xl border border-border p-3"><p className="break-words text-xs"><code>{task.group.slugs.join(' + ')}</code> → <code>{task.canonicalSlug}</code></p>{taskControls(task)}</div>)}
        </section>
      ) : null}
      {groups.map((entry) => {
        const key = groupKey(entry.group.slugs);
        const task = tasks.find((item) => groupKey(item.group.slugs) === key);
        const locked = busy !== null || pendingKeys.has(key) || !!task || entry.outcome !== 'candidate';
        return (
          <section key={key} className="space-y-3 rounded-xl border border-border p-3">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground"><span>{entry.group.confidence}</span><span>{t('dedup.candidates', { count: entry.group.slugs.length })}</span>{entry.outcome !== 'candidate' ? <span role="status">{t(`dedup.${entry.outcome}`)}</span> : null}</div>
            <p className="text-xs text-muted-foreground">{entry.group.reason}</p>
            <fieldset disabled={locked} className="space-y-1"><legend className="mb-2 text-xs font-medium">{t('dedup.canonical')}</legend>{entry.group.slugs.map((slug) => <label key={slug} className="flex items-center gap-2 rounded px-1 py-1 text-xs"><input type="radio" name={`canonical-${key}`} checked={entry.canonicalSlug === slug} onChange={() => setGroups((current) => current.map((item) => item === entry ? { ...item, canonicalSlug: slug } : item))} /><code className="break-all">{slug}</code></label>)}</fieldset>
            {!task && entry.outcome === 'candidate' ? <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={locked} onClick={() => setConfirmation(entry)}>{pendingKeys.has(key) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}{t('dedup.merge', { slug: entry.canonicalSlug })}</Button><Button type="button" size="sm" variant="ghost" disabled={locked} onClick={() => { void exclude(entry); }}>{t('dedup.exclude')}</Button></div> : null}
            {task ? taskControls(task) : null}
          </section>
        );
      })}
      <ConfirmDialog
        open={confirmation !== null}
        title={t('dedup.title')}
        message={`${t('dedup.confirmMerge', { slug: confirmation?.canonicalSlug })}\n\n${t('dedup.confirmDetail', { slugs: confirmation?.group.slugs.join(' + ') })}`}
        confirmLabel={t('dedup.confirm')}
        cancelLabel={t('common.cancel')}
        variant="destructive"
        onConfirm={() => confirmation ? runMerge('dedup.merge', confirmation) : undefined}
        onCancel={() => setConfirmation(null)}
      />
    </WikiSurface>
  );
}
