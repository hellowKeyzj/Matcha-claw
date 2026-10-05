import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerUpLeft, FileQuestion, Link2, Loader2, Plus, Sparkles, Square, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { waitForCall } from '@/lib/call-log-await';
import { hostWikiCallResult, hostWikiCancelMissingPage, hostWikiCreateMissingPage, hostWikiPageLinks } from '@/lib/host-api';
import { useWikiProjectsStore } from '@/stores/wiki-projects';
import type { WikiPageLink, WikiPageLinks } from '@/types/wiki-capabilities';
import { WikiIconButton, WikiPanel, WikiPanelHeader, WikiPrimaryButton } from './WikiChrome';

export type PageLinksPanelProps = Readonly<{
  projectId: string;
  relativePath: string;
  busy: string | null;
  unsaved: boolean;
  onOpenFile(path: string): Promise<void>;
  onCreated(projectId: string, path: string): Promise<void>;
  onClose(): void;
}>;

type Scope = { projectId: string; controller: AbortController };
type Creation = {
  scope: Scope;
  taskId: string;
  title: string;
  draft: boolean;
  controller: AbortController;
  admission: 'pending' | 'settled';
  phase: 'creating' | 'unconfirmed' | 'refreshing' | 'cancelling' | 'cancel-failed';
  cancellation?: Promise<void>;
};

