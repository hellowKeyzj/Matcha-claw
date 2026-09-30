import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock3, RefreshCw, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { waitForCall } from '@/lib/call-log-await';
import { hostWikiHistoryList, hostWikiHistoryRestore } from '@/lib/host-api';
import type { WikiHistoryEntry } from '@/types/wiki-capabilities';
import { formatDateTime } from '../wiki-model';
import { WikiEmpty, WikiIconButton, WikiPanel, WikiPanelHeader } from './WikiChrome';

export type FileHistoryPanelProps = Readonly<{
  projectId: string;
  path: string;
  currentContent: string;
  busy: string | null;
  onRestored(projectId: string, path: string): Promise<void>;
  onClose?(): void;
}>;

export function FileHistoryPanel(props: FileHistoryPanelProps): JSX.Element {
  return <FileHistoryView key={JSON.stringify([props.projectId, props.path])} {...props} />;
}

function FileHistoryView({ projectId, path, currentContent, busy, onRestored, onClose }: FileHistoryPanelProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const [entries, setEntries] = useState<readonly WikiHistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  const selected = entries.find((entry) => entry.id === selectedId);
  const disabled = busy !== null || loading || restoring;

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setSelectedId(null);
    setError('');
    try {
      const result = await hostWikiHistoryList({ projectId, path });
      if (signal.aborted) return;
      if (result.projectId !== projectId || result.path !== path) throw new Error(t('history.loadFailed', { defaultValue: '文件历史读取失败，请刷新重试。' }));
      setEntries(result.entries);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : t('history.loadFailed', { defaultValue: '文件历史读取失败，请刷新重试。' }));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [projectId, path, t]);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function restore(): Promise<void> {
    const signal = controllerRef.current?.signal;
    if (!selected || disabled || !signal || signal.aborted) return;
    setRestoring(true);
    setError('');
    setNotice('');
    try {
      const receipt = await hostWikiHistoryRestore({ projectId, path, versionId: selected.id });
      if (signal.aborted) return;
      const call = await waitForCall(receipt, 'wiki', { signal });
      if (signal.aborted) return;
      if (call.command !== 'history.restore' || call.detail.operation !== 'history.restore' || call.status !== 'succeeded' || call.detail.outcome !== 'completed') {
        throw new Error(t('history.restoreFailed', { defaultValue: '版本恢复未完成，请刷新文件后确认结果。' }));
      }
      await onRestored(projectId, path);
      if (signal.aborted) return;
      setConfirmRestore(false);
      setNotice(t('history.restored', { defaultValue: '版本已恢复，文件已重新读取。' }));
      if (onClose) onClose();
      else await load(signal);
    } catch (cause) {
      if (!signal.aborted) {
        setConfirmRestore(false);
        setError(cause instanceof Error ? cause.message : t('history.restoreFailed', { defaultValue: '版本恢复未完成，请刷新文件后确认结果。' }));
      }
    } finally {
      if (!signal.aborted) setRestoring(false);
    }
  }

  return (
    <WikiPanel>
      <WikiPanelHeader
        title={t('history.title', { defaultValue: '文件历史' })}
        subtitle={path}
        icon={Clock3}
        actions={(
          <>
            <WikiIconButton disabled={disabled} title={t('common.refresh')} aria-label={t('common.refresh')} onClick={() => { const signal = controllerRef.current?.signal; if (signal && !signal.aborted) void load(signal); }}><RefreshCw className="h-4 w-4" /></WikiIconButton>
            {onClose ? <WikiIconButton disabled={restoring} title={t('history.close', { defaultValue: '关闭文件历史' })} aria-label={t('history.close', { defaultValue: '关闭文件历史' })} onClick={onClose}><X className="h-4 w-4" /></WikiIconButton> : null}
          </>
        )}
      />
      {error ? <p role="alert" className="border-b px-5 py-3 text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="px-5 py-3 text-sm text-muted-foreground">{notice}</p> : null}
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-1">
        <aside className="max-h-48 overflow-auto border-b p-3 md:max-h-none md:border-b-0 md:border-r" aria-label={t('history.title', { defaultValue: '文件历史' })}>
          {loading ? <p role="status" className="p-2 text-sm text-muted-foreground">{t('history.loading', { defaultValue: '正在读取文件历史…' })}</p> : entries.length === 0 && !error ? <WikiEmpty title={t('history.empty', { defaultValue: '此文件暂无历史版本' })} icon={Clock3} /> : null}
          <div className="space-y-1">
            {entries.map((entry) => (
              <Button key={entry.id} type="button" variant={selectedId === entry.id ? 'secondary' : 'ghost'} disabled={disabled} aria-pressed={selectedId === entry.id} className="h-auto w-full justify-start rounded-xl px-3 py-2 text-left" onClick={() => { setSelectedId(entry.id); setNotice(''); }}>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{entry.author} · {entry.tool}</span>
                  <time className="mt-1 block text-xs font-normal text-muted-foreground" dateTime={new Date(entry.timestamp).toISOString()}>{formatDateTime(entry.timestamp)}</time>
                  <span className="mt-1 block truncate font-mono text-[10px] font-normal text-muted-foreground" title={entry.id}>{entry.id}</span>
                </span>
              </Button>
            ))}
          </div>
        </aside>
        <main className="min-h-0 min-w-0 overflow-auto p-4">
          {selected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{formatDateTime(selected.timestamp)}</span>
                <Button type="button" size="sm" variant="outline" className="rounded-full" disabled={disabled} onClick={() => setConfirmRestore(true)}><RotateCcw className="h-4 w-4" />{restoring ? t('history.restoring', { defaultValue: '恢复中…' }) : t('history.restore', { defaultValue: '恢复此版本' })}</Button>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="min-w-0 space-y-2">
                  <h3 className="text-sm font-medium">{t('history.versionContent', { defaultValue: '历史版本正文' })}</h3>
                  <pre className="whitespace-pre-wrap break-words rounded-xl bg-[hsl(var(--shell-surface-muted))] p-4 font-mono text-xs leading-6">{selected.content}</pre>
                </section>
                <section className="min-w-0 space-y-2">
                  <h3 className="text-sm font-medium">{t('history.currentContent', { defaultValue: '当前正文（含未保存编辑）' })}</h3>
                  <pre className="whitespace-pre-wrap break-words rounded-xl bg-[hsl(var(--shell-surface-muted))] p-4 font-mono text-xs leading-6">{currentContent}</pre>
                </section>
              </div>
            </div>
          ) : <WikiEmpty title={t('history.selectVersion', { defaultValue: '选择一个版本查看正文' })} icon={Clock3} />}
        </main>
      </div>
      <ConfirmDialog
        open={confirmRestore && !!selected}
        title={t('history.restoreConfirmTitle', { defaultValue: '恢复历史版本？' })}
        message={t('history.restoreConfirm', { defaultValue: '将用版本 {{versionId}} 覆盖 {{path}} 的当前正文，包括未保存的编辑。确认恢复？', versionId: selected?.id, path })}
        confirmLabel={t('history.restore', { defaultValue: '恢复此版本' })}
        cancelLabel={t('history.cancel', { defaultValue: '取消' })}
        variant="destructive"
        onConfirm={restore}
        onCancel={() => setConfirmRestore(false)}
      />
    </WikiPanel>
  );
}
