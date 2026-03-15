import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useGatewayStore } from '@/stores/gateway';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { cn } from '@/lib/utils';
import { Cron } from '@/pages/Cron';
import type { Task } from '@/services/openclaw/task-manager-client';
import { buildStepDetailRows, countProgress, parseChecklist, type ChecklistItem, type ProgressCounter } from './checklist-parser';

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'success' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'destructive';
  if (status === 'running') return 'default';
  return 'secondary';
}

type TaskCenterTab = 'long' | 'scheduled';
type TaskStatsWindow = 'all' | '7d' | '30d';
type TaskStatusFilter = 'all' | 'running' | 'waiting' | 'completed' | 'incomplete';

function resolveTaskCenterTab(value: string | null): TaskCenterTab {
  if (value === 'scheduled') {
    return 'scheduled';
  }
  return 'long';
}

function normalizeTaskTimestampMs(raw: number | undefined): number | null {
  if (!Number.isFinite(raw) || Number(raw) <= 0) {
    return null;
  }
  const value = Number(raw);
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function resolveTaskTimestampMs(task: Task): number | null {
  return normalizeTaskTimestampMs(task.updated_at) ?? normalizeTaskTimestampMs(task.created_at);
}

function resolveDateRangeMs(dateFrom: string, dateTo: string): { startMs: number | null; endMs: number | null } {
  const startMs = dateFrom ? Date.parse(`${dateFrom}T00:00:00`) : NaN;
  const endMs = dateTo ? Date.parse(`${dateTo}T23:59:59.999`) : NaN;
  const safeStartMs = Number.isFinite(startMs) ? startMs : null;
  const safeEndMs = Number.isFinite(endMs) ? endMs : null;
  if (safeStartMs != null && safeEndMs != null && safeStartMs > safeEndMs) {
    return {
      startMs: safeEndMs,
      endMs: safeStartMs,
    };
  }
  return {
    startMs: safeStartMs,
    endMs: safeEndMs,
  };
}

function isIncompleteTask(task: Task): boolean {
  return task.status !== 'completed';
}

function matchesStatusFilter(task: Task, filter: TaskStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'running') return task.status === 'running';
  if (filter === 'waiting') return task.status === 'waiting_for_input' || task.status === 'waiting_approval';
  if (filter === 'completed') return task.status === 'completed';
  return isIncompleteTask(task);
}

