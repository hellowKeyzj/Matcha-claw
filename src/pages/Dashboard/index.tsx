/**
 * Dashboard Page
 * Main overview page showing system status and quick actions
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  MessageSquare,
  Radio,
  Puzzle,
  Clock,
  Settings,
  Plus,
  Terminal,
  ChevronLeft,
  ChevronRight,
  Wrench,
  Loader2,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useGatewayStore } from '@/stores/gateway';
import { useChannelsStore } from '@/stores/channels';
import { useSkillsStore } from '@/stores/skills';
import { useSettingsStore } from '@/stores/settings';
import { useDashboardUsageStore } from '@/stores/dashboard-usage';
import { useDashboardUiStore } from '@/stores/dashboard-ui';
import { StatusBadge } from '@/components/common/StatusBadge';
import { FeedbackState } from '@/components/common/FeedbackState';
import { hostApiFetch } from '@/lib/host-api';
import { scheduleIdleReady } from '@/lib/idle-ready';
import { trackUiEvent } from '@/lib/telemetry';
import { useTranslation } from 'react-i18next';
import {
  filterUsageHistoryByWindow,
  groupUsageHistory,
} from './usage-history';
const DEFAULT_USAGE_FETCH_MAX_ATTEMPTS = 2;
const WINDOWS_USAGE_FETCH_MAX_ATTEMPTS = 3;
const DASHBOARD_HEAVY_CONTENT_IDLE_TIMEOUT_MS = 320;

export function Dashboard() {
  const { t } = useTranslation('dashboard');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const channels = useChannelsStore((state) => state.channels);
  const fetchChannels = useChannelsStore((state) => state.fetchChannels);
  const skills = useSkillsStore((state) => state.skills);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);

  const isGatewayRunning = gatewayStatus.state === 'running';
  const usageFetchMaxAttempts = window.electron?.platform === 'win32'
    ? WINDOWS_USAGE_FETCH_MAX_ATTEMPTS
    : DEFAULT_USAGE_FETCH_MAX_ATTEMPTS;
  const usageHistory = useDashboardUsageStore((state) => state.usageHistory);
  const usageHistoryReady = useDashboardUsageStore((state) => state.usageHistoryReady);
  const usageInitialLoading = useDashboardUsageStore((state) => state.initialLoading);
  const usageRefreshingState = useDashboardUsageStore((state) => state.refreshing);
  const usagePanelReady = useDashboardUsageStore((state) => state.usagePanelReady);
  const usageChartReady = useDashboardUsageStore((state) => state.usageChartReady);
  const usageDetailListReady = useDashboardUsageStore((state) => state.usageDetailListReady);
  const usageFetchError = useDashboardUsageStore((state) => state.error);
  const setUsagePanelReady = useDashboardUsageStore((state) => state.setUsagePanelReady);
  const setUsageVisualizationReady = useDashboardUsageStore((state) => state.setUsageVisualizationReady);
  const refreshUsageHistory = useDashboardUsageStore((state) => state.refreshUsageHistory);
  const dashboardHeavyContentReady = useDashboardUiStore((state) => state.dashboardHeavyContentReady);
  const usageGroupBy = useDashboardUiStore((state) => state.usageGroupBy);
  const usageWindow = useDashboardUiStore((state) => state.usageWindow);
  const usagePage = useDashboardUiStore((state) => state.usagePage);
  const setDashboardHeavyContentReady = useDashboardUiStore((state) => state.setDashboardHeavyContentReady);
  const setUsageGroupBy = useDashboardUiStore((state) => state.setUsageGroupBy);
  const setUsageWindow = useDashboardUiStore((state) => state.setUsageWindow);
  const setUsagePage = useDashboardUiStore((state) => state.setUsagePage);
  const [uptime, setUptime] = useState(0);

  // Track page view on mount only.
  useEffect(() => {
    trackUiEvent('dashboard.page_viewed');
  }, []);

  // Fetch channels/skills only when gateway is running.
  // 技能列表在 App 启动后已经预热过一次，仪表盘切换时仅在本地为空时再拉取，
  // 避免频繁切页重复触发 skills.status（会引发 Gateway skills 扫描日志噪音）。
  useEffect(() => {
    if (isGatewayRunning) {
      void fetchChannels({ silent: true });
      if (skills.length === 0) {
        void fetchSkills();
      }
    }
  }, [fetchChannels, fetchSkills, isGatewayRunning, skills.length]);

  // Fetch token usage history with retry when Gateway just restarted and
  // history data may not be ready yet.
  useEffect(() => {
    if (!isGatewayRunning) {
      return;
    }

    const restartMarker = `${gatewayStatus.pid ?? 'na'}:${gatewayStatus.connectedAt ?? 'na'}`;
    void refreshUsageHistory({
      maxAttempts: usageFetchMaxAttempts,
      restartMarker,
      reason: 'dashboard_refresh',
    });
  }, [gatewayStatus.connectedAt, gatewayStatus.pid, isGatewayRunning, refreshUsageHistory, usageFetchMaxAttempts]);

  useEffect(() => {
    if (dashboardHeavyContentReady) {
      return;
    }
    const cancel = scheduleIdleReady(() => {
      setDashboardHeavyContentReady(true);
    }, {
      idleTimeoutMs: DASHBOARD_HEAVY_CONTENT_IDLE_TIMEOUT_MS,
      fallbackDelayMs: 120,
      useAnimationFrame: true,
    });
    return cancel;
  }, [dashboardHeavyContentReady, setDashboardHeavyContentReady]);

  useEffect(() => {
    if (!dashboardHeavyContentReady && (channels.length > 0 || skills.length > 0)) {
      const cancel = scheduleIdleReady(() => {
        setDashboardHeavyContentReady(true);
      }, {
        idleTimeoutMs: 120,
        fallbackDelayMs: 48,
        useAnimationFrame: false,
      });
      return cancel;
    }
    return undefined;
  }, [channels.length, dashboardHeavyContentReady, setDashboardHeavyContentReady, skills.length]);

  useEffect(() => {
    if (usagePanelReady) {
      return;
    }
    const cancel = scheduleIdleReady(() => {
      setUsagePanelReady(true);
    }, {
      idleTimeoutMs: 1000,
      fallbackDelayMs: 80,
      useAnimationFrame: false,
    });
    return cancel;
  }, [setUsagePanelReady, usagePanelReady]);

  useEffect(() => {
    if (!usagePanelReady && usageHistory.length > 0) {
      const cancel = scheduleIdleReady(() => {
        setUsagePanelReady(true);
      }, {
        idleTimeoutMs: 120,
        fallbackDelayMs: 48,
        useAnimationFrame: false,
      });
      return cancel;
    }
    return undefined;
  }, [setUsagePanelReady, usageHistory.length, usagePanelReady]);

  useEffect(() => {
    if (!isGatewayRunning || !usagePanelReady || usageHistory.length === 0) {
      return;
    }
    if (usageChartReady && usageDetailListReady) {
      return;
    }
    const cancel = scheduleIdleReady(() => {
      setUsageVisualizationReady(true);
    }, {
      idleTimeoutMs: 320,
      fallbackDelayMs: 100,
      useAnimationFrame: true,
    });
    return cancel;
  }, [
    isGatewayRunning,
    setUsageVisualizationReady,
    usageChartReady,
    usageDetailListReady,
    usageHistory.length,
    usagePanelReady,
  ]);

  // Calculate statistics safely
  const connectedChannels = Array.isArray(channels) ? channels.filter((c) => c.status === 'connected').length : 0;
  const enabledSkillsList = useMemo(
    () => (Array.isArray(skills) ? skills.filter((skill) => skill.enabled) : []),
    [skills],
  );
  const enabledSkills = enabledSkillsList.length;
  const visibleUsageHistory = useMemo(
    () => usageHistory,
    [usageHistory],
  );
  const filteredUsageHistory = useMemo(
    () => filterUsageHistoryByWindow(visibleUsageHistory, usageWindow),
    [usageWindow, visibleUsageHistory],
  );
  const usageGroups = useMemo(
    () => groupUsageHistory(filteredUsageHistory, usageGroupBy),
    [filteredUsageHistory, usageGroupBy],
  );
  const usagePageSize = 5;
  const usageTotalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredUsageHistory.length / usagePageSize)),
    [filteredUsageHistory.length],
  );
  const safeUsagePage = useMemo(
    () => Math.min(usagePage, usageTotalPages),
    [usagePage, usageTotalPages],
  );
  const pagedUsageHistory = useMemo(
    () => filteredUsageHistory.slice((safeUsagePage - 1) * usagePageSize, safeUsagePage * usagePageSize),
    [filteredUsageHistory, safeUsagePage],
  );
  const usageRefreshing = isGatewayRunning && usageRefreshingState && usageHistoryReady;
  const showUsageInitialLoading = (
    (!usagePanelReady && !usageHistoryReady)
    || (isGatewayRunning && usageInitialLoading && visibleUsageHistory.length === 0)
  );
  const usageSummary = useMemo(
    () => filteredUsageHistory.reduce(
      (acc, entry) => ({
        totalTokens: acc.totalTokens + entry.totalTokens,
        inputTokens: acc.inputTokens + entry.inputTokens,
        outputTokens: acc.outputTokens + entry.outputTokens,
        cacheTokens: acc.cacheTokens + entry.cacheReadTokens + entry.cacheWriteTokens,
      }),
      { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0 },
    ),
    [filteredUsageHistory],
  );

  // Update uptime periodically
  useEffect(() => {
    const updateUptime = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (gatewayStatus.connectedAt) {
        const nextValue = Math.floor((Date.now() - gatewayStatus.connectedAt) / 1000);
        setUptime((prev) => (prev === nextValue ? prev : nextValue));
      } else {
        setUptime((prev) => (prev === 0 ? prev : 0));
      }
    };

    // Update immediately
    updateUptime();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        updateUptime();
      }
    };

    // Update every second
    const interval = setInterval(updateUptime, 1000);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [gatewayStatus.connectedAt]);

  const openDevConsole = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        error?: string;
      }>('/api/gateway/control-ui');
      if (result.success && result.url) {
        trackUiEvent('dashboard.quick_action', { action: 'dev_console' });
        window.electron.openExternal(result.url);
      } else {
        console.error('Failed to get Dev Console URL:', result.error);
      }
    } catch (err) {
      console.error('Error opening Dev Console:', err);
    }
  };

  const quickActionClassName = 'h-full min-h-[64px] w-full rounded-[calc(var(--radius-card)-8px)] px-2.5 py-2.5 whitespace-normal text-center leading-snug shadow-none hover:shadow-whisper';

  return (
    <div className="space-y-6">
      {/* Status Cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Gateway Status */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t('gateway')}</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <StatusBadge status={gatewayStatus.state} />
            </div>
            {gatewayStatus.state === 'running' && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('port', { port: gatewayStatus.port })} | {t('pid', { pid: gatewayStatus.pid || 'N/A' })}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Channels */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t('channels')}</CardTitle>
            <Radio className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{connectedChannels}</div>
            <p className="text-xs text-muted-foreground">
              {t('connectedOf', { connected: connectedChannels, total: channels.length })}
            </p>
          </CardContent>
        </Card>

        {/* Skills */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t('skills')}</CardTitle>
            <Puzzle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{enabledSkills}</div>
            <p className="text-xs text-muted-foreground">
              {t('enabledOf', { enabled: enabledSkills, total: skills.length })}
            </p>
          </CardContent>
        </Card>

        {/* Uptime */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">{t('uptime')}</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {uptime > 0 ? formatUptime(uptime) : '—'}
            </div>
            <p className="text-xs text-muted-foreground">
              {gatewayStatus.state === 'running' ? t('sinceRestart') : t('gatewayNotRunning')}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Quick Actions */}
      <Card className="w-full max-w-4xl">
        <CardHeader>
          <CardTitle>{t('quickActions.title')}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(145px,1fr))] gap-2.5">
            <Button variant="outline" className={quickActionClassName} asChild>
              <Link to="/settings" onClick={() => trackUiEvent('dashboard.quick_action', { action: 'add_provider' })}>
                <Wrench className="h-4 w-4" />
                <span>{t('quickActions.addProvider')}</span>
              </Link>
            </Button>
            <Button variant="outline" className={quickActionClassName} asChild>
              <Link to="/channels" onClick={() => trackUiEvent('dashboard.quick_action', { action: 'add_channel' })}>
                <Plus className="h-4 w-4" />
                <span>{t('quickActions.addChannel')}</span>
              </Link>
            </Button>
            <Button variant="outline" className={quickActionClassName} asChild>
              <Link to="/tasks?tab=scheduled" onClick={() => trackUiEvent('dashboard.quick_action', { action: 'create_cron' })}>
                <Clock className="h-4 w-4" />
                <span>{t('quickActions.createCron')}</span>
              </Link>
            </Button>
            <Button variant="outline" className={quickActionClassName} asChild>
              <Link to="/skills" onClick={() => trackUiEvent('dashboard.quick_action', { action: 'install_skill' })}>
                <Puzzle className="h-4 w-4" />
                <span>{t('quickActions.installSkill')}</span>
              </Link>
            </Button>
            <Button variant="outline" className={quickActionClassName} asChild>
              <Link to="/" onClick={() => trackUiEvent('dashboard.quick_action', { action: 'open_chat' })}>
                <MessageSquare className="h-4 w-4" />
                <span>{t('quickActions.openChat')}</span>
              </Link>
            </Button>
            <Button variant="outline" className={quickActionClassName} asChild>
              <Link to="/settings" onClick={() => trackUiEvent('dashboard.quick_action', { action: 'open_settings' })}>
                <Settings className="h-4 w-4" />
                <span>{t('quickActions.settings')}</span>
              </Link>
            </Button>
            {devModeUnlocked && (
              <Button
                variant="outline"
                className={quickActionClassName}
                onClick={openDevConsole}
              >
                <Terminal className="h-4 w-4" />
                <span>{t('quickActions.devConsole')}</span>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {!dashboardHeavyContentReady ? (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <Card key={`dashboard-activity-placeholder-${index}`}>
                <CardHeader>
                  <div className="h-5 w-32 animate-pulse rounded bg-muted" />
                </CardHeader>
                <CardContent className="space-y-3">
                  {Array.from({ length: 3 }).map((__, rowIndex) => (
                    <div key={`dashboard-activity-row-${index}-${rowIndex}`} className="rounded-lg border p-3">
                      <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
                      <div className="mt-2 h-3 w-2/5 animate-pulse rounded bg-muted" />
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('recentTokenHistory.title')}</CardTitle>
              <CardDescription>{t('recentTokenHistory.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="h-4 w-48 animate-pulse rounded bg-muted" />
                <div className="h-20 w-full animate-pulse rounded bg-muted" />
                <div className="h-20 w-full animate-pulse rounded bg-muted" />
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          {/* Recent Activity */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Connected Channels */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('connectedChannels')}</CardTitle>
          </CardHeader>
          <CardContent>
            {channels.length === 0 ? (
              <FeedbackState
                state="empty"
                title={t('noChannels')}
                action={(
                  <Button variant="link" asChild className="mt-2">
                    <Link to="/channels">{t('addFirst')}</Link>
                  </Button>
                )}
              />
            ) : (
              <div className="space-y-3">
                {channels.slice(0, 5).map((channel) => (
                  <div
                    key={channel.id}
                    className="flex items-center justify-between rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-lg">
                        {channel.type === 'whatsapp' && '📱'}
                        {channel.type === 'telegram' && '✈️'}
                        {channel.type === 'discord' && '🎮'}
                      </span>
                      <div>
                        <p className="font-medium">{channel.name}</p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {channel.type}
                        </p>
                      </div>
                    </div>
                    <StatusBadge status={channel.status} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Enabled Skills */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('activeSkills')}</CardTitle>
          </CardHeader>
          <CardContent>
            {enabledSkillsList.length === 0 ? (
              <FeedbackState
                state="empty"
                title={t('noSkills')}
                action={(
                  <Button variant="link" asChild className="mt-2">
                    <Link to="/skills">{t('enableSome')}</Link>
                  </Button>
                )}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {enabledSkillsList
                  .slice(0, 12)
                  .map((skill) => (
                    <Badge key={skill.id} variant="secondary">
                      {skill.icon && <span className="mr-1">{skill.icon}</span>}
                      {skill.name}
                    </Badge>
                  ))}
                {enabledSkillsList.length > 12 && (
                  <Badge variant="outline">
                    {t('more', { count: enabledSkillsList.length - 12 })}
                  </Badge>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-lg">{t('recentTokenHistory.title')}</CardTitle>
            <CardDescription>{t('recentTokenHistory.description')}</CardDescription>
          </div>
          {usageRefreshing && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('recentTokenHistory.loading')}
            </span>
          )}
        </CardHeader>
        <CardContent>
          {showUsageInitialLoading ? (
            <FeedbackState state="loading" title={t('recentTokenHistory.loading')} />
          ) : visibleUsageHistory.length === 0 ? (
            usageFetchError ? (
              <FeedbackState
                state="error"
                title={t('recentTokenHistory.refreshFailed')}
                description={usageFetchError}
              />
            ) : (
              <FeedbackState state="empty" title={t('recentTokenHistory.empty')} />
            )
          ) : filteredUsageHistory.length === 0 ? (
            <FeedbackState state="empty" title={t('recentTokenHistory.emptyForWindow')} />
          ) : (
            <div className="space-y-5">
              {usageFetchError && (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                  {t('recentTokenHistory.refreshFailed')}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex rounded-lg border p-1">
                    <Button
                      variant={usageGroupBy === 'model' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        setUsageGroupBy('model');
                      }}
                    >
                      {t('recentTokenHistory.groupByModel')}
                    </Button>
                    <Button
                      variant={usageGroupBy === 'day' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        setUsageGroupBy('day');
                      }}
                    >
                      {t('recentTokenHistory.groupByTime')}
                    </Button>
                  </div>
                  <div className="flex rounded-lg border p-1">
                    <Button
                      variant={usageWindow === '7d' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        setUsageWindow('7d');
                      }}
                    >
                      {t('recentTokenHistory.last7Days')}
                    </Button>
                    <Button
                      variant={usageWindow === '30d' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        setUsageWindow('30d');
                      }}
                    >
                      {t('recentTokenHistory.last30Days')}
                    </Button>
                    <Button
                      variant={usageWindow === 'all' ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => {
                        setUsageWindow('all');
                      }}
                    >
                      {t('recentTokenHistory.allTime')}
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('recentTokenHistory.showingLast', { count: filteredUsageHistory.length })}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">{t('recentTokenHistory.totalTokens')}</p>
                  <p className="mt-1 text-sm font-semibold">{formatTokenCount(usageSummary.totalTokens)}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">{t('recentTokenHistory.inputShort')}</p>
                  <p className="mt-1 text-sm font-semibold">{formatTokenCount(usageSummary.inputTokens)}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">{t('recentTokenHistory.outputShort')}</p>
                  <p className="mt-1 text-sm font-semibold">{formatTokenCount(usageSummary.outputTokens)}</p>
                </div>
                <div className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">{t('recentTokenHistory.cacheShort')}</p>
                  <p className="mt-1 text-sm font-semibold">{formatTokenCount(usageSummary.cacheTokens)}</p>
                </div>
              </div>

              {!usageChartReady ? (
                <div className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-center gap-4">
                    <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-20 animate-pulse rounded bg-muted" />
                  </div>
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={`usage-chart-placeholder-${index}`} className="space-y-2">
                      <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                      <div className="h-3 w-full animate-pulse rounded bg-muted" />
                    </div>
                  ))}
                </div>
              ) : (
                <UsageBarChart
                  groups={usageGroups}
                  emptyLabel={t('recentTokenHistory.empty')}
                  totalLabel={t('recentTokenHistory.totalTokens')}
                  inputLabel={t('recentTokenHistory.inputShort')}
                  outputLabel={t('recentTokenHistory.outputShort')}
                  cacheLabel={t('recentTokenHistory.cacheShort')}
                />
              )}

              {!usageDetailListReady ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <div key={`usage-detail-placeholder-${index}`} className="rounded-lg border p-3">
                      <div className="h-4 w-2/5 animate-pulse rounded bg-muted" />
                      <div className="mt-2 h-3 w-3/4 animate-pulse rounded bg-muted" />
                      <div className="mt-3 h-3 w-full animate-pulse rounded bg-muted" />
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <div className="space-y-3">
                    {pagedUsageHistory.map((entry) => (
                      <div
                        key={`${entry.sessionId}-${entry.timestamp}`}
                        className="rounded-lg border p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium truncate">
                              {entry.model || t('recentTokenHistory.unknownModel')}
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {[entry.provider, entry.agentId, entry.sessionId].filter(Boolean).join(' • ')}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-semibold">{formatTokenCount(entry.totalTokens)}</p>
                            <p className="text-xs text-muted-foreground">
                              {formatUsageTimestamp(entry.timestamp)}
                            </p>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span>{t('recentTokenHistory.input', { value: formatTokenCount(entry.inputTokens) })}</span>
                          <span>{t('recentTokenHistory.output', { value: formatTokenCount(entry.outputTokens) })}</span>
                          {entry.cacheReadTokens > 0 && (
                            <span>{t('recentTokenHistory.cacheRead', { value: formatTokenCount(entry.cacheReadTokens) })}</span>
                          )}
                          {entry.cacheWriteTokens > 0 && (
                            <span>{t('recentTokenHistory.cacheWrite', { value: formatTokenCount(entry.cacheWriteTokens) })}</span>
                          )}
                          {typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) && (
                            <span>{t('recentTokenHistory.cost', { amount: entry.costUsd.toFixed(4) })}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between gap-3 border-t pt-3">
                    <p className="text-xs text-muted-foreground">
                      {t('recentTokenHistory.page', { current: safeUsagePage, total: usageTotalPages })}
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setUsagePage((page) => Math.max(1, page - 1))}
                        disabled={safeUsagePage <= 1}
                      >
                        <ChevronLeft className="h-4 w-4 mr-1" />
                        {t('recentTokenHistory.prev')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setUsagePage((page) => Math.min(usageTotalPages, page + 1))}
                        disabled={safeUsagePage >= usageTotalPages}
                      >
                        {t('recentTokenHistory.next')}
                        <ChevronRight className="h-4 w-4 ml-1" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}

function formatTokenCount(value: number): string {
  return Intl.NumberFormat().format(value);
}

function formatUsageTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function UsageBarChart({
  groups,
  emptyLabel,
  totalLabel,
  inputLabel,
  outputLabel,
  cacheLabel,
}: {
  groups: Array<{
    label: string;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
  }>;
  emptyLabel: string;
  totalLabel: string;
  inputLabel: string;
  outputLabel: string;
  cacheLabel: string;
}) {
  if (groups.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  const maxTokens = Math.max(...groups.map((group) => group.totalTokens), 1);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-sky-500" />
          {inputLabel}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-violet-500" />
          {outputLabel}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
          {cacheLabel}
        </span>
      </div>
      {groups.map((group) => (
        <div key={group.label} className="space-y-1">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium">{group.label}</span>
            <span className="text-muted-foreground">
              {totalLabel}: {formatTokenCount(group.totalTokens)}
            </span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-muted">
            <div
              className="flex h-full overflow-hidden rounded-full"
              style={{ width: `${Math.max((group.totalTokens / maxTokens) * 100, 6)}%` }}
            >
              {group.inputTokens > 0 && (
                <div
                  className="h-full bg-sky-500"
                  style={{ width: `${(group.inputTokens / group.totalTokens) * 100}%` }}
                />
              )}
              {group.outputTokens > 0 && (
                <div
                  className="h-full bg-violet-500"
                  style={{ width: `${(group.outputTokens / group.totalTokens) * 100}%` }}
                />
              )}
              {group.cacheTokens > 0 && (
                <div
                  className="h-full bg-amber-500"
                  style={{ width: `${(group.cacheTokens / group.totalTokens) * 100}%` }}
                />
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default Dashboard;
