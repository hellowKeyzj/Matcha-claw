import { useEffect, useState } from 'react';
import { Check, CircleAlert, Film, Image as ImageIcon, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { sessionMediaGenerationTask } from '@/types/session/render-item';
import type { SessionRenderToolCard } from '@/types/session/tool-card';
import { readBoundedString } from './tool-renderers/openclaw-details';

export function ToolMediaGenerationTask({ tool, onRefreshMediaTask }: {
  tool: SessionRenderToolCard;
  onRefreshMediaTask?: (taskId: string) => Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const task = sessionMediaGenerationTask(tool);
  const title = t(tool.name === 'image_generate' ? 'mediaTask.imageTitle' : 'mediaTask.videoTitle');
  const MediaIcon = tool.name === 'image_generate' ? ImageIcon : Film;
  const refreshVideoTask = tool.name === 'video_generate' ? onRefreshMediaTask : undefined;
  const details = tool.details && typeof tool.details === 'object' && !Array.isArray(tool.details)
    ? tool.details as Record<string, unknown> : undefined;
  const submitted = details?.async === true && details.status === 'started'
    && typeof details.taskId === 'string' && !!details.taskId.trim();
  const taskId = task?.taskId;
  const status = task?.status ?? (tool.status === 'error' ? 'failed' : tool.status === 'cancelled' ? 'cancelled'
    : submitted ? 'submitted' : tool.status === 'running' ? 'submitting' : 'unconfirmed');
  const error = readBoundedString(task?.error, 2000) ?? (tool.status === 'error'
    ? readBoundedString(tool.summary, 2000) ?? readBoundedString(tool.result.kind === 'text' || tool.result.kind === 'json' ? tool.result.bodyText : undefined, 2000)
    : undefined);
  const delivering = task?.deliveryStatus === 'pending' && (status === 'failed' || status === 'timed_out');
  const timedOut = !delivering && (status === 'timed_out' || status === 'failed' && /timed out|timeout/i.test(error ?? ''));
  const deliveryBlocked = status === 'completed' && task?.terminalOutcome === 'blocked';
  const active = status === 'queued' || status === 'running';
  const waitingSince = task?.createdAt ?? task?.startedAt;
  const [now, setNow] = useState(Date.now);
  const [query, setQuery] = useState<{ pending: boolean; error?: string }>({ pending: false });
  useEffect(() => {
    if (!active || waitingSince === undefined) return;
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [active, waitingSince]);
  const seconds = waitingSince === undefined ? 0 : Math.max(0, Math.floor((now - waitingSince) / 1000));
  const duration = seconds < 60 ? t('replyTiming.seconds', { count: seconds })
    : t('replyTiming.minutesSeconds', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  const failed = !delivering && (status === 'failed' || timedOut);
  const Icon = active || delivering || status === 'submitting' ? Loader2 : failed || deliveryBlocked ? CircleAlert : status === 'completed' ? Check : MediaIcon;
  const canQuery = taskId && refreshVideoTask && failed;
  const refresh = async () => {
    if (!taskId || !refreshVideoTask || query.pending) return;
    setQuery({ pending: true });
    try {
      await refreshVideoTask(taskId);
      setQuery({ pending: false });
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : t('videoTask.queryUnavailable');
      setQuery({ pending: false, error: t('videoTask.queryFailed', { error: reason }) });
    }
  };

  return <section aria-label={title} className="w-full space-y-1.5 rounded-2xl border border-border/45 bg-muted/40 px-3 py-2.5 text-xs">
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <Icon aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${active || delivering || status === 'submitting' ? 'animate-spin motion-reduce:animate-none' : ''} ${failed ? 'text-foreground' : 'text-muted-foreground'}`} />
      <span className="font-medium">{title}</span>
      <span role="status" aria-atomic="true" className={failed ? 'font-medium text-foreground' : 'text-muted-foreground'}>{t(`mediaTask.${delivering ? 'delivering' : timedOut ? 'timed_out' : deliveryBlocked ? 'deliveryBlocked' : status}`)}</span>
      {active && waitingSince !== undefined ? <span role="timer" aria-live="off" className="tabular-nums text-muted-foreground">{t('mediaTask.waited', { duration })}</span> : null}
      {canQuery ? <Button type="button" variant="ghost" size="sm" disabled={query.pending} aria-busy={query.pending}
        className="h-auto min-h-7 max-w-full whitespace-normal px-2 py-1 text-xs" onClick={() => { void refresh(); }}>
        {query.pending ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : null}
        {t(query.pending ? 'videoTask.querying' : 'videoTask.query')}
      </Button> : null}
    </div>
    {timedOut ? <p className="leading-5 text-muted-foreground">{t(canQuery ? 'videoTask.timeoutHint' : 'mediaTask.timeoutHint')}</p> : null}
    {failed ? <p className="whitespace-pre-wrap break-words leading-5 text-foreground">{error || t('mediaTask.failureUnknown')}</p> : null}
    {canQuery && query.error ? <p role="alert" className="break-words leading-5 text-foreground">{query.error}</p> : null}
  </section>;
}
