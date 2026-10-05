import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Sparkles, Square, X } from 'lucide-react';
import { toast } from 'sonner';
import { MarkdownPreview } from '@/components/file-preview/MarkdownPreview';
import { Button } from '@/components/ui/button';
import { waitForCall } from '@/lib/call-log-await';
import { hostWikiApplySelection, hostWikiCallResult, hostWikiCancelSelection, hostWikiGenerateSelection, hostWikiReadFile, hostWikiSelectionTask } from '@/lib/host-api';
import { delay } from '@/lib/utils';
import { buildWordDiff, normalizeSelectionReplacement } from '@/lib/wiki-selection';
import { useWikiProjectsStore } from '@/stores/wiki-projects';
import type { WikiSelectionApplyReceipt, WikiSelectionIntent, WikiSelectionReference, WikiSelectionSnapshot, WikiSelectionTask, WikiSelectionTurn } from '@/types/wiki-selection';
import { resolveWikiMarkdownImage } from '../wiki-media';
import { WikiIconButton, WikiPanel, WikiPanelHeader, WikiPrimaryButton } from './WikiChrome';

export type SelectionAssistantPanelProps = Readonly<{
  projectId: string;
  relativePath: string;
  selection: WikiSelectionSnapshot;
  modelRef?: string;
  busy: string | null;
  onPrepare(snapshot: WikiSelectionSnapshot): Promise<void>;
  onApplied(receipt: WikiSelectionApplyReceipt): Promise<void>;
  onOpenFile(path: string): Promise<void>;
  onClose(): void;
}>;

type SelectionRun = {
  projectId: string;
  relativePath: string;
  taskId: string;
  intent: WikiSelectionIntent;
  controller: AbortController;
  admission: 'preparing' | 'pending' | 'settled';
  phase: 'running' | 'unconfirmed' | 'cancelling' | 'cancel-failed';
  cancellation?: Promise<void>;
};
type ConversationTurn = WikiSelectionTurn & { references: WikiSelectionReference[] };

function assertTaskIdentity(task: WikiSelectionTask, run: SelectionRun): void {
  if (task.projectId !== run.projectId || task.relativePath !== run.relativePath || task.taskId !== run.taskId || task.intent !== run.intent) {
    throw new Error('Wiki selection task identity mismatch');
  }
}

