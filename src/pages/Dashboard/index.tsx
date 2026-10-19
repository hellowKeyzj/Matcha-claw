/**
 * Dashboard Page
 * Main overview page showing system status and usage insights
 */
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RuntimeScopeSelector } from '@/components/common/RuntimeScopeSelector';
import {
  isRuntimeEndpointReady,
  selectManagementRuntime,
  supportsRuntimeEndpointCapabilityFamily,
  useRuntimeEndpointsStore,
} from '@/stores/runtime-endpoints';
import { runtimeEndpointsEqual } from '@/types/desktop/runtime-address';
import { useDashboardUsageStore } from '@/stores/dashboard-usage';
import { useDashboardUiStore } from '@/stores/dashboard-ui';
import { FeedbackState } from '@/components/common/FeedbackState';
import { LoadingState } from '@/components/common/LoadingSpinner';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { useIdleReady } from '@/lib/idle-ready';
import { trackUiEvent } from '@/lib/telemetry';
import { useTranslation } from 'react-i18next';
import {
  filterUsageHistoryByWindow,
  groupUsageHistory,
} from './usage-history';
import type { UsageSessionDetailEntry } from './usage-history';
const DEFAULT_USAGE_FETCH_MAX_ATTEMPTS = 2;
const WINDOWS_USAGE_FETCH_MAX_ATTEMPTS = 3;

type UsageSessionDetailViewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded'; entries: UsageSessionDetailEntry[] }
  | { status: 'error'; message: string };

