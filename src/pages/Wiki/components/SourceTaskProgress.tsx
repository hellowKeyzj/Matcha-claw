import { useEffect, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { isActiveSourceTask, type WikiSourceTask } from '../wiki-model';

export function SourceTaskProgress({ task }: Readonly<{ task: WikiSourceTask }>): JSX.Element {
  const { t } = useTranslation('wiki');
  const active = isActiveSourceTask(task);
  const started = task.stageStartedAtMs;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || started === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, started]);
  const seconds = started === null ? null : Math.max(0, Math.floor(((active ? Math.max(now, task.updatedAtMs) : task.updatedAtMs) - started) / 1000));
  const hasCounts = task.stage !== 'parse' && task.completed !== null && task.total !== null;
  const percentage = active && hasCounts && task.total !== null && task.total > 0 ? task.progress : null;
  const countKey = task.stage === 'analyze' ? 'analyzed' : task.stage === 'write' ? 'pages' : 'processed';
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {active ? <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
      <span>{!active && task.stage !== 'paused' ? t(`sourceProgress.status.${task.status}`, { defaultValue: task.status }) : task.stage ? t(`sourceProgress.stages.${task.stage}`, { defaultValue: t('sourceProgress.processing') }) : t(`sourceProgress.status.${task.status}`, { defaultValue: task.status })}</span>
      {hasCounts ? <span className="tabular-nums">{t(`sourceProgress.${countKey}`, { completed: task.completed, total: task.total })}</span> : null}
      {percentage !== null ? <span className="tabular-nums">{t('sourceProgress.stagePercent', { percent: percentage })}</span> : null}
      {seconds !== null ? <span className="tabular-nums">{t('sourceProgress.elapsed', { seconds })}</span> : null}
      {active && task.cancelRequestedAtMs !== null ? <span>{t('sourceProgress.cancelRequested')}</span> : null}
    </span>
  );
}
