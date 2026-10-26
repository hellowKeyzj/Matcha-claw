import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, RefreshCw, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { SettingsSectionProps } from '@/app/extensions';
import { StableScrollArea } from '@/components/scroll';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { hostApiFetch, hostOpenClawGetCliCommand } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import { clearUiTelemetry, getUiTelemetrySnapshot, subscribeUiTelemetry, trackUiEvent, type UiTelemetryEntry } from '@/lib/telemetry';
import { useLocalLicenseLocked } from '@/plugins/account/stores/license';
import { useSettingsStore } from './store';

type ControlUiInfo = {
  url: string;
  token?: string;
  port: number;
};

const TELEMETRY_WINDOW_MINUTES_OPTIONS = [0, 5, 15, 60] as const;
const HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN = 5;
const HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN_MAX = 999;
const HISTORY_STRATEGY_SORT_KEYS = ['count', 'avgMs', 'p95Ms', 'p99Ms'] as const;

type HistoryStrategySortKey = (typeof HISTORY_STRATEGY_SORT_KEYS)[number];
type HistoryStrategySortDirection = 'asc' | 'desc';

const HISTORY_STRATEGY_SORT_LABEL_KEY: Record<HistoryStrategySortKey, string> = {
  count: 'developer.telemetrySortCount',
  avgMs: 'developer.telemetrySortAvg',
  p95Ms: 'developer.telemetrySortP95',
  p99Ms: 'developer.telemetrySortP99',
};

function computePercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
  );
  const value = sorted[position];
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function filterTelemetryEntries(
  telemetryEntries: UiTelemetryEntry[],
  telemetryHistoryOnly: boolean,
  telemetryWindowMinutes: number,
): UiTelemetryEntry[] {
  let entries = telemetryEntries;
  if (telemetryWindowMinutes > 0) {
    const cutoff = Date.now() - (telemetryWindowMinutes * 60 * 1000);
    entries = entries.filter((entry) => {
      const ts = Date.parse(entry.ts);
      return Number.isFinite(ts) && ts >= cutoff;
    });
  }
  if (telemetryHistoryOnly) {
    entries = entries.filter((entry) => entry.event.startsWith('chat.history_'));
  }
  return entries;
}