export function PageLinksPanel({ projectId, relativePath, busy, unsaved, onOpenFile, onCreated, onClose }: PageLinksPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const [links, setLinks] = useState<WikiPageLinks | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creation, setCreation] = useState<Creation | null>(null);
  const [readVersion, setReadVersion] = useState(0);
  const scopeRef = useRef<Scope | null>(null);
  const creationRef = useRef<Creation | null>(null);
  const callbacksRef = useRef({ onOpenFile, onCreated, t });
  callbacksRef.current = { onOpenFile, onCreated, t };

  const isCurrent = useCallback((scope: Scope): boolean => {
    const projects = useWikiProjectsStore.getState();
    return scopeRef.current === scope && !scope.controller.signal.aborted
      && (!projects.ready || projects.currentProject?.projectId === scope.projectId);
  }, []);

  const cancelCreation = useCallback((task: Creation): Promise<void> => {
    task.controller.abort();
    if (task.cancellation) return task.cancellation;
    const admission = task.admission;
    task.phase = 'cancelling';
    if (creationRef.current === task && isCurrent(task.scope)) {
      setCreation({ ...task });
      setError('');
    }
    const cancellation = (async () => {
      try {
        const receipt = await hostWikiCancelMissingPage({ projectId: task.scope.projectId, taskId: task.taskId });
        // Before admission, the owner may not have registered this task yet.
        if (admission === 'pending') return;
        if (receipt.cancelled !== true) throw new Error('Cancellation was not confirmed');
        if (creationRef.current === task) creationRef.current = null;
        if (isCurrent(task.scope)) { setCreation(null); setError(''); }
      } catch {
        task.phase = 'cancel-failed';
        const message = callbacksRef.current.t('pageLinks.cancelFailed', { defaultValue: '未能确认取消，后台任务可能仍在运行，请重试取消。' });
        if (isCurrent(task.scope)) { setCreation({ ...task }); setError(message); }
        else toast.error(message, { action: {
          label: callbacksRef.current.t('pageLinks.retryCancel', { defaultValue: '重试取消' }),
          onClick: () => { void cancelCreation(task); },
        } });
      } finally {
        task.cancellation = undefined;
      }
    })();
    task.cancellation = cancellation;
    return cancellation;
  }, [isCurrent]);

  useEffect(() => {
    const scope: Scope = { projectId, controller: new AbortController() };
    scopeRef.current = scope;
    creationRef.current = null;
    setCreation(null);
    setError('');
    const unsubscribe = useWikiProjectsStore.subscribe((projects) => {
      if (!projects.ready || projects.currentProject?.projectId === projectId) return;
      scope.controller.abort();
      const task = creationRef.current;
      if (task?.scope === scope && task.phase !== 'refreshing') void cancelCreation(task);
    });
    return () => {
      scope.controller.abort();
      unsubscribe();
      const task = creationRef.current;
      if (task?.scope === scope) {
        task.controller.abort();
        if (task.phase !== 'refreshing') void cancelCreation(task);
        creationRef.current = null;
      }
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [projectId, relativePath, cancelCreation]);

  useEffect(() => {
    const scope = scopeRef.current;
    let cancelled = false;
    setLinks(null);
    setLoading(true);
    const timer = window.setTimeout(() => {
      void hostWikiPageLinks({ projectId, relativePath }).then((result) => {
        if (cancelled || !scope || !isCurrent(scope)) return;
        if (result.projectId !== projectId) throw new Error('Wiki project identity mismatch');
        setLinks(result);
      }).catch(() => {
        if (!cancelled && scope && isCurrent(scope)) setError(t('pageLinks.loadFailed', { defaultValue: '无法读取页面链接，请关闭面板后重新打开。' }));
      }).finally(() => {
        if (!cancelled && scope && isCurrent(scope)) setLoading(false);
      });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [projectId, relativePath, unsaved, readVersion, isCurrent, t]);

  async function createMissing(entry: WikiPageLink, draft: boolean): Promise<void> {
    const scope = scopeRef.current;
    if (!scope || !isCurrent(scope) || useWikiProjectsStore.getState().switching || busy !== null || creationRef.current) return;
    const task: Creation = { scope, taskId: crypto.randomUUID(), title: entry.title, draft, controller: new AbortController(), admission: 'pending', phase: 'creating' };
    creationRef.current = task;
    setCreation(task);
    setError('');
    try {
      // Do not abort admission: a late receipt must trigger another owner cancellation.
      const receipt = await hostWikiCreateMissingPage({ projectId, taskId: task.taskId, title: entry.title, linkingPath: relativePath, draft });
      task.admission = 'settled';
      if (task.controller.signal.aborted || !isCurrent(scope)) {
        await task.cancellation;
        await cancelCreation(task);
        return;
      }
      const call = await waitForCall(receipt, 'wiki', { signal: task.controller.signal });
      if (task.controller.signal.aborted || !isCurrent(scope)) return;
      if (call.callId !== receipt.callId || call.command !== 'missing-page.create' || call.detail.operation !== 'missing-page.create') {
        throw new Error('Wiki call identity mismatch');
      }
      if (call.status === 'unknown') throw new Error('Wiki creation outcome is unconfirmed');
      if (call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        creationRef.current = null;
        setCreation(null);
        setError(t('pageLinks.createFailed', { defaultValue: '页面未创建成功，请检查调用记录后重试。' }));
        return;
      }
      const result = await hostWikiCallResult({ callId: receipt.callId });
      if (task.controller.signal.aborted || !isCurrent(scope)) return;
      if (result.callId !== receipt.callId || result.operation !== 'missing-page.create' || result.result.projectId !== projectId) {
        throw new Error('Wiki result identity mismatch');
      }
      task.phase = 'refreshing';
      setCreation({ ...task });
      try {
        if (useWikiProjectsStore.getState().switching) return;
        await callbacksRef.current.onCreated(projectId, result.result.path);
      } catch {
        if (isCurrent(scope)) setError(t('pageLinks.refreshFailed', { defaultValue: '页面已创建，但刷新或打开失败，请刷新文件树后打开。' }));
      } finally {
        if (creationRef.current === task) creationRef.current = null;
        if (isCurrent(scope)) { setCreation(null); setReadVersion((version) => version + 1); }
      }
    } catch {
      const admissionPending = task.admission === 'pending';
      task.admission = 'settled';
      if (task.controller.signal.aborted) {
        if (admissionPending) {
          await task.cancellation;
          await cancelCreation(task);
        }
        return;
      }
      if (!isCurrent(scope)) { void cancelCreation(task); return; }
      task.phase = 'unconfirmed';
      setCreation({ ...task });
      setError(t('pageLinks.createUnconfirmed', { defaultValue: '创建结果尚未确认，请检查调用记录；也可取消本次任务，不要重复创建。' }));
    }
  }

  async function openFile(path: string): Promise<void> {
    const scope = scopeRef.current;
    if (!scope || !isCurrent(scope) || useWikiProjectsStore.getState().switching) return;
    try { await callbacksRef.current.onOpenFile(path); }
    catch { if (isCurrent(scope)) setError(t('pageLinks.openFailed', { defaultValue: '无法打开链接页面，请刷新文件树后重试。' })); }
  }

  const disabled = busy !== null || creation !== null;
  const sections = [
    { key: 'outgoing', title: t('pageLinks.outgoing', { defaultValue: '出站链接' }), empty: t('pageLinks.noOutgoing', { defaultValue: '此页面没有出站链接。' }), icon: Link2 },
    { key: 'backlinks', title: t('pageLinks.backlinks', { defaultValue: '反向链接' }), empty: t('pageLinks.noBacklinks', { defaultValue: '暂无页面引用此页面。' }), icon: CornerUpLeft },
    { key: 'missing', title: t('pageLinks.missing', { defaultValue: '缺失页面' }), empty: t('pageLinks.noMissing', { defaultValue: '所有链接页面均已存在。' }), icon: FileQuestion },
  ] as const;
  const total = links ? links.outgoing.length + links.backlinks.length + links.missing.length : 0;

  return (
    <aside className="absolute inset-y-0 right-0 z-20 w-[min(22rem,90%)] border-l border-border shadow-xl" aria-label={t('pageLinks.title', { defaultValue: '页面链接' })}>
      <WikiPanel>
        <WikiPanelHeader title={t('pageLinks.title', { defaultValue: '页面链接' })} icon={Link2} meta={!loading ? <span className="text-xs text-muted-foreground">{total}</span> : undefined} actions={(
          <WikiIconButton type="button" onClick={onClose} aria-label={t('pageLinks.close', { defaultValue: '关闭链接面板' })}><X className="h-4 w-4" aria-hidden="true" /></WikiIconButton>
        )} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {unsaved ? <p className="border-b border-border px-3 py-3 text-xs text-muted-foreground">{t('pageLinks.savedOnly', { defaultValue: '后台读取已保存的页面；当前未保存的修改不会参与链接分析或 AI 起草，也不会自动保存。' })}</p> : null}
          {error ? <p role="alert" className="m-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{error}</p> : null}
          {creation ? (
            <div className="flex items-center gap-2 border-b border-border px-3 py-3">
              <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">
                {creation.phase === 'cancelling' ? t('pageLinks.cancelling', { defaultValue: '正在取消…' })
                  : creation.phase === 'refreshing' ? t('pageLinks.refreshing', { defaultValue: '页面已创建，正在刷新并打开…' })
                    : creation.phase === 'cancel-failed' ? t('pageLinks.cancelUnconfirmed', { defaultValue: '取消尚未确认' })
                      : creation.phase === 'unconfirmed' ? t('pageLinks.resultUnconfirmed', { defaultValue: '创建结果尚未确认' })
                        : t(creation.draft ? 'pageLinks.drafting' : 'pageLinks.creating', { title: creation.title, defaultValue: creation.draft ? '正在起草「{{title}}」…' : '正在创建「{{title}}」…' })}
              </p>
              {creation.phase !== 'refreshing' ? <Button type="button" size="sm" variant="outline" className="h-7 px-2" disabled={creation.phase === 'cancelling'} onClick={() => { const task = creationRef.current; if (task) void cancelCreation(task); }}><Square className="h-3 w-3" aria-hidden="true" />{t(creation.phase === 'cancel-failed' ? 'pageLinks.retryCancel' : 'pageLinks.cancel', { defaultValue: creation.phase === 'cancel-failed' ? '重试取消' : '取消' })}</Button> : null}
            </div>
          ) : null}
          {loading ? <div role="status" className="flex h-24 items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t('pageLinks.loading', { defaultValue: '正在读取链接…' })}</div> : sections.map(({ key, title, empty, icon: Icon }) => {
            const entries = links?.[key] ?? [];
            return (
              <section key={key} className="border-b border-border" aria-label={title}>
                <div className="flex items-center gap-2 bg-secondary/30 px-3 py-2"><Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /><h3 className="flex-1 text-xs font-medium">{title}</h3><span className="text-xs text-muted-foreground">{entries.length}</span></div>
                {entries.length === 0 ? <p className="px-3 py-3 text-xs text-muted-foreground">{empty}</p> : entries.map((entry, index) => (
                  <div key={`${entry.path ?? entry.title}:${index}`} className="border-t border-border/50 px-3 py-2 first:border-t-0">
                    {entry.path ? <Button type="button" variant="link" className="h-auto w-full justify-start whitespace-normal text-left text-xs" disabled={disabled} onClick={() => { void openFile(entry.path!); }}>{entry.title}</Button> : <span className="block truncate text-xs font-medium" title={entry.title}>{entry.title}</span>}
                    {entry.snippet ? <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{entry.snippet}</p> : null}
                    {key === 'missing' && !entry.path ? (
                      <div className="mt-2 flex gap-1.5">
                        <Button type="button" size="sm" variant="outline" className="h-7 px-2" disabled={disabled} onClick={() => { void createMissing(entry, false); }}><Plus className="h-3 w-3" aria-hidden="true" />{t('pageLinks.create', { defaultValue: '创建页面' })}</Button>
                        <WikiPrimaryButton type="button" size="sm" className="h-7 px-2" disabled={disabled} onClick={() => { void createMissing(entry, true); }}><Sparkles className="h-3 w-3" aria-hidden="true" />{t('pageLinks.draft', { defaultValue: 'AI 起草' })}</WikiPrimaryButton>
                      </div>
                    ) : null}
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      </WikiPanel>
    </aside>
  );
}