function StepSection({
  step,
  defaultOpen,
  doneLabel,
  pendingLabel,
}: {
  step: ChecklistItem;
  defaultOpen: boolean;
  doneLabel: string;
  pendingLabel: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const progress = useMemo(() => countProgress(step), [step]);
  const rows = useMemo(() => buildStepDetailRows(step), [step]);
  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="rounded-lg border bg-background/70">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 px-3 py-3 text-left hover:bg-accent/30"
        onClick={() => setOpen((prev) => !prev)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            <p className="truncate text-sm font-semibold">{step.text}</p>
          </div>
          <p className="mt-1 pl-5 text-xs text-muted-foreground">
            {progress.done}/{progress.total}
          </p>
        </div>
        <div className="w-48 max-w-[45%] pt-0.5">
          <Progress
            value={percent}
            className={cn(
              'h-1.5 bg-muted/70',
              percent === 100 ? '[&>div]:bg-emerald-500' : '[&>div]:bg-slate-500/80',
            )}
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">{percent}%</p>
        </div>
      </button>

      {open ? (
        <div className="space-y-2 border-t px-3 pb-3 pt-2">
          {rows.map((row) => {
            if (row.type === 'item') {
              return (
                <div key={row.id} className="rounded-md border bg-background/80 p-2" style={{ marginLeft: `${row.depth * 16}px` }}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="line-clamp-1 text-xs font-medium">{row.text}</p>
                    <Badge variant={row.percent === 100 ? 'success' : 'secondary'}>{row.percent === 100 ? doneLabel : pendingLabel}</Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {row.done}/{row.total}
                  </p>
                </div>
              );
            }

            if (row.type === 'completion') {
              return (
                <div
                  key={row.id}
                  className="rounded-md border border-green-200 bg-green-50/70 p-2 text-xs text-green-800 dark:border-green-900 dark:bg-green-950/20 dark:text-green-300"
                  style={{ marginLeft: `${row.depth * 16}px` }}
                >
                  {row.text ? `完成情况：${row.text}` : '完成情况：'}
                  {row.details.length > 0 ? (
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {row.details.map((detail, detailIndex) => (
                        <li key={`${row.id}-detail-${detailIndex}`}>{detail}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              );
            }

            if (row.type === 'evidence') {
              return (
                <div
                  key={row.id}
                  className="rounded-md border border-blue-200 bg-blue-50/70 p-2 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-300"
                  style={{ marginLeft: `${row.depth * 16}px` }}
                >
                  证据：
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {row.details.map((detail, detailIndex) => (
                      <li key={`${row.id}-detail-${detailIndex}`}>{detail}</li>
                    ))}
                  </ul>
                </div>
              );
            }

            return (
              <div key={row.id} className="rounded-md border bg-background/80 p-2" style={{ marginLeft: `${row.depth * 16}px` }}>
                <div className="flex items-center justify-between gap-2">
                  <p className="line-clamp-1 text-xs">{row.text}</p>
                  <Badge variant={row.checked ? 'success' : 'secondary'}>{row.checked ? doneLabel : pendingLabel}</Badge>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function TasksPage() {
  const { t } = useTranslation('tasks');
  const [searchParams, setSearchParams] = useSearchParams();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const {
    tasks,
    loading,
    initialized,
    error,
    pluginInstalled,
    pluginEnabled,
    blockedQueue,
    init,
    refreshTasks,
    installPlugin,
    resumeBlockedTask,
    closeBlockedDialog,
  } = useTaskCenterStore();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [inputDraftByConfirmId, setInputDraftByConfirmId] = useState<Record<string, string>>({});
  const [statsWindow, setStatsWindow] = useState<TaskStatsWindow>('all');
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const activeTab = resolveTaskCenterTab(searchParams.get('tab'));

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    if (!pluginInstalled || !pluginEnabled || gatewayStatus.state !== 'running') {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshTasks();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pluginEnabled, pluginInstalled, gatewayStatus.state, refreshTasks]);

  const dateRange = useMemo(() => resolveDateRangeMs(dateFrom, dateTo), [dateFrom, dateTo]);
  const longTasks = useMemo(() => {
    return tasks.filter((task) => {
      if (dateRange.startMs == null && dateRange.endMs == null) {
        return true;
      }
      const taskTime = resolveTaskTimestampMs(task);
      if (taskTime == null) {
        return false;
      }
      if (dateRange.startMs != null && taskTime < dateRange.startMs) {
        return false;
      }
      if (dateRange.endMs != null && taskTime > dateRange.endMs) {
        return false;
      }
      return true;
    });
  }, [dateRange.endMs, dateRange.startMs, tasks]);
  const statsTasks = useMemo(() => {
    if (statsWindow === 'all') {
      return longTasks;
    }
    const now = Date.now();
    const days = statsWindow === '7d' ? 7 : 30;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    return longTasks.filter((task) => {
      const taskTime = resolveTaskTimestampMs(task);
      return taskTime != null && taskTime >= cutoff;
    });
  }, [longTasks, statsWindow]);
  const filteredTasks = useMemo(
    () => statsTasks.filter((task) => matchesStatusFilter(task, statusFilter)),
    [statsTasks, statusFilter],
  );

  const effectiveSelectedTaskId = useMemo(() => {
    if (filteredTasks.length === 0) {
      return null;
    }
    if (selectedTaskId && filteredTasks.some((task) => task.id === selectedTaskId)) {
      return selectedTaskId;
    }
    return filteredTasks[0].id;
  }, [filteredTasks, selectedTaskId]);

  const selectedTask = useMemo(
    () => filteredTasks.find((task) => task.id === effectiveSelectedTaskId) ?? null,
    [effectiveSelectedTaskId, filteredTasks],
  );
  const selectedTaskChecklist = useMemo(() => {
    if (!selectedTask?.plan_markdown) {
      return [];
    }
    return parseChecklist(selectedTask.plan_markdown);
  }, [selectedTask]);
  const checklistSummary = useMemo(
    () =>
      selectedTaskChecklist.reduce<ProgressCounter>(
        (acc, step) => {
          const current = countProgress(step);
          return {
            done: acc.done + current.done,
            total: acc.total + current.total,
          };
        },
        { done: 0, total: 0 },
      ),
    [selectedTaskChecklist],
  );

  const runningCount = statsTasks.filter((task) => task.status === 'running').length;
  const waitingCount = statsTasks.filter((task) => task.status === 'waiting_for_input' || task.status === 'waiting_approval').length;
  const completedCount = statsTasks.filter((task) => task.status === 'completed').length;
  const incompleteCount = statsTasks.filter((task) => isIncompleteTask(task)).length;

  const handleInstall = async () => {
    await installPlugin();
    const next = useTaskCenterStore.getState();
    if (next.error) {
      toast.error(next.error);
      return;
    }
    toast.success(t('toast.pluginInstalled'));
  };

  const handleResumeConfirm = async (payload: { taskId: string; confirmId: string; decision?: 'approve' | 'reject'; userInput?: string }) => {
    await resumeBlockedTask(payload);
    const next = useTaskCenterStore.getState();
    if (next.error) {
      toast.error(next.error);
      return;
    }
    setInputDraftByConfirmId((prev) => {
      const cloned = { ...prev };
      delete cloned[payload.confirmId];
      return cloned;
    });
    toast.success(t('toast.resumed'));
  };

  const handleTabChange = (nextValue: string) => {
    const nextTab = resolveTaskCenterTab(nextValue);
    const nextParams = new URLSearchParams(searchParams);
    if (nextTab === 'scheduled') {
      nextParams.set('tab', 'scheduled');
    } else {
      nextParams.delete('tab');
    }
    setSearchParams(nextParams, { replace: true });
  };

  const clearFilters = () => {
    setStatsWindow('all');
    setStatusFilter('all');
    setDateFrom('');
    setDateTo('');
  };

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
      </header>
      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
        <TabsList className="grid w-full max-w-sm grid-cols-2">
          <TabsTrigger value="long">{t('tabs.long')}</TabsTrigger>
          <TabsTrigger value="scheduled">{t('tabs.scheduled')}</TabsTrigger>
        </TabsList>

        <TabsContent value="long" className="mt-0 space-y-6">
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 p-3">
            <div className="flex rounded-md border bg-background p-1">
              <Button
                type="button"
                size="sm"
                variant={statsWindow === 'all' ? 'secondary' : 'ghost'}
                onClick={() => {
                  setStatsWindow('all');
                  setStatusFilter('all');
                }}
              >
                {t('timeWindow.all')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={statsWindow === '7d' ? 'secondary' : 'ghost'}
                onClick={() => {
                  setStatsWindow('7d');
                  setStatusFilter('all');
                }}
              >
                {t('timeWindow.last7Days')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={statsWindow === '30d' ? 'secondary' : 'ghost'}
                onClick={() => {
                  setStatsWindow('30d');
                  setStatusFilter('all');
                }}
              >
                {t('timeWindow.last30Days')}
              </Button>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {!pluginInstalled || !pluginEnabled ? (
                <Button type="button" size="sm" onClick={handleInstall} disabled={loading}>
                  <Wrench className="mr-2 h-4 w-4" />
                  {t('installPlugin')}
                </Button>
              ) : null}
              <input
                id="tasks-date-from"
                aria-label={t('filters.from')}
                type="date"
                value={dateFrom}
                onChange={(event) => setDateFrom(event.target.value)}
                className="h-9 w-40 rounded-md border bg-background px-3 text-sm"
              />
              <input
                id="tasks-date-to"
                aria-label={t('filters.to')}
                type="date"
                value={dateTo}
                onChange={(event) => setDateTo(event.target.value)}
                className="h-9 w-40 rounded-md border bg-background px-3 text-sm"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={clearFilters}
                disabled={!dateFrom && !dateTo && statsWindow === 'all' && statusFilter === 'all'}
              >
                {t('filters.clear')}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-9 w-9"
                aria-label={t('refresh')}
                title={t('refresh')}
                onClick={() => void refreshTasks()}
                disabled={loading || !pluginInstalled || !pluginEnabled}
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </Button>
            </div>
          </div>

          {gatewayStatus.state !== 'running' && (
            <Card className="border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10">
              <CardContent className="flex items-center gap-3 py-4 text-yellow-700 dark:text-yellow-300">
                <AlertCircle className="h-5 w-5" />
                {t('gatewayNotRunning')}
              </CardContent>
            </Card>
          )}

          {(!pluginInstalled || !pluginEnabled) && (
            <Card className="border-blue-500 bg-blue-50 dark:bg-blue-900/10">
              <CardHeader>
                <CardTitle className="text-lg">{t('plugin.title')}</CardTitle>
                <CardDescription>{t('plugin.description')}</CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={handleInstall} disabled={loading}>
                  <Wrench className="mr-2 h-4 w-4" />
                  {t('installPlugin')}
                </Button>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <button
              type="button"
              aria-label={t('stats.running')}
              aria-pressed={statusFilter === 'running'}
              onClick={() => setStatusFilter((prev) => (prev === 'running' ? 'all' : 'running'))}
              className="text-left"
            >
              <Card className={cn('transition-colors', statusFilter === 'running' && 'border-primary bg-primary/5')}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <PlayCircle className="h-5 w-5 text-primary" />
                    <div>
                      <p className="text-2xl font-bold">{runningCount}</p>
                      <p className="text-xs text-muted-foreground">{t('stats.running')}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </button>
            <button
              type="button"
              aria-label={t('stats.waiting')}
              aria-pressed={statusFilter === 'waiting'}
              onClick={() => setStatusFilter((prev) => (prev === 'waiting' ? 'all' : 'waiting'))}
              className="text-left"
            >
              <Card className={cn('transition-colors', statusFilter === 'waiting' && 'border-primary bg-primary/5')}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <PauseCircle className="h-5 w-5 text-yellow-500" />
                    <div>
                      <p className="text-2xl font-bold">{waitingCount}</p>
                      <p className="text-xs text-muted-foreground">{t('stats.waiting')}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </button>
            <button
              type="button"
              aria-label={t('stats.completed')}
              aria-pressed={statusFilter === 'completed'}
              onClick={() => setStatusFilter((prev) => (prev === 'completed' ? 'all' : 'completed'))}
              className="text-left"
            >
              <Card className={cn('transition-colors', statusFilter === 'completed' && 'border-primary bg-primary/5')}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                    <div>
                      <p className="text-2xl font-bold">{completedCount}</p>
                      <p className="text-xs text-muted-foreground">{t('stats.completed')}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </button>
            <button
              type="button"
              aria-label={t('stats.incomplete')}
              aria-pressed={statusFilter === 'incomplete'}
              onClick={() => setStatusFilter((prev) => (prev === 'incomplete' ? 'all' : 'incomplete'))}
              className="text-left"
            >
              <Card className={cn('transition-colors', statusFilter === 'incomplete' && 'border-primary bg-primary/5')}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <AlertCircle className="h-5 w-5 text-orange-500" />
                    <div>
                      <p className="text-2xl font-bold">{incompleteCount}</p>
                      <p className="text-xs text-muted-foreground">{t('stats.incomplete')}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </button>
          </div>

          {error && (
            <Card className="border-destructive">
              <CardContent className="py-4 text-destructive">{error}</CardContent>
            </Card>
          )}

          {!initialized ? null : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
              <Card className="flex h-[70vh] flex-col overflow-hidden">
                <CardHeader className="shrink-0">
                  <CardTitle>{t('listTitle')}</CardTitle>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-6">
                  {filteredTasks.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('empty')}</p>
                  ) : (
                    filteredTasks.map((task) => (
                      <button
                        key={task.id}
                        type="button"
                        className={cn(
                          'w-full rounded-lg border p-3 text-left transition-colors',
                          effectiveSelectedTaskId === task.id ? 'border-primary bg-primary/5' : 'hover:bg-accent/40',
                        )}
                        onClick={() => setSelectedTaskId(task.id)}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="line-clamp-2 text-sm font-medium">{task.goal}</p>
                          <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
                        </div>
                        <div className="mt-3 space-y-1">
                          <Progress
                            value={Math.round(task.progress * 100)}
                            className={cn(
                              'h-1.5 bg-muted/70',
                              task.status === 'completed' ? '[&>div]:bg-emerald-500' : '[&>div]:bg-slate-500/80',
                            )}
                          />
                          <p className="text-xs text-muted-foreground">{Math.round(task.progress * 100)}%</p>
                        </div>
                      </button>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card className="flex h-[70vh] flex-col overflow-hidden">
                <CardHeader className="shrink-0">
                  <CardTitle>{selectedTask ? selectedTask.goal : t('detailTitle')}</CardTitle>
                  <CardDescription>{selectedTask?.id || '-'}</CardDescription>
                </CardHeader>
                <CardContent className="min-h-0 flex-1 overflow-y-auto">
                  {!selectedTask ? (
                    <p className="text-sm text-muted-foreground">{t('selectTask')}</p>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center gap-2">
                        <Badge variant={statusVariant(selectedTask.status)}>{selectedTask.status}</Badge>
                        <span className="text-sm text-muted-foreground">{Math.round(selectedTask.progress * 100)}%</span>
                      </div>
                      {selectedTask.blocked_info?.question ? (
                        <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300">
                          {selectedTask.blocked_info.question}
                        </div>
                      ) : null}
                      {selectedTask.blocked_info?.description ? (
                        <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300">
                          {selectedTask.blocked_info.description}
                        </div>
                      ) : null}
                      <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
                        <p className="text-sm font-medium text-muted-foreground">{t('detailTitle')}</p>

                        {selectedTaskChecklist.length === 0 ? (
                          <p className="text-sm text-muted-foreground">{t('noMarkdown')}</p>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between rounded-md border bg-background/70 px-3 py-2 text-xs text-muted-foreground">
                              <span>{t('stepsOverview')}</span>
                              <span>
                                {checklistSummary.done}/{checklistSummary.total} {t('completedTag')}
                              </span>
                            </div>

                            {selectedTaskChecklist.map((step, index) => (
                              <StepSection
                                key={`${selectedTask.id}-${step.id}`}
                                step={step}
                                defaultOpen={index === 0}
                                doneLabel={t('completedTag')}
                                pendingLabel={t('pendingTag')}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        <TabsContent value="scheduled" className="mt-0">
          <Cron embedded />
        </TabsContent>
      </Tabs>

      {blockedQueue.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-2xl">
            <CardHeader>
              <CardTitle>{t('blocked.title')}</CardTitle>
              <CardDescription>{t('blocked.pendingCount', { count: blockedQueue.length })}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
                {blockedQueue.map((blocked) => (
                  <div key={`${blocked.taskId}-${blocked.confirmId}`} className="space-y-3 rounded-md border bg-background p-3">
                    <div>
                      <p className="text-xs text-muted-foreground">{blocked.taskId}</p>
                      <p className="mt-1 text-sm font-medium">{blocked.prompt}</p>
                    </div>
                    {blocked.inputMode === 'free_text' && blocked.type === 'waiting_for_input' ? (
                      <div className="space-y-2">
                        <textarea
                          value={inputDraftByConfirmId[blocked.confirmId] ?? ''}
                          onChange={(event) => {
                            const nextValue = event.target.value;
                            setInputDraftByConfirmId((prev) => ({
                              ...prev,
                              [blocked.confirmId]: nextValue,
                            }));
                          }}
                          placeholder={t('blocked.inputPlaceholder')}
                          className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm"
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="outline"
                            onClick={() => closeBlockedDialog({ taskId: blocked.taskId, confirmId: blocked.confirmId })}
                          >
                            {t('blocked.close')}
                          </Button>
                          <Button
                            disabled={!((inputDraftByConfirmId[blocked.confirmId] ?? '').trim())}
                            onClick={() =>
                              void handleResumeConfirm({
                                taskId: blocked.taskId,
                                confirmId: blocked.confirmId,
                                userInput: (inputDraftByConfirmId[blocked.confirmId] ?? '').trim(),
                              })
                            }
                          >
                            {t('blocked.submitInput')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          onClick={() => closeBlockedDialog({ taskId: blocked.taskId, confirmId: blocked.confirmId })}
                        >
                          {t('blocked.close')}
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() =>
                            void handleResumeConfirm({
                              taskId: blocked.taskId,
                              confirmId: blocked.confirmId,
                              decision: 'reject',
                            })
                          }
                        >
                          {t('blocked.reject')}
                        </Button>
                        <Button
                          onClick={() =>
                            void handleResumeConfirm({
                              taskId: blocked.taskId,
                              confirmId: blocked.confirmId,
                              decision: 'approve',
                            })
                          }
                        >
                          {t('blocked.confirm')}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}

export default TasksPage;