export function SelectionAssistantPanel({ projectId, relativePath, selection, modelRef, busy, onPrepare, onApplied, onOpenFile, onClose }: SelectionAssistantPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const [mode, setMode] = useState<WikiSelectionIntent | null>(null);
  const [instruction, setInstruction] = useState('');
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [result, setResult] = useState<{ intent: WikiSelectionIntent; content: string } | null>(null);
  const [run, setRun] = useState<SelectionRun | null>(null);
  const [error, setError] = useState('');
  const [applyState, setApplyState] = useState<'idle' | 'applying' | 'unconfirmed' | 'saved'>('idle');
  const [preview, setPreview] = useState<{ path: string; title: string; content: string } | null>(null);
  const [referenceLoading, setReferenceLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const mountedRef = useRef(false);
  const runRef = useRef<SelectionRun | null>(null);
  const applyingRef = useRef(false);
  const appliedRef = useRef<WikiSelectionApplyReceipt | null>(null);
  const referenceRequestRef = useRef(0);
  const callbacksRef = useRef({ onPrepare, onApplied, onOpenFile, onClose, t });
  callbacksRef.current = { onPrepare, onApplied, onOpenFile, onClose, t };

  const isCurrent = useCallback((): boolean => {
    const projects = useWikiProjectsStore.getState();
    return mountedRef.current && (!projects.ready || projects.currentProject?.projectId === projectId);
  }, [projectId]);

  const cancelRun = useCallback((task: SelectionRun | null): Promise<void> => {
    referenceRequestRef.current++;
    if (!task) return Promise.resolve();
    task.controller.abort();
    if (task.admission === 'preparing') {
      if (runRef.current === task) { runRef.current = null; if (isCurrent()) { setRun(null); setResult(null); } }
      return Promise.resolve();
    }
    if (task.cancellation) return task.cancellation;
    const admission = task.admission;
    task.phase = 'cancelling';
    if (isCurrent() && runRef.current === task) { setRun({ ...task }); setError(''); }
    const cancellation = (async () => {
      try {
        const cancelled = await hostWikiCancelSelection({ projectId: task.projectId, taskId: task.taskId });
        assertTaskIdentity(cancelled, task);
        // Admission may register the task after this request; cancel again when it settles.
        if (admission === 'pending') return;
        if (!['cancelled', 'done', 'failed'].includes(cancelled.status)) throw new Error('Wiki selection cancellation is unconfirmed');
        if (runRef.current === task) {
          runRef.current = null;
          if (isCurrent()) { setRun(null); setResult(null); }
        }
      } catch {
        task.phase = 'cancel-failed';
        const message = callbacksRef.current.t('selection.cancelFailed');
        if (isCurrent() && runRef.current === task) { setRun({ ...task }); setError(message); }
        else toast.error(message, { action: {
          label: callbacksRef.current.t('selection.retryCancel'),
          onClick: () => { void cancelRun(task); },
        } });
      } finally { task.cancellation = undefined; }
    })();
    task.cancellation = cancellation;
    return cancellation;
  }, [isCurrent]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = useWikiProjectsStore.subscribe((projects) => {
      if (!projects.switching && (!projects.ready || projects.currentProject?.projectId === projectId)) return;
      void cancelRun(runRef.current);
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      void cancelRun(runRef.current);
    };
  }, [projectId, relativePath, selection, cancelRun]);

  async function submit(intent: WikiSelectionIntent): Promise<void> {
    if (!isCurrent() || useWikiProjectsStore.getState().switching || busy !== null || runRef.current || applyingRef.current || applyState !== 'idle' || !instruction.trim()
      || (mode && mode !== intent) || (intent === 'edit' && !selection.sourceMapped)) return;
    const task: SelectionRun = { projectId, relativePath, taskId: crypto.randomUUID(), intent, controller: new AbortController(), admission: 'preparing', phase: 'running' };
    runRef.current = task;
    setRun(task);
    setMode(intent);
    setResult(null);
    setError('');
    const question = instruction.trim();
    try {
      if (selection.sourceMapped) await callbacksRef.current.onPrepare(selection);
    } catch (cause) {
      if (runRef.current === task) {
        runRef.current = null;
        if (isCurrent()) { setRun(null); setError(`${t('selection.prepareFailed')}${cause instanceof Error ? ` ${cause.message}` : ''}`); }
      }
      return;
    }
    if (task.controller.signal.aborted || !isCurrent() || useWikiProjectsStore.getState().switching) {
      if (runRef.current === task) { runRef.current = null; if (isCurrent()) setRun(null); }
      return;
    }
    task.admission = 'pending';
    setResult({ intent, content: '' });
    try {
      // Never abort admission: a late response still needs server-side cancellation.
      const receipt = await hostWikiGenerateSelection({ projectId, taskId: task.taskId, relativePath, intent, instruction: question, selection,
        history: turns.map(({ question: previousQuestion, answer }) => ({ question: previousQuestion, answer })), modelRef });
      task.admission = 'settled';
      if (task.controller.signal.aborted || !isCurrent()) {
        await task.cancellation;
        await cancelRun(task);
        return;
      }
      let callError: unknown;
      const completion = waitForCall(receipt, 'wiki', { signal: task.controller.signal }).catch((cause: unknown) => { callError = cause; return null; });
      let terminal: WikiSelectionTask;
      while (true) {
        if (callError) throw callError;
        const snapshot = await hostWikiSelectionTask({ projectId, taskId: task.taskId });
        if (task.controller.signal.aborted || !isCurrent()) return;
        assertTaskIdentity(snapshot, task);
        setResult({ intent, content: snapshot.content });
        if (['done', 'cancelled', 'failed'].includes(snapshot.status)) { terminal = snapshot; break; }
        await delay(200);
      }
      const call = await completion;
      if (task.controller.signal.aborted || !isCurrent()) return;
      if (!call) throw callError;
      if (call.callId !== receipt.callId || call.module !== 'wiki' || call.command !== 'selection.generate' || call.detail.operation !== 'selection.generate') {
        throw new Error('Wiki selection call identity mismatch');
      }
      if (call.status === 'unknown') throw new Error('Wiki selection outcome is unconfirmed');
      runRef.current = null;
      setRun(null);
      if (terminal.status === 'cancelled') { setResult(null); return; }
      if (terminal.status !== 'done' || call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        setError(terminal.error ? `${t('selection.requestFailed')} ${terminal.error}` : t('selection.requestFailed'));
        return;
      }
      if (intent === 'ask') {
        setResult(null);
        if (terminal.content.trim()) {
          setTurns((previous) => [...previous, { question, answer: terminal.content, references: terminal.references }]);
          setInstruction('');
        } else setError(t('selection.emptyResponse'));
      }
    } catch {
      const wasPending = task.admission === 'pending';
      task.admission = 'settled';
      if (task.controller.signal.aborted || !isCurrent()) {
        if (wasPending || !task.controller.signal.aborted) { await task.cancellation; await cancelRun(task); }
        return;
      }
      task.phase = 'unconfirmed';
      task.controller.abort();
      setRun({ ...task });
      setError(t('selection.requestUnconfirmed'));
    }
  }

  async function refreshApplied(receipt: WikiSelectionApplyReceipt): Promise<void> {
    setRefreshing(true);
    try {
      await callbacksRef.current.onApplied(receipt);
      if (isCurrent()) callbacksRef.current.onClose();
    } catch (cause) {
      const message = `${callbacksRef.current.t('selection.refreshFailed')}${cause instanceof Error ? ` ${cause.message}` : ''}`;
      if (isCurrent()) setError(message); else toast.error(message);
    } finally { if (isCurrent()) setRefreshing(false); }
  }

  async function accept(): Promise<void> {
    if (!isCurrent() || useWikiProjectsStore.getState().switching || busy !== null || runRef.current || applyingRef.current || applyState !== 'idle' || !selection.sourceMapped || result?.intent !== 'edit' || !result.content) return;
    applyingRef.current = true;
    setApplyState('applying');
    setError('');
    try {
      const receipt = await hostWikiApplySelection({ projectId, relativePath, selection, replacement: result.content });
      const call = await waitForCall(receipt, 'wiki');
      if (call.callId !== receipt.callId || call.module !== 'wiki' || call.command !== 'selection.apply' || call.detail.operation !== 'selection.apply') {
        throw new Error('Wiki selection apply identity mismatch');
      }
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        if (isCurrent()) {
          setApplyState(call.status === 'unknown' ? 'unconfirmed' : 'idle');
          setError(t(call.status === 'unknown' ? 'selection.applyUnconfirmed' : 'selection.applyFailed'));
        }
        return;
      }
      const applied = await hostWikiCallResult({ callId: receipt.callId });
      if (applied.callId !== receipt.callId || applied.operation !== 'selection.apply' || applied.result.projectId !== projectId || applied.result.relativePath !== relativePath) {
        throw new Error('Wiki selection apply result identity mismatch');
      }
      appliedRef.current = applied.result;
      if (!isCurrent()) return;
      setApplyState('saved');
      setResult(null);
      if (!useWikiProjectsStore.getState().switching) await refreshApplied(applied.result);
    } catch {
      const message = callbacksRef.current.t('selection.applyUnconfirmed');
      if (isCurrent()) { setApplyState('unconfirmed'); setError(message); }
      else toast.error(message);
    } finally { applyingRef.current = false; }
  }

  async function openReference(reference: WikiSelectionReference): Promise<void> {
    if (!isCurrent()) return;
    const request = ++referenceRequestRef.current;
    setReferenceLoading(true);
    setError('');
    try {
      const file = await hostWikiReadFile({ projectId, path: reference.path });
      if (!isCurrent() || request !== referenceRequestRef.current) return;
      if (!file || typeof file !== 'object' || !('content' in file) || typeof file.content !== 'string'
        || !('relativePath' in file) || file.relativePath !== reference.path) throw new Error('Wiki reference result is invalid');
      setPreview({ path: reference.path, title: reference.title, content: file.content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '') });
    } catch { if (isCurrent() && request === referenceRequestRef.current) setError(t('selection.referenceFailed')); }
    finally { if (isCurrent() && request === referenceRequestRef.current) setReferenceLoading(false); }
  }

  function references(entries: WikiSelectionReference[]): JSX.Element | null {
    return entries.length ? <div className="flex flex-wrap gap-1 pt-1">{entries.map((reference, index) => (
      <Button key={`${reference.path}:${index}`} type="button" variant="outline" size="sm" title={reference.path} className="h-auto max-w-full truncate px-2 py-1 text-[10px]" onClick={() => { void openReference(reference); }}>[{index + 1}] {reference.title}</Button>
    ))}</div> : null;
  }

  const diff = useMemo(() => !run && result?.intent === 'edit' ? buildWordDiff(selection.selectedText, normalizeSelectionReplacement(result.content)) : [], [run, result, selection.selectedText]);
  const disabled = busy !== null || run !== null || applyState !== 'idle';
  const textAreaClass = 'w-full resize-none rounded-xl border border-input bg-background p-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

  return (
    <aside className="flex h-full min-h-0 w-[360px] max-w-[45%] shrink-0 flex-col border-l border-border" aria-label={t('selection.title')}>
      <WikiPanel>
        <WikiPanelHeader title={t('selection.title')} icon={Sparkles} actions={(
          <WikiIconButton type="button" aria-label={t('selection.close')} onClick={() => { void cancelRun(runRef.current); callbacksRef.current.onClose(); }}><X className="h-4 w-4" aria-hidden="true" /></WikiIconButton>
        )} />
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="mb-3 whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">{selection.selectedText}</div>
          {!selection.sourceMapped ? <p className="mb-3 rounded-xl border border-border bg-muted/40 p-2 text-xs leading-5 text-muted-foreground">{t('selection.askOnlyHint')}</p> : null}
          {turns.map((turn, index) => <div key={index} className="mb-4 space-y-2 border-b border-border/60 pb-4">
            <div className="ml-6 whitespace-pre-wrap break-words rounded-xl bg-accent px-3 py-2 text-xs text-accent-foreground">{turn.question}</div>
            <MarkdownPreview filePath={relativePath} markdown={turn.answer} resolveImageSrc={resolveWikiMarkdownImage} />
            {references(turn.references)}
          </div>)}
          {referenceLoading ? <p role="status" className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t('selection.referenceLoading')}</p> : null}
          {preview ? <section className="mb-4 overflow-hidden rounded-xl border border-border bg-background" aria-label={preview.title}>
            <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-medium" title={preview.path}>{preview.title}</span>
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { void callbacksRef.current.onOpenFile(preview.path).catch(() => { if (isCurrent()) setError(t('selection.openFailed')); }); }}>{t('selection.openFile')}</Button>
              <WikiIconButton type="button" aria-label={t('selection.closeReference')} onClick={() => { referenceRequestRef.current++; setReferenceLoading(false); setPreview(null); }}><X className="h-3.5 w-3.5" aria-hidden="true" /></WikiIconButton>
            </div>
            <div className="max-h-72 overflow-auto"><MarkdownPreview filePath={preview.path} markdown={preview.content} resolveImageSrc={resolveWikiMarkdownImage} /></div>
          </section> : null}
          {result ? <div className="space-y-3">
            {result.intent === 'edit' ? <>
              {!run ? <div className="rounded-xl border border-border bg-muted/20 p-3">
                <h3 className="mb-1 text-[10px] font-semibold text-muted-foreground">{t('selection.wordDiff')}</h3>
                <div className="whitespace-pre-wrap break-words font-mono text-xs leading-5">{diff.map((part, index) => <span key={index} className={part.type === 'delete' ? 'bg-destructive/10 text-destructive line-through' : part.type === 'insert' ? 'bg-primary/10 text-primary' : 'text-foreground/80'}>{part.value}</span>)}</div>
              </div> : null}
              <div className="rounded-xl border border-border bg-muted/20 p-3">
                <h3 className="mb-1 text-[10px] font-semibold text-muted-foreground">+ {t('selection.replacement')}</h3>
                {run ? <div className="whitespace-pre-wrap break-words text-xs leading-5">{result.content || t('selection.generating')}</div>
                  : <textarea aria-label={t('selection.replacement')} value={result.content} disabled={applyState !== 'idle'} onChange={(event) => setResult({ intent: 'edit', content: event.target.value })} rows={8} className="w-full resize-y bg-transparent font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
              </div>
            </> : result.content ? <MarkdownPreview filePath={relativePath} markdown={result.content} resolveImageSrc={resolveWikiMarkdownImage} /> : <p className="text-xs text-muted-foreground">{t('selection.generating')}</p>}
          </div> : null}
          {error ? <p role="alert" className="mt-3 whitespace-pre-wrap rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{error}</p> : null}
        </div>
        <footer className="space-y-2 border-t border-border p-3">
          {result?.intent !== 'edit' && !run && applyState === 'idle' ? <textarea aria-label={t('selection.instruction')} value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(mode ?? 'ask'); }
          }} placeholder={t('selection.placeholder')} rows={3} className={textAreaClass} /> : null}
          <div className="flex min-h-7 flex-wrap items-center justify-end gap-1.5">
            {run ? <>
              <span role="status" className="mr-auto text-xs text-muted-foreground">{t(run.phase === 'cancelling' ? 'selection.cancelling' : run.phase === 'cancel-failed' ? 'selection.cancelUnconfirmed' : run.phase === 'unconfirmed' ? 'selection.resultUnconfirmed' : 'selection.generating')}</span>
              <Button type="button" size="sm" variant="outline" disabled={run.phase === 'cancelling'} onClick={() => { void cancelRun(runRef.current); }}><Square className="h-3 w-3" aria-hidden="true" />{t(run.phase === 'cancel-failed' ? 'selection.retryCancel' : 'selection.stop')}</Button>
            </> : applyState === 'saved' ? <Button type="button" size="sm" variant="outline" disabled={busy !== null || refreshing} onClick={() => {
              const receipt = appliedRef.current;
              if (!receipt || applyingRef.current || !isCurrent()) return;
              applyingRef.current = true;
              setError('');
              void refreshApplied(receipt).finally(() => { applyingRef.current = false; });
            }}>{t('selection.retryRefresh')}</Button> : applyState === 'applying' ? <span role="status" className="text-xs text-muted-foreground">{t('selection.applying')}</span> : result?.intent === 'edit' ? <>
              <Button type="button" size="sm" variant="ghost" disabled={applyState !== 'idle'} onClick={() => setResult(null)}>{t('selection.reject')}</Button>
              <Button type="button" size="sm" variant="outline" disabled={disabled || !instruction.trim()} onClick={() => { void submit('edit'); }}>{t('selection.regenerate')}</Button>
              <WikiPrimaryButton type="button" size="sm" disabled={disabled || !result.content} onClick={() => { void accept(); }}>{t('selection.accept')}</WikiPrimaryButton>
            </> : applyState === 'idle' ? <>
              {mode !== 'edit' ? <Button type="button" size="sm" variant="outline" disabled={disabled || !instruction.trim()} onClick={() => { void submit('ask'); }}>{t('selection.ask')}</Button> : null}
              {mode !== 'ask' ? <WikiPrimaryButton type="button" size="sm" disabled={disabled || !instruction.trim() || !selection.sourceMapped} title={!selection.sourceMapped ? t('selection.askOnlyHint') : undefined} onClick={() => { void submit('edit'); }}>{t('selection.edit')}</WikiPrimaryButton> : null}
            </> : null}
          </div>
        </footer>
      </WikiPanel>
    </aside>
  );
}
