import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, PauseCircle, PlayCircle, RefreshCw, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useGatewayStore } from '@/stores/gateway';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { cn } from '@/lib/utils';
import { buildStepDetailRows, countProgress, parseChecklist, type ChecklistItem, type ProgressCounter } from './checklist-parser';

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'success' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'destructive';
  if (status === 'running') return 'default';
  return 'secondary';
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
  const gatewayStatus = useGatewayStore((state) => state.status);
  const {
    tasks,
    loading,
    initialized,
    error,
    workspaceDir,
    pluginInstalled,
    pluginEnabled,
    blockedQueue,
    init,
    refreshTasks,
    installPlugin,
    resumeBlockedTask,
    closeBlockedDialog,
    handleGatewayNotification,
  } = useTaskCenterStore();

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [inputDraftByConfirmId, setInputDraftByConfirmId] = useState<Record<string, string>>({});

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('gateway:notification', (notification) => {
      handleGatewayNotification(notification);
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [handleGatewayNotification]);

  useEffect(() => {
    if (!pluginInstalled || !pluginEnabled || gatewayStatus.state !== 'running') {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshTasks();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [pluginEnabled, pluginInstalled, gatewayStatus.state, refreshTasks]);

  const effectiveSelectedTaskId = useMemo(() => {
    if (tasks.length === 0) {
      return null;
    }
    if (selectedTaskId && tasks.some((task) => task.id === selectedTaskId)) {
      return selectedTaskId;
    }
    return tasks[0].id;
  }, [tasks, selectedTaskId]);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === effectiveSelectedTaskId) ?? null,
    [effectiveSelectedTaskId, tasks],
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

  const runningCount = tasks.filter((task) => task.status === 'running').length;
  const waitingCount = tasks.filter((task) => task.status === 'waiting_for_input' || task.status === 'waiting_approval').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;

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

  return (
    <section className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          {workspaceDir && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('workspace')}: {workspaceDir}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!pluginInstalled || !pluginEnabled ? (
            <Button onClick={handleInstall} disabled={loading}>
              <Wrench className="mr-2 h-4 w-4" />
              {t('installPlugin')}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => void refreshTasks()} disabled={loading || !pluginInstalled || !pluginEnabled}>
            <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
            {t('refresh')}
          </Button>
        </div>
      </header>

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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
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
        <Card>
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
        <Card>
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
      </div>

      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-destructive">{error}</CardContent>
        </Card>
      )}

      {!initialized ? null : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
          <Card className="h-[70vh] overflow-hidden">
            <CardHeader>
              <CardTitle>{t('listTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 overflow-y-auto pb-6">
              {tasks.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('empty')}</p>
              ) : (
                tasks.map((task) => (
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

          <Card className="h-[70vh] overflow-hidden">
            <CardHeader>
              <CardTitle>{selectedTask ? selectedTask.goal : t('detailTitle')}</CardTitle>
              <CardDescription>{selectedTask?.id || '-'}</CardDescription>
            </CardHeader>
            <CardContent className="h-[calc(70vh-112px)] overflow-y-auto">
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
                          <span>{t('stepsOverview', { defaultValue: '步骤清单' })}</span>
                          <span>
                            {checklistSummary.done}/{checklistSummary.total} {t('completedTag', { defaultValue: '已完成' })}
                          </span>
                        </div>

                        {selectedTaskChecklist.map((step, index) => (
                          <StepSection
                            key={`${selectedTask.id}-${step.id}`}
                            step={step}
                            defaultOpen={index === 0}
                            doneLabel={t('completedTag', { defaultValue: '完成' })}
                            pendingLabel={t('pendingTag', { defaultValue: '待办' })}
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

      {blockedQueue.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <Card className="w-full max-w-2xl">
            <CardHeader>
              <CardTitle>{t('blocked.title')}</CardTitle>
              <CardDescription>
                {t('blocked.pendingCount', { count: blockedQueue.length, defaultValue: '{{count}} 个任务待确认' })}
              </CardDescription>
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
                          placeholder={t('blocked.inputPlaceholder', {
                            defaultValue: '请输入该任务需要的补充信息',
                          })}
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
                            {t('blocked.submitInput', { defaultValue: '提交输入' })}
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