export function Dashboard() {
  const { t } = useTranslation('dashboard');
  const runtime = useRuntimeEndpointsStore(selectManagementRuntime);
  const endpoint = runtime?.endpointRef ?? null;
  const supportsUsage = Boolean(runtime && supportsRuntimeEndpointCapabilityFamily(runtime, 'usage'));
  const isUsageRuntimeReady = Boolean(runtime && isRuntimeEndpointReady(runtime) && supportsUsage);
  const runtimeTransportEpoch = runtime?.controlState.connection?.transportEpoch;
  const storeEndpoint = useDashboardUsageStore((state) => state.endpoint);
  const scopeReady = Boolean(endpoint && storeEndpoint && runtimeEndpointsEqual(endpoint, storeEndpoint));
  const setEndpoint = useDashboardUsageStore((state) => state.setEndpoint);
  const usageFetchMaxAttempts = window.electron?.platform === 'win32'
    ? WINDOWS_USAGE_FETCH_MAX_ATTEMPTS
    : DEFAULT_USAGE_FETCH_MAX_ATTEMPTS;
  const usageHistory = useDashboardUsageStore((state) => state.usageHistory);
  const usageHistoryReady = useDashboardUsageStore((state) => state.usageHistoryReady);
  const usageContentReady = useIdleReady(scopeReady && usageHistoryReady);
  const usageRefreshingState = useDashboardUsageStore((state) => state.refreshing);
  const usageSessionDetails = useDashboardUsageStore((state) => state.sessionDetails);
  const usageFetchError = useDashboardUsageStore((state) => state.error);
  const loadSessionDetails = useDashboardUsageStore((state) => state.loadSessionDetails);
  const refreshUsageHistory = useDashboardUsageStore((state) => state.refreshUsageHistory);
  const usageGroupBy = useDashboardUiStore((state) => state.usageGroupBy);
  const usageWindow = useDashboardUiStore((state) => state.usageWindow);
  const usagePage = useDashboardUiStore((state) => state.usagePage);
  const setUsageGroupBy = useDashboardUiStore((state) => state.setUsageGroupBy);
  const setUsageWindow = useDashboardUiStore((state) => state.setUsageWindow);
  const setUsagePage = useDashboardUiStore((state) => state.setUsagePage);
  const [expandedUsageSessionId, setExpandedUsageSessionId] = useState<string | null>(null);

  // Track page view on mount only.
  useEffect(() => {
    trackUiEvent('dashboard.page_viewed');
  }, []);

  useLayoutEffect(() => {
    if (scopeReady || (!endpoint && !storeEndpoint)) return;
    setEndpoint(endpoint);
    setExpandedUsageSessionId(null);
    setUsagePage(1);
  }, [endpoint, scopeReady, setEndpoint, setUsagePage, storeEndpoint]);

  // Retry history reads when the selected runtime becomes ready or reconnects.
  useEffect(() => {
    if (!scopeReady || !isUsageRuntimeReady) {
      return;
    }

    void refreshUsageHistory({
      maxAttempts: usageFetchMaxAttempts,
      restartMarker: String(runtimeTransportEpoch ?? 'na'),
      reason: 'dashboard_refresh',
      silent: true,
    });
  }, [endpoint, isUsageRuntimeReady, refreshUsageHistory, runtimeTransportEpoch, scopeReady, usageFetchMaxAttempts]);

  // Calculate statistics safely
  const visibleUsageHistory = useMemo(
    () => scopeReady ? usageHistory : [],
    [scopeReady, usageHistory],
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
  const usageRefreshing = isUsageRuntimeReady && usageRefreshingState && usageHistoryReady;
  const showUsageRefreshingHint = useDelayedFlag(usageRefreshing, 180);
  const showUsageInitialLoading = !scopeReady || (!usageHistoryReady && !usageFetchError)
    || (usageHistoryReady && !usageContentReady);
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
  const toggleUsageSessionDetails = (sessionId: string, agentId: string) => {
    const expanding = expandedUsageSessionId !== sessionId;
    setExpandedUsageSessionId(expanding ? sessionId : null);
    if (expanding) {
      void loadSessionDetails(sessionId, agentId);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <div className="flex min-h-11 items-center justify-between gap-4">
          <h1 className="text-lg font-semibold">{t('recentTokenHistory.title')}</h1>
          <RuntimeScopeSelector />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t('recentTokenHistory.description')}</p>
          {showUsageRefreshingHint && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('recentTokenHistory.loading')}
            </span>
          )}
        </div>
      </header>

      {!endpoint ? (
        <FeedbackState state="empty" title={t('common:runtimeScope.selectRuntime')} />
      ) : !runtime ? (
        <FeedbackState state="error" title={t('common:calls.values.runtimeUnavailable')} />
      ) : !supportsUsage ? (
        <FeedbackState state="error" title={t('common:calls.values.unsupported')} />
      ) : !isUsageRuntimeReady ? (
        <FeedbackState state="error" title={t('common:calls.values.notReady')} />
      ) : showUsageInitialLoading ? (
        <LoadingState label={t('recentTokenHistory.loading')} />
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
        <div className="space-y-6">
          {usageFetchError && (
            <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
              {t('recentTokenHistory.refreshFailed')}
            </p>
          )}
          <section className="flex flex-wrap items-center justify-between gap-3">
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
          </section>

          <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className="rounded-lg border bg-[hsl(var(--shell-surface))] p-3 [border-color:hsl(var(--shell-border))]">
              <p className="text-xs text-[hsl(var(--shell-text-muted))]">{t('recentTokenHistory.totalTokens')}</p>
              <p className="mt-1 text-sm font-semibold">{formatTokenCount(usageSummary.totalTokens)}</p>
            </div>
            <div className="rounded-lg border bg-[hsl(var(--shell-surface))] p-3 [border-color:hsl(var(--shell-border))]">
              <p className="text-xs text-[hsl(var(--shell-text-muted))]">{t('recentTokenHistory.inputShort')}</p>
              <p className="mt-1 text-sm font-semibold">{formatTokenCount(usageSummary.inputTokens)}</p>
            </div>
            <div className="rounded-lg border bg-[hsl(var(--shell-surface))] p-3 [border-color:hsl(var(--shell-border))]">
              <p className="text-xs text-[hsl(var(--shell-text-muted))]">{t('recentTokenHistory.outputShort')}</p>
              <p className="mt-1 text-sm font-semibold">{formatTokenCount(usageSummary.outputTokens)}</p>
            </div>
            <div className="rounded-lg border bg-[hsl(var(--shell-surface))] p-3 [border-color:hsl(var(--shell-border))]">
              <p className="text-xs text-[hsl(var(--shell-text-muted))]">{t('recentTokenHistory.cacheShort')}</p>
              <p className="mt-1 text-sm font-semibold">{formatTokenCount(usageSummary.cacheTokens)}</p>
            </div>
          </section>

          <section>
            <UsageBarChart
              groups={usageGroups}
              emptyLabel={t('recentTokenHistory.empty')}
              totalLabel={t('recentTokenHistory.totalTokens')}
              inputLabel={t('recentTokenHistory.inputShort')}
              outputLabel={t('recentTokenHistory.outputShort')}
              cacheLabel={t('recentTokenHistory.cacheShort')}
            />
          </section>

          <section className="space-y-3">
                <div className="space-y-3">
                  {pagedUsageHistory.map((entry, index) => {
                    const detail = usageSessionDetails[entry.sessionId] ?? { status: 'idle' as const };
                    const expanded = expandedUsageSessionId === entry.sessionId;
                    return (
                      <div
                        key={`${entry.sessionId}-${entry.timestamp}-${index}`}
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
                          <div className="flex shrink-0 items-start gap-2 text-right">
                            <div>
                              <p className="font-semibold">{formatTokenCount(entry.totalTokens)}</p>
                              <p className="text-xs text-[hsl(var(--shell-text-muted))]">
                                {formatUsageTimestamp(entry.timestamp)}
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2"
                              onClick={() => toggleUsageSessionDetails(entry.sessionId, entry.agentId)}
                            >
                              {expanded ? (
                                <ChevronUp className="h-4 w-4" />
                              ) : (
                                <ChevronDown className="h-4 w-4" />
                              )}
                              <span className="sr-only">
                                {expanded ? t('recentTokenHistory.hideDetails') : t('recentTokenHistory.showDetails')}
                              </span>
                            </Button>
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
                        {expanded && (
                          <UsageSessionDetails
                            detail={detail}
                            loadingLabel={t('recentTokenHistory.detailsLoading')}
                            emptyLabel={t('recentTokenHistory.detailsEmpty')}
                            errorLabel={t('recentTokenHistory.detailsError')}
                            inputLabel={t('recentTokenHistory.inputShort')}
                            outputLabel={t('recentTokenHistory.outputShort')}
                            cacheLabel={t('recentTokenHistory.cacheShort')}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="flex items-center justify-between gap-3 border-t pt-3">
                  <p className="text-xs text-[hsl(var(--shell-text-muted))]">
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
          </section>
        </div>
      )}
    </div>
  );
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

function UsageSessionDetails({
  detail,
  loadingLabel,
  emptyLabel,
  errorLabel,
  inputLabel,
  outputLabel,
  cacheLabel,
}: {
  detail: UsageSessionDetailViewState;
  loadingLabel: string;
  emptyLabel: string;
  errorLabel: string;
  inputLabel: string;
  outputLabel: string;
  cacheLabel: string;
}) {
  if (detail.status === 'idle' || detail.status === 'loading') {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-md border bg-[hsl(var(--shell-surface))] px-3 py-2 text-xs text-[hsl(var(--shell-text-muted))] [border-color:hsl(var(--shell-border))]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {loadingLabel}
      </div>
    );
  }

  if (detail.status === 'error') {
    return (
      <div className="mt-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {errorLabel}: {detail.message}
      </div>
    );
  }

  if (detail.entries.length === 0) {
    return (
      <div className="mt-3 rounded-md border bg-[hsl(var(--shell-surface))] px-3 py-2 text-xs text-[hsl(var(--shell-text-muted))] [border-color:hsl(var(--shell-border))]">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      {detail.entries.map((entry, index) => (
        <div
          key={entry.messageId || entry.eventId || `${entry.sessionId}-${entry.timestamp}-${index}`}
          className="rounded-md border border-border/80 bg-card px-3 py-2"
        >
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-muted-foreground">{formatUsageTimestamp(entry.timestamp)}</span>
            <span className="font-medium">{formatTokenCount(entry.totalTokens)}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{inputLabel}: {formatTokenCount(entry.inputTokens)}</span>
            <span>{outputLabel}: {formatTokenCount(entry.outputTokens)}</span>
            {(entry.cacheReadTokens > 0 || entry.cacheWriteTokens > 0) && (
              <span>{cacheLabel}: {formatTokenCount(entry.cacheReadTokens + entry.cacheWriteTokens)}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
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
