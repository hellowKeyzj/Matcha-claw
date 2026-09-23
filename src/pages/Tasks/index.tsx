import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Loader2,
  ListTodo,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { StableScrollArea } from '@/components/scroll';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TaskCenterPageTitle } from '@/components/task-center/page-title';
import { TaskCenterEmptyState, TaskCenterStatusFilter, TaskCenterSurface, TaskCenterToolbar } from '@/components/task-center/surface';
import { Select } from '@/components/ui/select';
import { DatePicker } from '@/components/ui/date-picker';
import { useGatewayStore } from '@/stores/gateway';
import { useTaskCenterStore } from '@/stores/task-center-store';
import { isGatewayOperational, isGatewayPreparing } from '@/lib/gateway-status';
import { scheduleIdleReady } from '@/lib/idle-ready';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { cn } from '@/lib/utils';
import { Cron } from '@/pages/Cron';
import { listTaskSnapshot, type Task } from '@/services/openclaw/task-manager-client';
import { useChatStore } from '@/stores/chat';
import { readSessionsFromState } from '@/stores/chat/session-helpers';
import { useTeamsStore } from '@/stores/teams';

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'success' {
  if (status === 'completed') return 'success';
  if (status === 'in_progress') return 'default';
  return 'secondary';
}

function statusDotClass(status: string): string {
  if (status === 'completed') return 'bg-emerald-500';
  if (status === 'in_progress') return 'bg-blue-500';
  if (status === 'pending') return 'bg-amber-500';
  return 'bg-slate-400';
}

type TaskCenterTab = 'long' | 'scheduled';
type TaskStatsWindow = 'all' | '7d' | '30d' | 'custom';
type TaskCenterScopeFilter =
  | { type: 'agent'; agentId: string }
  | { type: 'team'; teamId: string };

type TaskStatusFilter = 'all' | 'running' | 'waiting' | 'completed' | 'incomplete';
type ScopedTask = Task & { scopeKey?: string; scopeType?: 'agent' | 'team'; sourceSessionKey?: string; sourceTeamKey?: string };
type TaskDeleteTarget = {
  id: string;
  viewKey: string;
  sourceSessionKey: string;
  sourceTeamKey: string | null;
};

const TASK_POLLING_FAST_MS = 5_000;
const TASK_POLLING_NORMAL_MS = 20_000;
const TASK_POLLING_BACKGROUND_MS = 60_000;
const INITIAL_TASK_LIST_BATCH = 40;
const TASK_LIST_BATCH_SIZE = 40;
const TASK_LIST_SCROLL_THRESHOLD_PX = 160;
const TASK_LIST_VIRTUAL_THRESHOLD = 50;
const TASK_LIST_ESTIMATED_ROW_HEIGHT = 96;
const TASK_LIST_VIRTUAL_OVERSCAN = 6;
const TASK_HEAVY_CONTENT_IDLE_TIMEOUT_MS = 320;

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
  return normalizeTaskTimestampMs(task.updatedAt) ?? normalizeTaskTimestampMs(task.createdAt);
}

function resolveDateRangeMs(dateFrom: string, dateTo: string): { startMs: number | null; endMs: number | null } {
  const orderedFrom = dateFrom && dateTo && dateFrom > dateTo ? dateTo : dateFrom;
  const orderedTo = dateFrom && dateTo && dateFrom > dateTo ? dateFrom : dateTo;
  const startMs = orderedFrom ? Date.parse(`${orderedFrom}T00:00:00`) : NaN;
  const endMs = orderedTo ? Date.parse(`${orderedTo}T23:59:59.999`) : NaN;
  return {
    startMs: Number.isFinite(startMs) ? startMs : null,
    endMs: Number.isFinite(endMs) ? endMs : null,
  };
}

function formatFilterValue(filter: TaskCenterScopeFilter): string {
  return filter.type === 'team' ? `team:${filter.teamId}` : `agent:${filter.agentId}`;
}

function parseFilterValue(value: string): TaskCenterScopeFilter | null {
  if (value.startsWith('team:')) {
    const teamId = value.slice('team:'.length).trim();
    return teamId ? { type: 'team', teamId } : null;
  }
  if (value.startsWith('agent:')) {
    const agentId = value.slice('agent:'.length).trim();
    return agentId ? { type: 'agent', agentId } : null;
  }
  return null;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0))).sort((left, right) => left.localeCompare(right));
}

function taskViewKey(task: ScopedTask): string {
  return `${task.scopeKey ?? task.sourceSessionKey ?? task.sourceTeamKey ?? 'task'}:${task.id}`;
}

