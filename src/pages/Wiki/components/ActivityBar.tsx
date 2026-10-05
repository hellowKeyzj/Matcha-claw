import { useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ChevronUp, Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WikiSourceTask, WikiStatus } from '../wiki-model';
import { formatDateTime, isActiveSourceTask } from '../wiki-model';
import { SourceTaskProgress } from './SourceTaskProgress';

export type ActivityBarProps = Readonly<{
  status: WikiStatus;
  sourceTasks: readonly WikiSourceTask[];
  busy: string | null;
  sourceTasksError: string | null;
  cancellingSourcePaths: ReadonlySet<string>;
  onLoadSourceTasks(): void;
  onCancelSourceTask(sourcePath: string): void;
}>;

const RECENT_TASK_LIMIT = 6;

function isFailedStatus(status: string): boolean {
  const normalizedStatus = status.toLowerCase();
  return normalizedStatus === 'failed' || normalizedStatus === 'error';
}

function isRunningStatus(status: string): boolean {
  const normalizedStatus = status.toLowerCase();
  return normalizedStatus === 'running' || normalizedStatus === 'processing';
}

function statusBadgeVariant(status: string) {
  const normalizedStatus = status.toLowerCase();
  if (normalizedStatus === 'done' || normalizedStatus === 'completed' || normalizedStatus === 'success') return 'success';
  if (isFailedStatus(normalizedStatus)) return 'destructive';
  if (normalizedStatus === 'pending' || isRunningStatus(normalizedStatus)) return 'warning';
  return 'secondary';
}

export function ActivityBar(props: ActivityBarProps): JSX.Element {
  const { t } = useTranslation('wiki');
  const { status, sourceTasks, busy, sourceTasksError, cancellingSourcePaths, onLoadSourceTasks, onCancelSourceTask } = props;
  const [expanded, setExpanded] = useState(false);
  const failedCount = sourceTasks.filter((task) => isFailedStatus(task.status)).length;
  const runningCount = sourceTasks.filter(isActiveSourceTask).length;
  const activeTask = sourceTasks.find((task) => task.status === 'running' && isActiveSourceTask(task)) ?? sourceTasks.find(isActiveSourceTask);
  const recentTasks = [...sourceTasks]
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, RECENT_TASK_LIMIT);
  const importing = busy === 'import-source' || busy === 'import-folder' || busy === 'refresh-sources';

  return (
    <section className="shrink-0 border-t border-border/70 bg-card/95 px-3 py-2">
      <div className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <ActivityMetric label={t('activity.pending')} value={status.pendingChangeCount} />
        <ActivityMetric label={t('activity.tasks')} value={sourceTasks.length} />
        <ActivityMetric label={t('activity.failed')} value={failedCount} tone={failedCount > 0 ? 'danger' : undefined} />
        <ActivityMetric label={t('activity.running')} value={runningCount} tone={runningCount > 0 ? 'active' : undefined} />
        {activeTask ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="max-w-40 truncate" title={activeTask.sourcePath}>{activeTask.sourcePath}</span>
            <SourceTaskProgress task={activeTask} />
            {activeTask.cancelRequestedAtMs === null ? <Button size="sm" variant="ghost" className="h-6 px-2" disabled={cancellingSourcePaths.has(activeTask.sourcePath)} onClick={() => onCancelSourceTask(activeTask.sourcePath)}>{t(cancellingSourcePaths.has(activeTask.sourcePath) ? 'sourceProgress.cancelling' : 'common.cancel')}</Button> : null}
          </div>
        ) : importing ? <span className="inline-flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />{t('sourceProgress.waiting')}</span> : null}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="icon" variant="ghost" className="h-7 w-7 rounded-full" onClick={onLoadSourceTasks} title={t('activity.refresh')}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="h-7 w-7 rounded-full" onClick={() => setExpanded((value) => !value)} title={t('activity.details')}>
            <ChevronUp className={cn('h-3.5 w-3.5 transition-transform', !expanded && 'rotate-180')} />
          </Button>
        </div>
      </div>

      {sourceTasksError ? <div role="status" className="mt-1 text-xs text-destructive">{sourceTasksError}</div> : null}
      {expanded ? (
        <div className="mt-2 border-t border-border/70 pt-2">
          {recentTasks.length > 0 ? (
            <div className="space-y-1">
              {recentTasks.map((task) => (
                <div key={task.id} className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-secondary/50">
                  <Badge variant={statusBadgeVariant(task.status)}>{t(`sourceProgress.status.${task.status}`, { defaultValue: task.status })}</Badge>
                  <Badge variant="outline">{t(`sourceProgress.kind.${task.kind}`, { defaultValue: task.kind })}</Badge>
                  <SourceTaskProgress task={task} />
                  <span className="min-w-0 flex-1 truncate text-foreground" title={task.sourcePath}>{task.sourcePath}</span>
                  <span className="shrink-0 text-muted-foreground">{formatDateTime(task.updatedAtMs, t('time.unrecorded'))}</span>
                  {isActiveSourceTask(task) && task.cancelRequestedAtMs === null ? <Button size="sm" variant="ghost" className="h-6 px-2" disabled={cancellingSourcePaths.has(task.sourcePath)} onClick={() => onCancelSourceTask(task.sourcePath)}>{t(cancellingSourcePaths.has(task.sourcePath) ? 'sourceProgress.cancelling' : 'common.cancel')}</Button> : null}
                  {task.error ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label={task.error} /> : null}
                </div>
              ))}
            </div>
          ) : (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">{t('activity.emptyTasks')}</div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function ActivityMetric(props: Readonly<{ label: string; value: number; tone?: 'active' | 'danger' }>): JSX.Element {
  const { label, value, tone } = props;
  return (
    <span className={cn('inline-flex items-center gap-1', tone === 'danger' && 'text-destructive', tone === 'active' && 'text-amber-700 dark:text-amber-200')}>
      {label}
      <strong className="font-semibold tabular-nums text-foreground">{value}</strong>
    </span>
  );
}
