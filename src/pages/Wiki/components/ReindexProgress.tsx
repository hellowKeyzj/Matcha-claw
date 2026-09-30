import { useEffect, useRef, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Database, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { invokeIpc } from '@/lib/api-client';
import { waitForCall } from '@/lib/call-log-await';
import { hostWikiReindexState, hostWikiStartReindex } from '@/lib/host-api';
import type { CallReceipt } from '@/types/call-log';
import type { WikiReindexState } from '@/types/wiki-capabilities';
import { WikiSurface } from './WikiChrome';

export type ReindexProgressProps = Readonly<{
  projectId: string;
  busy: string | null;
}>;

export function ReindexProgress(props: ReindexProgressProps): JSX.Element {
  return <ReindexBody key={props.projectId} {...props} />;
}

function ReindexBody({ projectId, busy }: ReindexProgressProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const [state, setState] = useState<WikiReindexState | null>(null);
  const [receipt, setReceipt] = useState<CallReceipt | null>(null);
  const [confirmedCallId, setConfirmedCallId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [pollVersion, setPollVersion] = useState(0);
  const observing = useRef<AbortController | null>(null);
  const inflight = useRef<Promise<WikiReindexState> | null>(null);
  const locked = useRef(false);
  const text = (key: string, defaultValue: string) => t(`reindex.${key}`, { defaultValue });
  const awaitingResult = receipt !== null && confirmedCallId !== receipt.callId;
  const disabled = busy !== null || submitting || state === null || state.status === 'running' || awaitingResult;

  useEffect(() => {
    const controller = new AbortController();
    observing.current = controller;
    return () => { controller.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let failures = 0;
    const unconfirmed = () => new Error(t('reindex.unconfirmed', { defaultValue: '无法确认本次重建结果，请刷新查看；不要重复提交。' }));
    async function poll(): Promise<void> {
      let shouldContinue: boolean;
      try {
        const reading = inflight.current ?? hostWikiReindexState({ projectId });
        inflight.current = reading;
        let next: WikiReindexState;
        try {
          next = await reading;
        } finally {
          if (inflight.current === reading) inflight.current = null;
        }
        if (controller.signal.aborted) return;
        if (next.projectId !== projectId) throw unconfirmed();
        setState(next);
        setError('');
        failures = 0;
        shouldContinue = next.status === 'running';
        if (receipt) {
          if (next.taskId !== receipt.callId) {
            shouldContinue = true;
          } else if (next.status === 'done' || next.status === 'error') {
            const call = await waitForCall(receipt, 'wiki', { signal: controller.signal });
            if (controller.signal.aborted) return;
            if (call.command !== 'embedding.reindex' || call.detail.operation !== 'embedding.reindex' || call.status === 'unknown') throw unconfirmed();
            if (next.status === 'done' && (call.status !== 'succeeded' || call.detail.outcome !== 'completed')) throw unconfirmed();
            setConfirmedCallId(receipt.callId);
            shouldContinue = false;
          } else {
            shouldContinue = true;
          }
        }
      } catch {
        if (controller.signal.aborted) return;
        failures++;
        shouldContinue = true;
      }
      if (controller.signal.aborted) return;
      if (shouldContinue && ++attempts < 300 && failures < 3) {
        timer = setTimeout(() => { void poll(); }, 2000);
      } else if (shouldContinue) {
        setError(t('reindex.progressPaused', { defaultValue: '自动进度刷新已暂停；重建仍可能在后台执行，请点击刷新继续查看。' }));
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, receipt, pollVersion, t]);

  async function start(): Promise<void> {
    const signal = observing.current?.signal;
    if (disabled || locked.current || !signal || signal.aborted) return;
    locked.current = true;
    setSubmitting(true);
    setError('');
    try {
      const confirmation = await invokeIpc<{ response: number }>('dialog:message', {
        type: 'warning',
        title: text('title', '全库向量重建'),
        message: text('confirm', '使用已保存的向量配置重建全库索引，可能产生模型调用费用。成功后更新索引；失败页面的旧索引会保留。'),
        buttons: [text('cancel', '取消'), text('start', '重建全库向量')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (signal.aborted || confirmation.response !== 1) return;
      const accepted = await hostWikiStartReindex({ projectId });
      if (signal.aborted) return;
      setConfirmedCallId(null);
      setReceipt(accepted);
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : text('startFailed', '重建请求失败，请检查已保存的向量配置。'));
    } finally {
      if (!signal.aborted) {
        locked.current = false;
        setSubmitting(false);
      }
    }
  }

  const matchesReceipt = receipt === null || state?.taskId === receipt.callId;
  const isDone = state?.status === 'done' && matchesReceipt && !awaitingResult && !submitting;
  return (
    <WikiSurface className="space-y-3 p-4">
      <div className="flex items-center gap-2"><Database className="h-4 w-4" /><h3 className="flex-1 text-sm font-semibold">{text('title', '全库向量重建')}</h3><Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => setPollVersion((version) => version + 1)}><RefreshCw className="h-4 w-4" />{text('refresh', '刷新进度')}</Button></div>
      <p className="text-xs text-muted-foreground">{text('hint', '保存向量配置不会自动重建。重建使用已保存配置；失败页面保留旧索引。')}</p>
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => { void start(); }}>{text('start', '重建全库向量')}</Button>
      <div role="status" className="space-y-1 text-xs text-muted-foreground">
        {submitting || awaitingResult || state?.status === 'running' ? <p className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />{state?.status === 'running' && matchesReceipt ? state.phase === 'preparing' ? text('preparing', '正在准备向量…') : state.phase === 'writing' ? text('writing', '正在更新索引…') : text('waiting', '正在等待本次重建结果…') : text('waiting', '正在等待本次重建结果…')}</p> : null}
        {state && matchesReceipt && state.status !== 'idle' ? <p>{t('reindex.progress', { defaultValue: '已尝试准备 {{done}} / {{total}} 页；已成功写入 {{count}} 页索引。', done: state.done, total: state.total, count: state.count })}</p> : null}
        {isDone ? <p>{text('done', '全库向量重建已完成。')}</p> : null}
        {!state ? <p>{text('loading', '正在读取向量重建状态…')}</p> : null}
      </div>
      {state?.status === 'error' && matchesReceipt ? <p role="alert" className="text-xs text-destructive">{state.message || text('failed', '重建未完成；失败页面的旧索引已保留。')}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </WikiSurface>
  );
}