function resolveTaskSession(sessions: ReturnType<typeof readSessionsFromState>, sessionKey: string) {
  return sessions.find((session) => session.key === sessionKey) ?? null;
}

function isIncompleteTask(task: Task): boolean {
  return task.status !== 'completed';
}

function matchesStatusFilter(task: Task, filter: TaskStatusFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'running') return task.status === 'in_progress';
  if (filter === 'waiting') return task.status === 'pending';
  if (filter === 'completed') return task.status === 'completed';
  return isIncompleteTask(task);
}

function formatDateTime(value: number | undefined): string {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return new Date(Number(value)).toLocaleString();
}

export function TasksPage() {
  const { t, i18n } = useTranslation('tasks');
  const [searchParams, setSearchParams] = useSearchParams();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const gatewayInitialized = useGatewayStore((state) => state.isInitialized);
  const currentSessionKey = useChatStore((state) => state.currentSessionKey);
  const currentAgentId = useChatStore((state) => {
    const meta = state.loadedSessions[state.currentSessionKey]?.meta;
    return meta?.agentId ?? meta?.sessionIdentity?.agentId ?? 'main';
  });
  const sessions = useChatStore((state) => readSessionsFromState(state));
  const sessionsLoadedOnce = useChatStore((state) => state.sessionCatalogStatus.hasLoadedOnce);
  const loadSessions = useChatStore((state) => state.loadSessions);
  const teams = useTeamsStore((state) => state.teams);
  const {
    initialLoading,
    refreshing,
    mutating,
    initialized,
    error,
    init,
    refreshTasks,
    deleteTaskById,
  } = useTaskCenterStore();

  const [scopeFilter, setScopeFilter] = useState<TaskCenterScopeFilter>(() => ({
    type: 'agent',
    agentId: currentAgentId,
  }));
  const [scopedTasks, setScopedTasks] = useState<ScopedTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [statsWindow, setStatsWindow] = useState<TaskStatsWindow>('all');
  const [statusFilter, setStatusFilter] = useState<TaskStatusFilter>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [statsNowMs, setStatsNowMs] = useState<number>(() => Date.now());
  const [visibleTaskCount, setVisibleTaskCount] = useState(INITIAL_TASK_LIST_BATCH);
  const agentIds = useMemo(() => {
    return uniqueSorted([
      currentAgentId,
      ...sessions.map((session) => session.agentId ?? ''),
    ]);
  }, [currentAgentId, sessions]);
  const tasks = scopedTasks;
  const [taskHeavyContentReady, setTaskHeavyContentReady] = useState(() => tasks.length > 0 || initialized);
  const [taskToDelete, setTaskToDelete] = useState<TaskDeleteTarget | null>(null);

  const [taskListScrollTop, setTaskListScrollTop] = useState(0);
  const [taskListViewportHeight, setTaskListViewportHeight] = useState(0);
  const scopedTasksRequestSeqRef = useRef(0);
  const taskListScrollRef = useRef<HTMLDivElement | null>(null);
  const getTaskListScrollElement = useCallback(() => {
    if (taskListScrollRef.current?.isConnected) return taskListScrollRef.current;
    const element = document.querySelector<HTMLDivElement>('[data-task-list-scroll="true"]');
    taskListScrollRef.current = element;
    return element;
  }, []);
  const activeTab = resolveTaskCenterTab(searchParams.get('tab'));
  const gatewayOperational = isGatewayOperational(gatewayStatus);
  const gatewayPreparing = isGatewayPreparing(gatewayStatus, gatewayInitialized);
  const manualRefreshBusy = refreshing || mutating;
  const showInitialLoading = initialLoading;
  const showRefreshingHint = useDelayedFlag(refreshing && initialized, 180);
  const tasksForView = useMemo(
    () => (taskHeavyContentReady ? tasks : []),
    [taskHeavyContentReady, tasks],
  );

  useEffect(() => {
    const currentSession = resolveTaskSession(sessions, currentSessionKey);
    if (!initialized) {
      void init(currentSession ? {
        recordKey: currentSession.key,
        sessionIdentity: currentSession.sessionIdentity,
      } : undefined);
      return;
    }
    if (!currentSession) {
      return;
    }
    void refreshTasks({
      sessionKey: currentSession.key,
      sessionIdentity: currentSession.sessionIdentity,
      silent: true,
    });
  }, [currentSessionKey, init, initialized, refreshTasks, sessions]);

  const loadScopedTasks = useCallback(async () => {
    const requestSeq = scopedTasksRequestSeqRef.current + 1;
    scopedTasksRequestSeqRef.current = requestSeq;
    const clearScopedTasksIfCurrent = () => {
      if (scopedTasksRequestSeqRef.current === requestSeq) {
        setScopedTasks([]);
      }
    };

    try {
      const chatState = useChatStore.getState();
      const activeSessionKey = chatState.currentSessionKey;
      const activeSessions = readSessionsFromState(chatState);
      if (!activeSessionKey) {
        clearScopedTasksIfCurrent();
        return;
      }
      const activeSession = resolveTaskSession(activeSessions, activeSessionKey);
      if (!activeSession) {
        clearScopedTasksIfCurrent();
        return;
      }
      if (scopeFilter.type === 'team') {
        const snapshot = await listTaskSnapshot({ sessionKey: activeSession.sessionIdentity.sessionKey, sessionIdentity: activeSession.sessionIdentity, teamKey: scopeFilter.teamId });
        if (scopedTasksRequestSeqRef.current !== requestSeq) {
          return;
        }
        setScopedTasks(snapshot.tasks.map((task) => ({
          ...task,
          scopeKey: snapshot.scope?.key ?? `team:${scopeFilter.teamId}`,
          scopeType: 'team',
          sourceSessionKey: activeSession.key,
          sourceTeamKey: scopeFilter.teamId,
        })));
        return;
      }
      const scopedSessions = activeSessions.filter((session) => session.agentId === scopeFilter.agentId);
      const uniqueSessionKeys = uniqueSorted(scopedSessions.map((session) => session.key));
      const sessionByKey = new Map(scopedSessions.map((session) => [session.key, session]));
      const snapshots = await Promise.all(uniqueSessionKeys.map(async (sessionKey) => {
        const session = sessionByKey.get(sessionKey)!;
        return {
          sessionKey,
          snapshot: await listTaskSnapshot({ sessionKey: session.sessionIdentity.sessionKey, sessionIdentity: session.sessionIdentity }),
        };
      }));
      if (scopedTasksRequestSeqRef.current !== requestSeq) {
        return;
      }
      setScopedTasks(snapshots.flatMap(({ sessionKey, snapshot }) => snapshot.tasks.map((task) => ({
        ...task,
        scopeKey: snapshot.scope?.key ?? sessionKey,
        scopeType: 'agent' as const,
        sourceSessionKey: sessionKey,
      }))));
    } catch {
      clearScopedTasksIfCurrent();
    }
  }, [scopeFilter]);

  useEffect(() => {
    if (!sessionsLoadedOnce) {
      void loadSessions();
    }
  }, [loadSessions, sessionsLoadedOnce]);

  useEffect(() => {
    if (!sessionsLoadedOnce) {
      return;
    }
    const rafId = window.requestAnimationFrame(() => {
      void loadScopedTasks();
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [loadScopedTasks, sessions, sessionsLoadedOnce]);

  useEffect(() => {
    const updateNow = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      const now = Date.now();
      setStatsNowMs((prev) => (Math.abs(prev - now) < 500 ? prev : now));
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        updateNow();
      }
    };

    updateNow();
    const timer = window.setInterval(() => {
      updateNow();
    }, 60_000);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (taskHeavyContentReady) {
      return;
    }
    if (initialized && tasks.length <= TASK_LIST_VIRTUAL_THRESHOLD) {
      const rafId = window.requestAnimationFrame(() => {
        setTaskHeavyContentReady(true);
      });
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }
    const cancel = scheduleIdleReady(() => {
      setTaskHeavyContentReady(true);
    }, {
      idleTimeoutMs: TASK_HEAVY_CONTENT_IDLE_TIMEOUT_MS,
      fallbackDelayMs: 120,
      useAnimationFrame: true,
    });
    return cancel;
  }, [initialized, taskHeavyContentReady, tasks.length]);

  const hasActiveTasks = useMemo(
    () => tasks.some((task) => task.status === 'pending' || task.status === 'in_progress'),
    [tasks],
  );

  useEffect(() => {
    if (!gatewayOperational || activeTab === 'scheduled') {
      return;
    }

    let timer: number | null = null;
    let disposed = false;

    const clearTimer = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const resolveDelay = () => {
      if (document.visibilityState !== 'visible') {
        return TASK_POLLING_BACKGROUND_MS;
      }
      return hasActiveTasks ? TASK_POLLING_FAST_MS : TASK_POLLING_NORMAL_MS;
    };

    const scheduleNext = () => {
      if (disposed) {
        return;
      }
      clearTimer();
      timer = window.setTimeout(() => {
        void refreshTasks({ silent: true }).finally(() => {
          void loadScopedTasks().finally(() => {
            scheduleNext();
          });
        });
      }, resolveDelay());
    };

    const handleVisibilityChange = () => {
      if (disposed) {
        return;
      }
      clearTimer();
      if (document.visibilityState === 'visible') {
        void refreshTasks({ silent: true }).finally(() => {
          void loadScopedTasks().finally(() => {
            scheduleNext();
          });
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
  }, [activeTab, gatewayOperational, hasActiveTasks, loadScopedTasks, refreshTasks]);

  const dateRange = useMemo(() => resolveDateRangeMs(dateFrom, dateTo), [dateFrom, dateTo]);
  const longTasks = useMemo(() => {
    return tasksForView.filter((task) => {
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
  }, [dateRange.endMs, dateRange.startMs, tasksForView]);
  const statsTasks = useMemo(() => {
    if (statsWindow === 'all' || statsWindow === 'custom') {
      return longTasks;
    }
    const days = statsWindow === '7d' ? 7 : 30;
    const cutoff = statsNowMs - days * 24 * 60 * 60 * 1000;
    return longTasks.filter((task) => {
      const taskTime = resolveTaskTimestampMs(task);
      return taskTime != null && taskTime >= cutoff;
    });
  }, [longTasks, statsNowMs, statsWindow]);
  const filteredTasks = useMemo(
    () => statsTasks.filter((task) => matchesStatusFilter(task, statusFilter)),
    [statsTasks, statusFilter],
  );
  const shouldUseVirtualTaskList = taskHeavyContentReady && filteredTasks.length > TASK_LIST_VIRTUAL_THRESHOLD;
  const showTaskContent = !showInitialLoading && taskHeavyContentReady;
  const taskListResetKey = `${formatFilterValue(scopeFilter)}:${statsWindow}:${dateFrom}:${dateTo}:${statusFilter}:${filteredTasks.length === 0 ? 'empty' : 'filled'}`;
  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      setTaskListScrollTop(0);
      const scroller = getTaskListScrollElement();
      if (scroller) {
        scroller.scrollTop = 0;
      }
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [getTaskListScrollElement, taskListResetKey]);

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      if (!shouldUseVirtualTaskList) {
        setTaskListScrollTop(0);
        return;
      }
      const maxScrollTop = Math.max(0, filteredTasks.length * TASK_LIST_ESTIMATED_ROW_HEIGHT - taskListViewportHeight);
      setTaskListScrollTop((prev) => Math.min(prev, maxScrollTop));
    });
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [filteredTasks.length, shouldUseVirtualTaskList, taskListViewportHeight]);

  useEffect(() => {
    if (!shouldUseVirtualTaskList || !showTaskContent || activeTab !== 'long') {
      const rafId = window.requestAnimationFrame(() => {
        setTaskListViewportHeight((prev) => (prev === 0 ? prev : 0));
      });
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }

    const element = getTaskListScrollElement();
    if (!element) {
      return;
    }

    let rafId: number | null = null;
    const updateHeight = (nextHeight: number) => {
      if (rafId != null) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        setTaskListViewportHeight((prev) => (prev === nextHeight ? prev : nextHeight));
      });
    };

    updateHeight(Math.round(element.clientHeight));
    const observer = new ResizeObserver((entries) => {
      const measuredHeight = Math.round(entries[0]?.contentRect.height ?? element.clientHeight);
      updateHeight(measuredHeight);
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
      if (rafId != null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [activeTab, getTaskListScrollElement, shouldUseVirtualTaskList, showTaskContent]);

  const visibleTasks = useMemo(
    () => filteredTasks.slice(0, visibleTaskCount),
    [filteredTasks, visibleTaskCount],
  );

  const appendVisibleTasks = useCallback(() => {
    setVisibleTaskCount((prev) => {
      if (prev >= filteredTasks.length) {
        return prev;
      }
      return Math.min(prev + TASK_LIST_BATCH_SIZE, filteredTasks.length);
    });
  }, [filteredTasks.length]);

  const handleTaskListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (shouldUseVirtualTaskList) {
      setTaskListScrollTop((prev) => (prev === target.scrollTop ? prev : target.scrollTop));
      return;
    }
    if (visibleTaskCount >= filteredTasks.length) {
      return;
    }
    const remain = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (remain <= TASK_LIST_SCROLL_THRESHOLD_PX) {
      appendVisibleTasks();
    }
  }, [appendVisibleTasks, filteredTasks.length, shouldUseVirtualTaskList, visibleTaskCount]);

  useEffect(() => {
    if (shouldUseVirtualTaskList) {
      return;
    }
    if (activeTab !== 'long' || !taskHeavyContentReady) {
      return;
    }
    if (visibleTaskCount >= filteredTasks.length) {
      return;
    }
    const container = getTaskListScrollElement();
    if (!container) {
      return;
    }
    if (container.scrollHeight <= container.clientHeight + 8) {
      window.requestAnimationFrame(() => {
        appendVisibleTasks();
      });
    }
  }, [
    activeTab,
    appendVisibleTasks,
    filteredTasks.length,
    getTaskListScrollElement,
    shouldUseVirtualTaskList,
    taskHeavyContentReady,
    visibleTaskCount,
    visibleTasks.length,
  ]);

  const virtualWindow = useMemo(() => {
    if (!shouldUseVirtualTaskList) {
      return {
        tasks: visibleTasks,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0,
      };
    }
    const safeViewportHeight = Math.max(taskListViewportHeight, TASK_LIST_ESTIMATED_ROW_HEIGHT);
    const safeScrollTop = Math.min(
      taskListScrollTop,
      Math.max(0, filteredTasks.length * TASK_LIST_ESTIMATED_ROW_HEIGHT - safeViewportHeight),
    );
    const visibleCount = Math.max(1, Math.ceil(safeViewportHeight / TASK_LIST_ESTIMATED_ROW_HEIGHT));
    const startIndex = Math.max(
      0,
      Math.floor(safeScrollTop / TASK_LIST_ESTIMATED_ROW_HEIGHT) - TASK_LIST_VIRTUAL_OVERSCAN,
    );
    const endIndex = Math.min(
      filteredTasks.length,
      startIndex + visibleCount + TASK_LIST_VIRTUAL_OVERSCAN * 2,
    );
    return {
      tasks: filteredTasks.slice(startIndex, endIndex),
      topSpacerHeight: startIndex * TASK_LIST_ESTIMATED_ROW_HEIGHT,
      bottomSpacerHeight: Math.max(0, (filteredTasks.length - endIndex) * TASK_LIST_ESTIMATED_ROW_HEIGHT),
    };
  }, [filteredTasks, shouldUseVirtualTaskList, taskListScrollTop, taskListViewportHeight, visibleTasks]);

  const effectiveSelectedTaskId = useMemo(() => {
    if (filteredTasks.length === 0) {
      return null;
    }
    if (selectedTaskId && filteredTasks.some((task) => taskViewKey(task) === selectedTaskId)) {
      return selectedTaskId;
    }
    return taskViewKey(filteredTasks[0]);
  }, [filteredTasks, selectedTaskId]);

  const selectedTask = useMemo(
    () => filteredTasks.find((task) => taskViewKey(task) === effectiveSelectedTaskId) ?? null,
    [effectiveSelectedTaskId, filteredTasks],
  );

  const taskStatusSummary = useMemo(() => {
    return statsTasks.reduce(
      (acc, task) => {
        if (task.status === 'in_progress') {
          acc.running += 1;
        }
        if (task.status === 'pending') {
          acc.waiting += 1;
        }
        if (task.status === 'completed') {
          acc.completed += 1;
        }
        if (isIncompleteTask(task)) {
          acc.incomplete += 1;
        }
        return acc;
      },
      { running: 0, waiting: 0, completed: 0, incomplete: 0 },
    );
  }, [statsTasks]);
  const runningCount = taskStatusSummary.running;
  const waitingCount = taskStatusSummary.waiting;
  const completedCount = taskStatusSummary.completed;
  const incompleteCount = taskStatusSummary.incomplete;

  const handleDeleteTask = (task: ScopedTask) => {
    if (!task.id || !task.sourceSessionKey) {
      return;
    }
    setTaskToDelete({
      id: task.id,
      viewKey: taskViewKey(task),
      sourceSessionKey: task.sourceSessionKey,
      sourceTeamKey: task.sourceTeamKey ?? null,
    });
  };

  const confirmDeleteTask = async () => {
    const deleteTarget = taskToDelete;
    if (!deleteTarget) {
      return;
    }
    const sourceSession = resolveTaskSession(sessions, deleteTarget.sourceSessionKey);
    if (!sourceSession) {
      return;
    }
    await deleteTaskById({
      taskId: deleteTarget.id,
      sessionKey: sourceSession.key,
      sessionIdentity: sourceSession.sessionIdentity,
      ...(deleteTarget.sourceTeamKey ? { teamKey: deleteTarget.sourceTeamKey } : {}),
    });
    const next = useTaskCenterStore.getState();
    if (next.error) {
      toast.error(next.error);
      return;
    }
    toast.success(t('toast.deleted'));
    setScopedTasks((prev) => prev.filter((task) => taskViewKey(task) !== deleteTarget.viewKey));
    if (selectedTaskId === deleteTarget.viewKey) {
      setSelectedTaskId(null);
    }
    setTaskToDelete(null);
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
        <TaskCenterPageTitle title={t('title')} subtitle={t('subtitle')} />
      </header>
      <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4">
        <TabsList className="grid w-full max-w-sm grid-cols-2">
          <TabsTrigger value="long">{t('tabs.long')}</TabsTrigger>
          <TabsTrigger value="scheduled">{t('tabs.scheduled')}</TabsTrigger>
        </TabsList>

        <TabsContent value="long" className="mt-0 space-y-5">
          <TaskCenterToolbar
            actions={(
              <>
                <Select
                  value={formatFilterValue(scopeFilter)}
                  onChange={(event) => {
                    const next = parseFilterValue(event.target.value);
                    if (next) {
                      setScopeFilter(next);
                      setSelectedTaskId(null);
                    }
                  }}
                  className="h-9 w-auto max-w-44 py-1 pl-3 pr-9 text-sm"
                  aria-label={t('scope.label', { defaultValue: 'Scope' })}
                >
                  {agentIds.map((agentId) => (
                    <option key={`agent:${agentId}`} value={`agent:${agentId}`}>
                      Agent: {agentId}
                    </option>
                  ))}
                  {teams.map((team) => (
                    <option key={`team:${team.id}`} value={`team:${team.id}`}>
                      Team: {team.name || team.id}
                    </option>
                  ))}
                </Select>
                <Select
                  value={statsWindow}
                  onChange={(event) => {
                    const next = event.target.value as TaskStatsWindow;
                    setStatsWindow(next);
                    setStatusFilter('all');
                    if (next !== 'custom') {
                      setDateFrom('');
                      setDateTo('');
                    }
                  }}
                  className="h-9 w-auto py-1 pl-3 pr-9 text-sm"
                  aria-label={t('timeWindow.title')}
                >
                  <option value="all">{t('timeWindow.selection', { range: t('timeWindow.all') })}</option>
                  <option value="7d">{t('timeWindow.selection', { range: t('timeWindow.last7Days') })}</option>
                  <option value="30d">{t('timeWindow.selection', { range: t('timeWindow.last30Days') })}</option>
                  <option value="custom">{t('timeWindow.selection', { range: t('timeWindow.custom') })}</option>
                </Select>
                {(statsWindow !== 'all' || statusFilter !== 'all' || dateFrom || dateTo) && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-9 px-2 text-muted-foreground"
                    onClick={clearFilters}
                  >
                    {t('filters.clear')}
                  </Button>
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-9 w-9 shrink-0 text-muted-foreground"
                  aria-label={t('refresh')}
                  title={t('refresh')}
                  onClick={() => {
                    void loadSessions().then(() => loadScopedTasks());
                  }}
                  disabled={manualRefreshBusy}
                >
                  <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} aria-hidden="true" />
                </Button>
              </>
            )}
          >
            <TaskCenterStatusFilter
              count={statsTasks.length}
              label={t('cron:filters.all')}
              active={statusFilter === 'all'}
              onClick={() => setStatusFilter('all')}
            />
            <TaskCenterStatusFilter
              count={runningCount}
              label={t('stats.running')}
              active={statusFilter === 'running'}
              onClick={() => setStatusFilter((prev) => (prev === 'running' ? 'all' : 'running'))}
            />
            <TaskCenterStatusFilter
              count={waitingCount}
              label={t('stats.waiting')}
              active={statusFilter === 'waiting'}
              onClick={() => setStatusFilter((prev) => (prev === 'waiting' ? 'all' : 'waiting'))}
            />
            <TaskCenterStatusFilter
              count={completedCount}
              label={t('stats.completed')}
              active={statusFilter === 'completed'}
              onClick={() => setStatusFilter((prev) => (prev === 'completed' ? 'all' : 'completed'))}
            />
            <TaskCenterStatusFilter
              count={incompleteCount}
              label={t('stats.incomplete')}
              active={statusFilter === 'incomplete'}
              onClick={() => setStatusFilter((prev) => (prev === 'incomplete' ? 'all' : 'incomplete'))}
            />
          </TaskCenterToolbar>

          {statsWindow === 'custom' && (
            <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
              <DatePicker
                id="tasks-date-from"
                label={t('filters.from')}
                placeholder={t('filters.isoDatePlaceholder')}
                value={dateFrom}
                onChange={setDateFrom}
                locale={i18n.language}
              />
              <DatePicker
                id="tasks-date-to"
                label={t('filters.to')}
                placeholder={t('filters.isoDatePlaceholder')}
                value={dateTo}
                onChange={setDateTo}
                locale={i18n.language}
              />
            </div>
          )}

          {!gatewayOperational && (
            <Card className={gatewayPreparing ? 'border-border bg-muted/30' : 'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10'}>
              <CardContent className={cn(
                'flex items-center gap-3 py-4',
                gatewayPreparing ? 'text-muted-foreground' : 'text-yellow-700 dark:text-yellow-300',
              )}>
                {gatewayPreparing ? <Loader2 className="h-5 w-5 animate-spin" /> : <AlertCircle className="h-5 w-5" />}
                {gatewayPreparing ? t('gatewayPreparing') : t('gatewayNotRunning')}
              </CardContent>
            </Card>
          )}

          {showRefreshingHint && (
            <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              {t('common:status.loading', 'Loading...')}
            </div>
          )}

          {error && (
            <Card className="border-destructive">
              <CardContent className="py-4 text-destructive">{error}</CardContent>
            </Card>
          )}

          <TaskCenterSurface>
            {!showTaskContent ? (
              <div className="grid grid-cols-1 lg:grid-cols-[380px_minmax(0,1fr)]">
                <div className="h-[70vh] overflow-hidden border-b bg-card lg:border-b-0 lg:border-r">
                  {Array.from({ length: 6 }).map((_, index) => (
                    <div key={`task-initial-placeholder-${index}`} className="h-24 border-b px-4 py-3">
                      <div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
                      <div className="mt-3 h-2 w-full animate-pulse rounded bg-muted" />
                      <div className="mt-2 h-2 w-16 animate-pulse rounded bg-muted" />
                    </div>
                  ))}
                </div>
                <div className="h-[70vh] space-y-3 bg-card p-5">
                  <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                  <div className="h-16 w-full animate-pulse rounded bg-muted" />
                  <div className="h-20 w-full animate-pulse rounded bg-muted" />
                </div>
              </div>
            ) : filteredTasks.length === 0 ? (
              <TaskCenterEmptyState icon={ListTodo} title={t('empty')} />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-[380px_minmax(0,1fr)]">
                <div className="flex h-[70vh] min-w-0 flex-col overflow-hidden border-b bg-card lg:border-b-0 lg:border-r">
                  <CardHeader className="shrink-0 border-b px-4 py-4">
                    <CardTitle className="text-sm">{t('listTitle')}</CardTitle>
                  </CardHeader>
                  <StableScrollArea data-task-list-scroll="true" className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-card [scrollbar-gutter:stable]" onScroll={handleTaskListScroll}>
                    {shouldUseVirtualTaskList && virtualWindow.topSpacerHeight > 0 ? (
                      <div aria-hidden style={{ height: virtualWindow.topSpacerHeight }} />
                    ) : null}
                    {virtualWindow.tasks.map((task) => (
                      <button
                        key={taskViewKey(task)}
                        type="button"
                        className={cn(
                          'flex w-full flex-col justify-between overflow-hidden border-b px-4 py-3 text-left transition-colors',
                          effectiveSelectedTaskId === taskViewKey(task) ? 'bg-primary/5' : 'hover:bg-accent/40',
                        )}
                        style={{ height: TASK_LIST_ESTIMATED_ROW_HEIGHT }}
                        onClick={() => setSelectedTaskId(taskViewKey(task))}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="line-clamp-2 text-sm font-medium">{task.subject}</p>
                          <span
                            className={cn('mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full', statusDotClass(task.status))}
                            title={task.status}
                            aria-label={task.status}
                          />
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="truncate">{task.owner || t('detail.unassigned', { defaultValue: 'Unassigned' })}</span>
                          <span className="shrink-0">
                            {t('detail.blockedByCount', { count: task.blockedBy.length, defaultValue: '{{count}} blockers' })}
                          </span>
                        </div>
                      </button>
                    ))}
                    {shouldUseVirtualTaskList && virtualWindow.bottomSpacerHeight > 0 ? (
                      <div aria-hidden style={{ height: virtualWindow.bottomSpacerHeight }} />
                    ) : null}
                    {!shouldUseVirtualTaskList && visibleTaskCount < filteredTasks.length && (
                      <div className="space-y-2 px-4 py-3 text-center">
                        <p className="text-xs text-muted-foreground">
                          {t('pagination.showing', { shown: visibleTaskCount, total: filteredTasks.length })}
                        </p>
                        <Button variant="outline" size="sm" onClick={appendVisibleTasks}>
                          {t('pagination.loadMore')}
                        </Button>
                      </div>
                    )}
                  </StableScrollArea>
                </div>

                <div className="flex h-[70vh] min-w-0 flex-col overflow-hidden bg-card">
                  <CardHeader className="shrink-0 p-5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <CardTitle className="break-words text-[15px] leading-6">{selectedTask ? selectedTask.subject : t('detailTitle')}</CardTitle>
                        {selectedTask && <CardDescription className="break-all">{selectedTask.id}</CardDescription>}
                      </div>
                      {selectedTask ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="shrink-0"
                          onClick={() => void handleDeleteTask(selectedTask)}
                          disabled={mutating}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                          <span className="ml-1 text-destructive">{t('actions.delete')}</span>
                        </Button>
                      ) : null}
                    </div>
                  </CardHeader>
                  <StableScrollArea className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-card [scrollbar-gutter:stable]">
                    <CardContent className="px-5 pb-5">
                      {!selectedTask ? (
                        <p className="text-sm text-muted-foreground">{t('selectTask')}</p>
                      ) : (
                        <div className="space-y-4 text-sm">
                          <div className="flex items-center gap-2">
                            <Badge variant={statusVariant(selectedTask.status)}>{selectedTask.status}</Badge>
                            <span className="text-sm text-muted-foreground">
                              {selectedTask.owner || t('detail.unassigned', { defaultValue: 'Unassigned' })}
                            </span>
                          </div>

                          <div className="space-y-3 border-t pt-4">
                            <p className="text-sm font-medium text-muted-foreground">
                              {t('detail.description', { defaultValue: 'Description' })}
                            </p>
                            <p className="whitespace-pre-wrap text-sm text-foreground">
                              {selectedTask.description || '-'}
                            </p>
                          </div>

                          <div className="space-y-3 border-t pt-4">
                            <div className="flex items-center justify-between">
                              <p className="text-sm font-medium text-muted-foreground">
                                {t('detail.dependencies', { defaultValue: 'Dependencies' })}
                              </p>
                            </div>
                            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                              <div>
                                <p className="text-xs text-muted-foreground">
                                  {t('detail.blockedBy', { defaultValue: 'Blocked By' })}
                                </p>
                                <p className="mt-1 break-all text-sm">
                                  {selectedTask.blockedBy.length > 0 ? selectedTask.blockedBy.join(', ') : '-'}
                                </p>
                              </div>
                              <div>
                                <p className="text-xs text-muted-foreground">
                                  {t('detail.blocks', { defaultValue: 'Blocks' })}
                                </p>
                                <p className="mt-1 break-all text-sm">
                                  {selectedTask.blocks.length > 0 ? selectedTask.blocks.join(', ') : '-'}
                                </p>
                              </div>
                            </div>
                            <div className="grid grid-cols-1 gap-3 border-t pt-3 md:grid-cols-2">
                              <div>
                                <p className="text-xs text-muted-foreground">{t('createdAt')}</p>
                                <p className="mt-1 text-sm">{formatDateTime(selectedTask.createdAt)}</p>
                              </div>
                              <div>
                                <p className="text-xs text-muted-foreground">
                                  {t('detail.updatedAt', { defaultValue: 'Updated' })}
                                </p>
                                <p className="mt-1 text-sm">{formatDateTime(selectedTask.updatedAt)}</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </StableScrollArea>
                </div>
              </div>
            )}
          </TaskCenterSurface>
        </TabsContent>

        <TabsContent value="scheduled" className="mt-0">
          <Cron embedded />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={!!taskToDelete}
        title={t('common:actions.confirm', 'Confirm')}
        message={t('actions.deleteConfirm')}
        confirmLabel={t('common:actions.delete', 'Delete')}
        cancelLabel={t('common:actions.cancel', 'Cancel')}
        variant="destructive"
        onConfirm={confirmDeleteTask}
        onCancel={() => setTaskToDelete(null)}
      />
    </section>
  );
}

export default TasksPage;
