import { memo, useEffect, useMemo } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PaneEdgeToggle } from '@/components/layout/PaneEdgeToggle';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';
import { useTaskInboxStore } from '@/stores/task-inbox-store';

interface TaskInboxPanelProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const TASK_INBOX_POLL_FAST_MS = 5_000;
const TASK_INBOX_POLL_NORMAL_MS = 15_000;
const TASK_INBOX_POLL_BACKGROUND_MS = 60_000;

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'success' {
  if (status === 'in_progress') {
    return 'default';
  }
  if (status === 'pending') {
    return 'secondary';
  }
  if (status === 'completed') {
    return 'success';
  }
  return 'destructive';
}

function statusToPercent(status: string): number {
  if (status === 'completed') {
    return 100;
  }
  if (status === 'in_progress') {
    return 50;
  }
  return 0;
}

export const TaskInboxPanel = memo(function TaskInboxPanel({ collapsed = false, onToggleCollapse }: TaskInboxPanelProps) {
  const { t } = useTranslation('chat');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const isGatewayRunning = gatewayStatus.state === 'running';

  const tasks = useTaskInboxStore((state) => state.tasks);
  const loading = useTaskInboxStore((state) => state.loading);
  const initialized = useTaskInboxStore((state) => state.initialized);
  const error = useTaskInboxStore((state) => state.error);
  const workspaceLabel = useTaskInboxStore((state) => state.workspaceLabel);
  const init = useTaskInboxStore((state) => state.init);
  const refreshTasks = useTaskInboxStore((state) => state.refreshTasks);
  const openTaskSession = useTaskInboxStore((state) => state.openTaskSession);
  const clearError = useTaskInboxStore((state) => state.clearError);

  const unfinishedCount = tasks.length;
  const hasActiveTasks = useMemo(
    () => tasks.some((task) => task.status === 'pending' || task.status === 'in_progress'),
    [tasks],
  );

  useEffect(() => {
    if (!isGatewayRunning) {
      return;
    }
    if (!initialized) {
      void init();
      return;
    }
    void refreshTasks();
  }, [init, initialized, isGatewayRunning, refreshTasks]);

  useEffect(() => {
    if (!isGatewayRunning) {
      return;
    }
    let timer: number | undefined;
    let disposed = false;

    const clearTimer = () => {
      if (typeof timer === 'number') {
        window.clearTimeout(timer);
        timer = undefined;
      }
    };

    const resolveDelay = () => {
      if (document.visibilityState !== 'visible') {
        return TASK_INBOX_POLL_BACKGROUND_MS;
      }
      return hasActiveTasks ? TASK_INBOX_POLL_FAST_MS : TASK_INBOX_POLL_NORMAL_MS;
    };

    const scheduleNext = () => {
      if (disposed) {
        return;
      }
      clearTimer();
      timer = window.setTimeout(() => {
        void refreshTasks().finally(() => {
          scheduleNext();
        });
      }, resolveDelay());
    };

    const handleVisibilityChange = () => {
      if (disposed) {
        return;
      }
      clearTimer();
      if (document.visibilityState === 'visible') {
        void refreshTasks().finally(() => {
          scheduleNext();
        });
        return;
      }
      scheduleNext();
    };

    scheduleNext();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      clearTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [hasActiveTasks, isGatewayRunning, refreshTasks]);

  const handleOpenSession = (taskId: string) => {
    const result = openTaskSession(taskId);
    if (result.switched) {
      return;
    }
    toast.error(t('taskInbox.taskNotFound'));
  };

  if (collapsed) {
    return (
      <aside
        data-testid="chat-task-inbox-panel"
        className="relative flex h-full min-h-0 flex-col overflow-hidden border-l [border-left-color:var(--divider-line)] bg-card"
      >
        <div className="flex flex-1 flex-col items-center gap-2 px-1 py-3">
          <span className="px-1 text-xs text-muted-foreground [writing-mode:vertical-rl]">
            {t('taskInbox.title')}
          </span>
          <span className="rounded-md border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {unfinishedCount}
          </span>
        </div>
        <PaneEdgeToggle
          side="left"
          onClick={onToggleCollapse}
          ariaLabel={t('taskInbox.expand')}
          title={t('taskInbox.expand')}
          icon={<ChevronLeft className="h-2.5 w-2.5" />}
        />
      </aside>
    );
  }

  return (
    <aside data-testid="chat-task-inbox-panel" className="relative flex h-full min-h-0 flex-col overflow-hidden border-l [border-left-color:var(--divider-line)] bg-card">
      <div className="px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">{t('taskInbox.title')}</p>
            <p className="text-xs text-muted-foreground">
              {t('taskInbox.unfinishedCount', { count: unfinishedCount })}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => void refreshTasks()}
            disabled={!isGatewayRunning || loading}
            title={t('taskInbox.refresh')}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
        {workspaceLabel ? (
          <p className="mt-2 line-clamp-1 text-xs text-muted-foreground">
            {t('taskInbox.workspaceScope', { scope: workspaceLabel })}
          </p>
        ) : null}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!isGatewayRunning ? (
          <div className="rounded-md border border-yellow-400/60 bg-yellow-50 px-3 py-2 text-xs text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950/20 dark:text-yellow-200">
            {t('taskInbox.gatewayStopped')}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="break-words">{error}</p>
                <button
                  type="button"
                  onClick={clearError}
                  className="mt-1 text-[11px] underline underline-offset-2 hover:opacity-80"
                >
                  {t('common:actions.dismiss')}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {!loading && initialized && tasks.length === 0 ? (
          <p className="rounded-md border bg-background px-3 py-6 text-center text-sm text-muted-foreground">
            {t('taskInbox.empty')}
          </p>
        ) : null}

        {tasks.map((task) => {
          return (
            <Card key={`${task.id}-${task.workspaceDir || 'default'}`} className="bg-background/95">
              <CardContent className="space-y-3 p-3">
                <button
                  type="button"
                  onClick={() => handleOpenSession(task.id)}
                  className="w-full space-y-3 rounded-md p-1 text-left transition-colors hover:bg-accent/20"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-medium">{task.subject || t('taskInbox.untitledTask')}</p>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">{task.id}</p>
                    </div>
                    <Badge variant={statusVariant(task.status)}>
                      {t(`taskInbox.status.${task.status}`, { defaultValue: task.status })}
                    </Badge>
                  </div>

                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">{statusToPercent(task.status)}%</p>
                  </div>
                </button>

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => handleOpenSession(task.id)}
                >
                  {t('taskInbox.openSession')}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <PaneEdgeToggle
        side="left"
        onClick={onToggleCollapse}
        ariaLabel={t('taskInbox.collapse')}
        title={t('taskInbox.collapse')}
        icon={<ChevronRight className="h-2.5 w-2.5" />}
      />
    </aside>
  );
});