export default function AdvancedSection({ active }: SettingsSectionProps) {
  const { t } = useTranslation(['settings', 'common']);
  const licenseLocked = useLocalLicenseLocked();
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const setDevModeUnlocked = useSettingsStore((state) => state.setDevModeUnlocked);
  const [controlUiInfo, setControlUiInfo] = useState<ControlUiInfo | null>(null);
  const [openclawCliCommand, setOpenclawCliCommand] = useState('');
  const [openclawCliError, setOpenclawCliError] = useState<string | null>(null);
  const [showTelemetryViewer, setShowTelemetryViewer] = useState(false);
  const [telemetryEntries, setTelemetryEntries] = useState<UiTelemetryEntry[]>([]);
  const [telemetryWindowMinutes, setTelemetryWindowMinutes] = useState<number>(15);
  const [telemetryHistoryOnly, setTelemetryHistoryOnly] = useState(false);
  const [historyStrategySampleMinDraft, setHistoryStrategySampleMinDraft] = useState(
    String(HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN),
  );
  const [historyStrategySortKey, setHistoryStrategySortKey] = useState<HistoryStrategySortKey>('count');
  const [historyStrategySortDirection, setHistoryStrategySortDirection] = useState<HistoryStrategySortDirection>('desc');

  const isWindows = window.electron.platform === 'win32';
  const showCliTools = true;

  // Open developer console
  const openDevConsole = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        port?: number;
        error?: string;
      }>('/api/gateway/control-ui');
      if (result.success && result.url && typeof result.port === 'number') {
        setControlUiInfo({ url: result.url, port: result.port });
        trackUiEvent('settings.open_dev_console');
        window.electron.openExternal(result.url);
      } else {
        console.error('Failed to get Dev Console URL:', result.error);
      }
    } catch (err) {
      console.error('Error opening Dev Console:', err);
    }
  };

  const refreshControlUiInfo = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        port?: number;
      }>('/api/gateway/control-ui');
      if (result.success && result.url && typeof result.port === 'number') {
        setControlUiInfo({ url: result.url, port: result.port });
      }
    } catch {
      // Ignore refresh errors
    }
  };

  const handleCopyGatewayToken = async () => {
    if (!controlUiInfo?.token) return;
    try {
      await navigator.clipboard.writeText(controlUiInfo.token);
      toast.success(t('developer.tokenCopied'));
    } catch (error) {
      toast.error(`Failed to copy token: ${String(error)}`);
    }
  };

  useEffect(() => {
    if (licenseLocked || !showCliTools) return;
    let cancelled = false;

    (async () => {
      try {
        const result = await hostOpenClawGetCliCommand();
        if (cancelled) return;
        if (result.success && result.command) {
          setOpenclawCliCommand(result.command);
          setOpenclawCliError(null);
        } else {
          setOpenclawCliCommand('');
          setOpenclawCliError(result.error || 'OpenClaw CLI unavailable');
        }
      } catch (error) {
        if (cancelled) return;
        setOpenclawCliCommand('');
        setOpenclawCliError(String(error));
      }
    })();

    return () => { cancelled = true; };
  }, [devModeUnlocked, licenseLocked, showCliTools]);

  const handleCopyCliCommand = async () => {
    if (!openclawCliCommand) return;
    try {
      await navigator.clipboard.writeText(openclawCliCommand);
      toast.success(t('developer.cmdCopied'));
    } catch (error) {
      toast.error(`Failed to copy command: ${String(error)}`);
    }
  };

  useEffect(() => {
    const unsubscribe = subscribeHostEvent<{ path?: string }>(
      'openclaw:cli-installed',
      (payload) => {
        const installedPath = typeof payload?.path === 'string' ? payload.path : '';
        toast.success(`openclaw CLI installed at ${installedPath}`);
      },
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!devModeUnlocked) return;
    setTelemetryEntries(getUiTelemetrySnapshot(200));
    const unsubscribe = subscribeUiTelemetry((entry) => {
      setTelemetryEntries((prev) => {
        const next = [...prev, entry];
        if (next.length > 200) {
          next.splice(0, next.length - 200);
        }
        return next;
      });
    });
    return unsubscribe;
  }, [devModeUnlocked]);

  const historyStrategySampleMin = useMemo(() => {
    const parsed = Number.parseInt(historyStrategySampleMinDraft, 10);
    if (!Number.isFinite(parsed) || parsed < HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN) {
      return HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN;
    }
    return Math.min(HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN_MAX, parsed);
  }, [historyStrategySampleMinDraft]);

  const filteredTelemetryEntries = useMemo(
    () => filterTelemetryEntries(telemetryEntries, telemetryHistoryOnly, telemetryWindowMinutes),
    [telemetryEntries, telemetryHistoryOnly, telemetryWindowMinutes],
  );

  const telemetryStats = useMemo(() => {
    let errorCount = 0;
    let slowCount = 0;
    for (const entry of filteredTelemetryEntries) {
      if (entry.event.endsWith('_error') || entry.event.includes('request_error')) {
        errorCount += 1;
      }
      const durationMs = typeof entry.payload.durationMs === 'number'
        ? entry.payload.durationMs
        : Number.NaN;
      if (Number.isFinite(durationMs) && durationMs >= 800) {
        slowCount += 1;
      }
    }
    return { total: filteredTelemetryEntries.length, errorCount, slowCount };
  }, [filteredTelemetryEntries]);

  const telemetryByEvent = useMemo(() => {
    const map = new Map<string, {
      event: string;
      count: number;
      errorCount: number;
      slowCount: number;
      totalDuration: number;
      timedCount: number;
      lastTs: string;
    }>();

    for (const entry of filteredTelemetryEntries) {
      const current = map.get(entry.event) ?? {
        event: entry.event,
        count: 0,
        errorCount: 0,
        slowCount: 0,
        totalDuration: 0,
        timedCount: 0,
        lastTs: entry.ts,
      };

      current.count += 1;
      current.lastTs = entry.ts;

      if (entry.event.endsWith('_error') || entry.event.includes('request_error')) {
        current.errorCount += 1;
      }

      const durationMs = typeof entry.payload.durationMs === 'number'
        ? entry.payload.durationMs
        : Number.NaN;
      if (Number.isFinite(durationMs)) {
        current.totalDuration += durationMs;
        current.timedCount += 1;
        if (durationMs >= 800) {
          current.slowCount += 1;
        }
      }

      map.set(entry.event, current);
    }

    return [...map.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
  }, [filteredTelemetryEntries]);

  const historyStrategyMetrics = useMemo(() => {
    const byStrategy = new Map<string, {
      strategy: string;
      mode: 'active' | 'quiet' | 'unknown';
      count: number;
      durations: number[];
      successCount: number;
      recoveredCount: number;
      failedCount: number;
    }>();

    for (const entry of filteredTelemetryEntries) {
      if (entry.event !== 'chat.history_load_total') {
        continue;
      }
      const rawStrategy = typeof entry.payload.strategy === 'string'
        ? entry.payload.strategy.trim()
        : '';
      const strategy = rawStrategy || 'default';
      const rawOutcome = typeof entry.payload.outcome === 'string'
        ? entry.payload.outcome.trim()
        : '';
      const outcome = rawOutcome || 'success';
      const mode = typeof entry.payload.quiet === 'boolean'
        ? (entry.payload.quiet ? 'quiet' : 'active')
        : 'unknown';
      const durationMs = typeof entry.payload.durationMs === 'number'
        ? entry.payload.durationMs
        : Number.NaN;

      const strategyKey = `${strategy}:${mode}`;
      const current = byStrategy.get(strategyKey) ?? {
        strategy,
        mode,
        count: 0,
        durations: [],
        successCount: 0,
        recoveredCount: 0,
        failedCount: 0,
      };
      current.count += 1;
      if (outcome === 'recovered') {
        current.recoveredCount += 1;
      } else if (outcome === 'failed' || outcome === 'aborted') {
        current.failedCount += 1;
      } else {
        current.successCount += 1;
      }
      if (Number.isFinite(durationMs) && durationMs >= 0) {
        current.durations.push(durationMs);
      }
      byStrategy.set(strategyKey, current);
    }

    return [...byStrategy.values()]
      .map((item) => {
        const totalDuration = item.durations.reduce((sum, value) => sum + value, 0);
        return {
          ...item,
          avgMs: item.durations.length > 0 ? Math.round(totalDuration / item.durations.length) : 0,
          p50Ms: computePercentile(item.durations, 50),
          p95Ms: computePercentile(item.durations, 95),
          p99Ms: computePercentile(item.durations, 99),
          lowSample: item.count < historyStrategySampleMin,
        };
      })
      .sort((a, b) => {
        const direction = historyStrategySortDirection === 'asc' ? 1 : -1;
        const metricDiff = (a[historyStrategySortKey] - b[historyStrategySortKey]) * direction;
        if (metricDiff !== 0) {
          return metricDiff;
        }
        const countDiff = (a.count - b.count) * direction;
        if (countDiff !== 0) {
          return countDiff;
        }
        return a.strategy.localeCompare(b.strategy);
      });
  }, [
    filteredTelemetryEntries,
    historyStrategySampleMin,
    historyStrategySortDirection,
    historyStrategySortKey,
  ]);

  const handleCopyTelemetry = async () => {
    try {
      const serialized = filteredTelemetryEntries.map((entry) => JSON.stringify(entry)).join('\n');
      await navigator.clipboard.writeText(serialized);
      toast.success(t('developer.telemetryCopied'));
    } catch (error) {
      toast.error(`${t('common:status.error')}: ${String(error)}`);
    }
  };

  const handleClearTelemetry = () => {
    clearUiTelemetry();
    setTelemetryEntries([]);
    toast.success(t('developer.telemetryCleared'));
  };

  const handleHistoryStrategySampleMinBlur = useCallback(() => {
    setHistoryStrategySampleMinDraft(String(historyStrategySampleMin));
  }, [historyStrategySampleMin]);

  if (!active) return null;
  return (
    <>
      <Card className="order-2">
        <CardHeader>
          <CardTitle>{t('advanced.title')}</CardTitle>
          <CardDescription>{t('advanced.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('advanced.devMode')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('advanced.devModeDesc')}
              </p>
            </div>
            <Switch
              checked={devModeUnlocked}
              onCheckedChange={(value) => { void setDevModeUnlocked(value).catch(() => {}); }}
            />
          </div>
        </CardContent>
      </Card>
      {devModeUnlocked && (
        <Card className="order-2">
          <CardHeader>
            <CardTitle>{t('developer.title')}</CardTitle>
            <CardDescription>{t('developer.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t('developer.console')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('developer.consoleDesc')}
              </p>
              <Button variant="outline" onClick={openDevConsole}>
                <Terminal className="h-4 w-4 mr-2" />
                {t('developer.openConsole')}
                <ExternalLink className="h-3 w-3 ml-2" />
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('developer.consoleNote')}
              </p>
              <div className="space-y-2 pt-2">
                <Label>{t('developer.gatewayToken')}</Label>
                <p className="text-sm text-muted-foreground">
                  {t('developer.gatewayTokenDesc')}
                </p>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={controlUiInfo?.token || ''}
                    placeholder={t('developer.tokenUnavailable')}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={refreshControlUiInfo}
                    disabled={!devModeUnlocked}
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    {t('common:actions.load')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCopyGatewayToken}
                    disabled={!controlUiInfo?.token}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    {t('common:actions.copy')}
                  </Button>
                </div>
              </div>
            </div>
            {showCliTools && (
              <>
                <Separator />
                <div className="space-y-2">
                  <Label>{t('developer.cli')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('developer.cliDesc')}
                  </p>
                  {isWindows && (
                    <p className="text-xs text-muted-foreground">
                      {t('developer.cliPowershell')}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={openclawCliCommand}
                      placeholder={openclawCliError || t('developer.cmdUnavailable')}
                      className="font-mono"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCopyCliCommand}
                      disabled={!openclawCliCommand}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      {t('common:actions.copy')}
                    </Button>
                  </div>
                </div>
              </>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <Label>{t('developer.telemetryViewer')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('developer.telemetryViewerDesc')}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowTelemetryViewer((prev) => !prev)}
                >
                  {showTelemetryViewer
                    ? t('common:actions.hide')
                    : t('common:actions.show')}
                </Button>
              </div>

              {showTelemetryViewer && (
                <div className="space-y-3 rounded-lg border border-border/60 p-3">
                  <div className="grid gap-3 rounded-md border border-border/60 p-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="space-y-2">
                      <Label>{t('developer.telemetryWindow')}</Label>
                      <div className="flex flex-wrap gap-2">
                        {TELEMETRY_WINDOW_MINUTES_OPTIONS.map((minutes) => {
                          const active = telemetryWindowMinutes === minutes;
                          return (
                            <Button
                              key={minutes}
                              type="button"
                              size="sm"
                              variant={active ? 'default' : 'outline'}
                              onClick={() => setTelemetryWindowMinutes(minutes)}
                            >
                              {minutes === 0
                                ? t('developer.telemetryWindowAll')
                                : t('developer.telemetryWindowMinutes', { minutes })}
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center justify-between rounded-md border border-border/60 p-3">
                      <div>
                        <Label>{t('developer.telemetryHistoryOnly')}</Label>
                        <p className="text-xs text-muted-foreground">
                          {t('developer.telemetryHistoryOnlyDesc')}
                        </p>
                      </div>
                      <Switch
                        checked={telemetryHistoryOnly}
                        onCheckedChange={setTelemetryHistoryOnly}
                      />
                    </div>
                    <div className="space-y-2 rounded-md border border-border/60 p-3 sm:col-span-2 lg:col-span-1">
                      <Label>{t('developer.historyStrategyMetrics')}</Label>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">{t('developer.telemetryMinSample')}</span>
                          <Input
                            type="number"
                            min={HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN}
                            max={HISTORY_STRATEGY_RELIABLE_SAMPLE_MIN_MAX}
                            step={1}
                            value={historyStrategySampleMinDraft}
                            onChange={(event) => setHistoryStrategySampleMinDraft(event.target.value)}
                            onBlur={handleHistoryStrategySampleMinBlur}
                            className="h-8 w-24 font-mono"
                          />
                          <Badge variant="outline">n&lt;{historyStrategySampleMin}</Badge>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <span className="self-center text-xs text-muted-foreground">{t('developer.telemetrySortBy')}</span>
                          {HISTORY_STRATEGY_SORT_KEYS.map((key) => (
                            <Button
                              key={key}
                              type="button"
                              size="sm"
                              variant={historyStrategySortKey === key ? 'default' : 'outline'}
                              onClick={() => setHistoryStrategySortKey(key)}
                            >
                              {t(HISTORY_STRATEGY_SORT_LABEL_KEY[key])}
                            </Button>
                          ))}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setHistoryStrategySortDirection((prev) => (prev === 'desc' ? 'asc' : 'desc'))}
                          >
                            {historyStrategySortDirection === 'desc'
                              ? t('developer.telemetrySortDesc')
                              : t('developer.telemetrySortAsc')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{t('developer.telemetryTotal')}: {telemetryStats.total}</Badge>
                    {filteredTelemetryEntries.length !== telemetryEntries.length && (
                      <Badge variant="outline">
                        {t('developer.telemetryFiltered')}: {filteredTelemetryEntries.length}/{telemetryEntries.length}
                      </Badge>
                    )}
                    <Badge variant={telemetryStats.errorCount > 0 ? 'destructive' : 'secondary'}>
                      {t('developer.telemetryErrors')}: {telemetryStats.errorCount}
                    </Badge>
                    <Badge variant={telemetryStats.slowCount > 0 ? 'secondary' : 'outline'}>
                      {t('developer.telemetrySlow')}: {telemetryStats.slowCount}
                    </Badge>
                    <div className="ml-auto flex gap-2">
                      <Button type="button" variant="outline" size="sm" onClick={handleCopyTelemetry}>
                        <Copy className="h-4 w-4 mr-2" />
                        {t('common:actions.copy')}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={handleClearTelemetry}>
                        {t('common:actions.clear')}
                      </Button>
                    </div>
                  </div>

                  <StableScrollArea className="max-h-72 overflow-auto overscroll-contain rounded-md border border-border/50 bg-muted/20 [scrollbar-gutter:stable]">
                    {telemetryByEvent.length > 0 && (
                      <div className="border-b border-border/50 bg-background/70 p-2">
                        <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
                          {t('developer.telemetryAggregated')}
                        </p>
                        <div className="space-y-1 text-[11px]">
                          {telemetryByEvent.map((item) => (
                            <div
                              key={item.event}
                              className="grid grid-cols-[minmax(0,1.6fr)_0.7fr_0.9fr_0.8fr_1fr] gap-2 rounded border border-border/40 px-2 py-1"
                            >
                              <span className="truncate font-medium" title={item.event}>{item.event}</span>
                              <span className="text-muted-foreground">n={item.count}</span>
                              <span className="text-muted-foreground">
                                avg={item.timedCount > 0 ? Math.round(item.totalDuration / item.timedCount) : 0}ms
                              </span>
                              <span className="text-muted-foreground">slow={item.slowCount}</span>
                              <span className="text-muted-foreground">err={item.errorCount}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {historyStrategyMetrics.length > 0 && (
                      <div className="border-b border-border/50 bg-background/70 p-2">
                        <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
                          {t('developer.historyStrategyMetrics')}
                        </p>
                        <div className="space-y-1 text-[11px]">
                          {historyStrategyMetrics.map((item) => (
                            <div
                              key={`${item.strategy}:${item.mode}`}
                              className={`grid grid-cols-[minmax(0,0.95fr)_0.55fr_0.5fr_0.65fr_0.65fr_0.65fr_0.65fr_0.5fr_0.5fr_0.5fr_0.7fr] gap-2 rounded border border-border/40 px-2 py-1 ${
                                item.lowSample ? 'opacity-70' : ''
                              }`}
                            >
                              <span className="truncate font-medium font-mono" title={item.strategy}>{item.strategy}</span>
                              <span className="text-muted-foreground">{item.mode}</span>
                              <span className="text-muted-foreground">n={item.count}</span>
                              <span className="text-muted-foreground">avg={item.avgMs}ms</span>
                              <span className="text-muted-foreground">p50={item.p50Ms}ms</span>
                              <span className="text-muted-foreground">p95={item.p95Ms}ms</span>
                              <span className="text-muted-foreground">p99={item.p99Ms}ms</span>
                              <span className="text-muted-foreground">ok={item.successCount}</span>
                              <span className="text-muted-foreground">rec={item.recoveredCount}</span>
                              <span className="text-muted-foreground">fail={item.failedCount}</span>
                              <span className="text-muted-foreground">
                                {item.lowSample
                                  ? t('developer.telemetryLowSample', { min: historyStrategySampleMin })
                                  : ''}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="space-y-1 p-2 font-mono text-xs">
                      {filteredTelemetryEntries.length === 0 ? (
                        <div className="text-muted-foreground">{t('developer.telemetryEmpty')}</div>
                      ) : (
                        filteredTelemetryEntries
                          .slice()
                          .reverse()
                          .map((entry) => (
                            <div key={entry.id} className="rounded border border-border/40 bg-background/60 p-2">
                              <div className="flex items-center justify-between gap-3">
                                <span className="font-semibold">{entry.event}</span>
                                <span className="text-muted-foreground">{entry.ts}</span>
                              </div>
                              <pre className="mt-1 whitespace-pre-wrap text-[11px] text-muted-foreground">
                                {JSON.stringify({ count: entry.count, ...entry.payload }, null, 2)}
                              </pre>
                            </div>
                          ))
                      )}
                    </div>
                  </StableScrollArea>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
