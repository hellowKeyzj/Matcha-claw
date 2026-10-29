import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { SettingsSectionProps } from '@/app/extensions';
import { useTranslation } from 'react-i18next';
import { StableScrollArea } from '@/components/scroll';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { fetchGatewayRepair, isGatewayRepairActive } from '@/plugins/runtime/gateway-repair';
import type { RuntimeRepairSnapshot } from '@/types/runtime-repair';
import { isTraceEnabled, traceLog } from '@/lib/trace-logger';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc, toUserMessage } from '@/lib/api-client';
import { subscribeHostEvent } from '@/lib/host-events';
import { waitForCall } from '@/lib/call-log-await';
import { decodeCallReceipt } from '@/types/call-log/receipt';
import { useLocalLicenseLocked } from '@/plugins/account/stores/license';
import { useGatewayStore } from '@/plugins/runtime/store';
import { findRuntimeEndpointByAdapter, runtimeEndpointBadgeVariant, runtimeEndpointStatusLabel, useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import { usePluginsStore } from '@/plugins/native-plugins/store';
import { useSettingsStore } from '../store';
import { ProxySettings } from './ProxySettings';
import { RuntimeStatusDot, RuntimeStatusList, type RuntimeStatusItem, type RuntimeStatusTone } from './RuntimeStatusList';

type MatchaAgentAppServerStatus = {
  processState: string;
  port: number | null;
  pid: number | null;
  ready: boolean;
  lastError: string | null;
  updatedAt: number | string;
};

const STARTUP_TRACE_PREFIX = '[startup-trace]';

function summarizeMatchaAgentAppServerTrace(status: MatchaAgentAppServerStatus | null | undefined) {
  if (!status) return null;
  return {
    processState: status.processState,
    ready: status.ready,
    port: status.port,
    pid: status.pid,
    updatedAt: status.updatedAt,
    hasLastError: Boolean(status.lastError),
  };
}

function summarizeSettingsTraceError(error: unknown): { errorName: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    message: message
      .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|private)\/)[^\s"'<>)]*/g, '[path]')
      .replace(/(token|authorization|password|secret|api[-_ ]?key)(["'\s:=]+)[^\s"',}]+/gi, '$1$2[redacted]')
      .slice(0, 200),
  };
}

function traceSettingsStartup(phase: string, payload: () => Record<string, unknown>): void {
  traceLog(() => [JSON.stringify({
    prefix: STARTUP_TRACE_PREFIX,
    source: 'settings-page',
    phase,
    atMs: Date.now(),
    ...payload(),
  })]);
}

function formatMatchaAgentAppServerStatusLabel(
  status: MatchaAgentAppServerStatus | null,
  loading: boolean,
  loadingLabel: string,
): string {
  if (status) return status.processState;
  return loading ? loadingLabel : 'unknown';
}

function matchaAgentAppServerBadgeVariantForStatus(
  status: MatchaAgentAppServerStatus | null,
  loading: boolean,
): 'success' | 'outline' | 'destructive' | 'secondary' {
  if (!status) return loading ? 'outline' : 'secondary';
  if (status.processState === 'running' && status.ready) return 'success';
  if (status.processState === 'failed' || status.processState === 'unavailable' || status.processState === 'shutDown') return 'destructive';
  return 'outline';
}

function runtimeStatusToneForVariant(variant: 'success' | 'outline' | 'destructive' | 'secondary'): RuntimeStatusTone {
  if (variant === 'success') return 'success';
  if (variant === 'destructive') return 'destructive';
  if (variant === 'outline') return 'pending';
  return 'neutral';
}

function runtimeHostStatusTone(status: string): RuntimeStatusTone {
  if (status === 'running') return 'success';
  if (status === 'starting' || status === 'restarting' || status === 'stopping') return 'pending';
  if (status === 'degraded') return 'warning';
  if (status === 'stopped' || status === 'error') return 'destructive';
  return 'neutral';
}

function summarizeRuntimeStatusTone(items: RuntimeStatusItem[]): RuntimeStatusTone {
  if (items.some((item) => item.tone === 'destructive')) return 'destructive';
  if (items.some((item) => item.tone === 'warning')) return 'warning';
  if (items.some((item) => item.tone === 'pending')) return 'pending';
  if (items.length > 0 && items.every((item) => item.tone === 'success')) return 'success';
  return 'neutral';
}

function runtimeHostStatusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'running':
      return t('plugins:state.hostRunning');
    case 'starting':
      return t('plugins:state.hostStarting');
    case 'restarting':
      return t('plugins:state.hostRestarting');
    case 'stopping':
      return t('plugins:state.hostStopping');
    case 'degraded':
      return t('plugins:state.hostDegraded');
    case 'stopped':
    case 'error':
      return t('plugins:state.hostStopped');
    default:
      return status;
  }
}

function runtimeStatusSummaryLabel(tone: RuntimeStatusTone, t: (key: string) => string): string {
  if (tone === 'success') return t('gateway.runtimeSummaryReady');
  if (tone === 'pending') return t('gateway.runtimeSummaryPending');
  if (tone === 'warning' || tone === 'destructive') return t('gateway.runtimeSummaryIssue');
  return t('gateway.runtimeSummaryUnknown');
}

function formatIsoTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

export default function GatewaySection({ active }: SettingsSectionProps) {
  const { t } = useTranslation(['settings', 'plugins', 'common']);
  const licenseLocked = useLocalLicenseLocked();
  const gatewayAutoStart = useSettingsStore((state) => state.gatewayAutoStart);
  const setGatewayAutoStart = useSettingsStore((state) => state.setGatewayAutoStart);
  const runtimeHostEventState = useGatewayStore((state) => state.runtimeHost);
  const runtimeEndpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const runtimeEndpointsStatus = useRuntimeEndpointsStore((state) => state.status);
  const initRuntimeEndpoints = useRuntimeEndpointsStore((state) => state.init);
  const refreshRuntimeEndpoints = useRuntimeEndpointsStore((state) => state.refresh);
  const initGatewayEvents = useGatewayStore((state) => state.init);
  const refreshRuntimeHostStatusSnapshot = useGatewayStore((state) => state.refreshRuntimeHostStatus);
  const restartGateway = useGatewayStore((state) => state.restart);
  const repairGateway = useGatewayStore((state) => state.repair);
  const gatewayLifecycleOperation = useGatewayStore((state) => state.lifecycleOperation);
  const gatewayProcessState = useGatewayStore((state) => state.status.processState);
  const gatewayRepairOutcome = useGatewayStore((state) => state.repairOutcome);
  const [gatewayRepair, setGatewayRepair] = useState<RuntimeRepairSnapshot | null>(null);
  const [gatewayRepairUnavailable, setGatewayRepairUnavailable] = useState(false);
  const [showRepairConfirmation, setShowRepairConfirmation] = useState(false);
  const refreshing = usePluginsStore((state) => state.refreshing);
  const refreshReason = usePluginsStore((state) => state.refreshReason);
  const mutating = usePluginsStore((state) => state.mutating);
  const mutatingAction = usePluginsStore((state) => state.mutatingAction);
  const refreshRuntime = usePluginsStore((state) => state.refreshRuntime);
  const restartHostAction = usePluginsStore((state) => state.restartHost);
  const [showOpenClawLogs, setShowOpenClawLogs] = useState(false);
  const [openClawLogContent, setOpenClawLogContent] = useState('');
  const openClawLogsReadRef = useRef(0);
  const [matchaAgentAppServerStatus, setMatchaAgentAppServerStatus] = useState<MatchaAgentAppServerStatus | null>(null);
  const [matchaAgentAppServerLoading, setMatchaAgentAppServerLoading] = useState(false);
  const [matchaAgentAppServerRestarting, setMatchaAgentAppServerRestarting] = useState(false);
  const [matchaAgentAppServerError, setMatchaAgentAppServerError] = useState('');
  const matchaAgentAppServerStatusRequestSequenceRef = useRef(0);

  useEffect(() => {
    if (licenseLocked) return;
    void initGatewayEvents();
    const hadRuntime = usePluginsStore.getState().runtimeReady;
    void refreshRuntime({ reason: 'initial' }).catch(() => {
      if (!hadRuntime) {
        toast.error(t('plugins:errors.loadFailed'));
      }
    });
  }, [initGatewayEvents, licenseLocked, refreshRuntime, t]);

  useEffect(() => {
    if (licenseLocked) return;
    let stopped = false;
    let request: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isVisible = () => document.visibilityState !== 'hidden';
    const refresh = async () => {
      if (stopped || !isVisible() || request) return;
      clearTimeout(timer);
      request = new AbortController();
      try {
        const snapshot = await fetchGatewayRepair(request.signal);
        if (stopped) return;
        setGatewayRepair(snapshot);
        setGatewayRepairUnavailable(false);
      } catch {
        if (!stopped) setGatewayRepairUnavailable(true);
      } finally {
        request = null;
        // Gateway events do not expose every doctor phase; keep one visible-page read in flight.
        if (!stopped && isVisible()) timer = setTimeout(() => void refresh(), 5_000);
      }
    };
    const onVisibilityChange = () => {
      clearTimeout(timer);
      if (isVisible()) void refresh();
    };
    const unsubscribe = useGatewayStore.subscribe((state, previous) => {
      if (state.status !== previous.status || state.lifecycleOperation !== previous.lifecycleOperation) {
        void refresh();
      }
    });
    document.addEventListener('visibilitychange', onVisibilityChange);
    void refresh();
    return () => {
      stopped = true;
      request?.abort();
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [licenseLocked]);

  useEffect(() => () => { openClawLogsReadRef.current += 1; }, []);

  const handleShowOpenClawLogs = async () => {
    const request = ++openClawLogsReadRef.current;
    setShowOpenClawLogs(true);
    try {
      const logs = await hostApiFetch<{ content: string }>('/api/openclaw/logs?tailLines=100');
      if (request === openClawLogsReadRef.current) setOpenClawLogContent(logs.content);
    } catch {
      if (request === openClawLogsReadRef.current) setOpenClawLogContent('(Failed to load logs)');
    }
  };

  const handleOpenOpenClawLogDir = async () => {
    try {
      const { dir: logDir } = await hostApiFetch<{ dir: string | null }>('/api/openclaw/logs/dir');
      if (logDir) {
        await invokeIpc('shell:showItemInFolder', logDir);
      }
    } catch {
      // ignore
    }
  };

  const observedRuntimeHostStatus = runtimeHostEventState.lifecycle;
  const effectiveRuntimeHostStatus = observedRuntimeHostStatus;
  const runtimeEndpointCatalogLoading = runtimeEndpointsStatus === 'idle' || runtimeEndpointsStatus === 'loading';
  const openClawEndpoint = findRuntimeEndpointByAdapter(runtimeEndpoints, 'openclaw');
  const openClawEndpointStatus = runtimeEndpointCatalogLoading && !openClawEndpoint
    ? t('common:status.loading')
    : runtimeEndpointStatusLabel(openClawEndpoint);
  const matchaAgentAppServerStatusLabel = formatMatchaAgentAppServerStatusLabel(
    matchaAgentAppServerStatus,
    matchaAgentAppServerLoading,
    t('common:status.loading'),
  );
  const openClawEndpointBadgeVariant = openClawEndpoint
    ? runtimeEndpointBadgeVariant(openClawEndpoint)
    : runtimeEndpointCatalogLoading ? 'outline' : 'secondary';
  const matchaAgentAppServerBadgeVariant = matchaAgentAppServerBadgeVariantForStatus(
    matchaAgentAppServerStatus,
    matchaAgentAppServerLoading,
  );
  const showRuntimeHostError = effectiveRuntimeHostStatus === 'degraded'
    || effectiveRuntimeHostStatus === 'error'
    || effectiveRuntimeHostStatus === 'stopped';
  const runtimeHostRecoveredAt = runtimeHostEventState.lastRestartAt
    ? formatIsoTime(runtimeHostEventState.lastRestartAt)
    : '';
  const manualRuntimeRefreshing = refreshing && refreshReason === 'manual';

  const refreshRuntimeHostStatus = useCallback(async () => {
    try {
      await refreshRuntimeHostStatusSnapshot();
    } catch {
      toast.error(t('plugins:errors.loadFailed'));
    }
  }, [refreshRuntimeHostStatusSnapshot, t]);

  const applyMatchaAgentAppServerStatus = useCallback((status: MatchaAgentAppServerStatus) => {
    traceSettingsStartup('matcha-agent-status-apply', () => (summarizeMatchaAgentAppServerTrace(status) ?? {}));
    setMatchaAgentAppServerStatus(status);
    setMatchaAgentAppServerError('');
  }, []);

  const loadMatchaAgentAppServerStatus = useCallback(async () => {
    const ownedRequestSequence = matchaAgentAppServerStatusRequestSequenceRef.current + 1;
    const startedAtMs = isTraceEnabled() ? Date.now() : 0;
    matchaAgentAppServerStatusRequestSequenceRef.current = ownedRequestSequence;
    const isOwnedStatusRequest = () => matchaAgentAppServerStatusRequestSequenceRef.current === ownedRequestSequence;

    traceSettingsStartup('matcha-agent-status-request-start', () => ({ sequence: ownedRequestSequence }));
    setMatchaAgentAppServerLoading(true);
    setMatchaAgentAppServerError('');
    try {
      const status = await hostApiFetch<MatchaAgentAppServerStatus>('/api/matcha-agent/app-server/status');
      traceSettingsStartup('matcha-agent-status-request-success', () => ({
        sequence: ownedRequestSequence,
        durationMs: Date.now() - startedAtMs,
        owned: isOwnedStatusRequest(),
        ...(summarizeMatchaAgentAppServerTrace(status) ?? {}),
      }));
      if (isOwnedStatusRequest()) {
        applyMatchaAgentAppServerStatus(status);
      }
    } catch (error) {
      traceSettingsStartup('matcha-agent-status-request-error', () => ({
        sequence: ownedRequestSequence,
        durationMs: Date.now() - startedAtMs,
        owned: isOwnedStatusRequest(),
        ...summarizeSettingsTraceError(error),
      }));
      if (isOwnedStatusRequest()) {
        setMatchaAgentAppServerError(toUserMessage(error));
      }
    } finally {
      if (isOwnedStatusRequest()) {
        setMatchaAgentAppServerLoading(false);
      }
    }
  }, [applyMatchaAgentAppServerStatus]);

  const restartMatchaAgentAppServer = useCallback(async () => {
    setMatchaAgentAppServerRestarting(true);
    setMatchaAgentAppServerError('');
    try {
      const receipt = decodeCallReceipt(await hostApiFetch<unknown>('/api/matcha-agent/app-server/restart', { method: 'POST' }));
      const call = await waitForCall(receipt, 'runtime-control');
      const { detail } = call;
      if (call.command !== 'lifecycle.restart'
        || detail.endpoint?.runtimeAdapterId !== 'matcha-agent'
        || detail.endpoint.runtimeInstanceId !== 'local') {
        throw new Error('Matcha Agent restart call does not match the requested operation');
      }
      if (call.status !== 'succeeded' || detail.result !== 'succeeded'
        || detail.lifecycle !== 'running' || detail.error !== null || detail.failure !== null) {
        throw new Error(detail.startupDiagnostic ?? detail.failure ?? detail.error
          ?? `Matcha Agent restart outcome: ${detail.lifecycle ?? call.status}`);
      }
      await loadMatchaAgentAppServerStatus();
    } catch (error) {
      const message = toUserMessage(error);
      setMatchaAgentAppServerError(message);
      toast.error(t('gateway.matchaAgentAppServerRestartFailed', { error: message }));
    } finally {
      setMatchaAgentAppServerRestarting(false);
    }
  }, [loadMatchaAgentAppServerStatus, t]);

  const matchaAgentAppServerStatusError = matchaAgentAppServerStatus?.lastError || matchaAgentAppServerError;

  useEffect(() => {
    if (!active) {
      return;
    }
    initRuntimeEndpoints();
    void refreshRuntimeEndpoints();
    void loadMatchaAgentAppServerStatus();
    const unsubscribe = subscribeHostEvent<MatchaAgentAppServerStatus>('matcha-agent:status', (payload) => {
      if (payload && typeof payload === 'object' && typeof payload.processState === 'string') {
        traceSettingsStartup('matcha-agent-status-event', () => (summarizeMatchaAgentAppServerTrace(payload) ?? {}));
        applyMatchaAgentAppServerStatus(payload);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [active, applyMatchaAgentAppServerStatus, initRuntimeEndpoints, loadMatchaAgentAppServerStatus, refreshRuntimeEndpoints]);

  const restartRuntimeHost = useCallback(async () => {
    try {
      await restartHostAction();
    } catch {
      toast.error(t('plugins:errors.restartFailed'));
    }
  }, [restartHostAction, t]);

  const gatewayRepairActive = isGatewayRepairActive(gatewayRepair);
  const gatewayActionsBusy = gatewayLifecycleOperation !== null || gatewayRepairActive
    || gatewayProcessState === 'starting' || gatewayProcessState === 'control_connecting';
  const repairOutcomeMessage = gatewayRepairOutcome
    ? gatewayRepairOutcome === 'succeeded'
      ? t('gateway.repair.phases.succeeded')
      : gatewayRepairOutcome === 'unknown' || gatewayRepairOutcome === 'rejected'
        ? t(`gateway.repair.${gatewayRepairOutcome}`)
        : t(`gateway.repair.failures.${gatewayRepairOutcome}`)
    : null;
  const openClawEndpointTone = gatewayRepairActive
    ? 'pending'
    : runtimeStatusToneForVariant(openClawEndpointBadgeVariant);
  const runtimeHostTone = runtimeHostStatusTone(effectiveRuntimeHostStatus);
  const matchaAgentAppServerTone = runtimeStatusToneForVariant(matchaAgentAppServerBadgeVariant);
  const shouldShowRuntimeHostDetails = Boolean(
    showRuntimeHostError && runtimeHostEventState.error
    || runtimeHostEventState.restartCount > 0
    || runtimeHostRecoveredAt,
  );
  const runtimeHostDetails = shouldShowRuntimeHostDetails
    ? (
      <>
        {showRuntimeHostError && runtimeHostEventState.error && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            {runtimeHostEventState.error}
          </p>
        )}
        {runtimeHostEventState.restartCount > 0 && (
          <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-700">
            {t('plugins:runtime.recoveredNotice', { count: runtimeHostEventState.restartCount })}
          </p>
        )}
        {runtimeHostRecoveredAt && (
          <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-700">
            {t('plugins:runtime.recoveredAt', { time: runtimeHostRecoveredAt })}
          </p>
        )}
      </>
    )
    : undefined;
  const runtimeStatusItems: RuntimeStatusItem[] = [
    {
      id: 'runtime-host',
      title: t('gateway.runtimeHostRuntimeLabel'),
      status: runtimeHostStatusLabel(effectiveRuntimeHostStatus, t),
      tone: runtimeHostTone,
      activity: refreshing && !manualRuntimeRefreshing ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('common:status.loading')}
        </span>
      ) : undefined,
      actions: [
        {
          id: 'restart',
          label: mutatingAction === 'restart' ? t('plugins:runtime.busy') : t('plugins:runtime.restart'),
          icon: 'refresh',
          onClick: () => void restartRuntimeHost(),
          disabled: manualRuntimeRefreshing || mutating,
        },
        {
          id: 'refresh',
          label: manualRuntimeRefreshing ? t('plugins:runtime.busy') : t('common:actions.refresh'),
          icon: 'refresh',
          onClick: () => void refreshRuntimeHostStatus(),
          disabled: manualRuntimeRefreshing || mutating,
          loading: manualRuntimeRefreshing,
        },
      ],
      details: runtimeHostDetails,
    },
    {
      id: 'openclaw',
      title: t('gateway.openclawRuntimeLabel'),
      status: gatewayRepairActive && gatewayRepair
        ? t(`gateway.repair.phases.${gatewayRepair.phase}`)
        : openClawEndpointStatus,
      tone: openClawEndpointTone,
      actions: [
        {
          id: 'restart',
          label: t('common:actions.restart'),
          icon: 'refresh',
          onClick: restartGateway,
          disabled: gatewayActionsBusy,
          loading: gatewayLifecycleOperation === 'restart',
        },
        {
          id: 'repair',
          label: t('gateway.repair.action'),
          icon: 'repair',
          onClick: () => setShowRepairConfirmation(true),
          disabled: gatewayActionsBusy,
          loading: gatewayLifecycleOperation === 'repair' || gatewayRepairActive,
        },
        {
          id: 'logs',
          label: t('gateway.logs'),
          icon: 'logs',
          onClick: handleShowOpenClawLogs,
        },
      ],
      details: gatewayRepairActive || gatewayRepair?.trigger === 'automatic'
        || gatewayLifecycleOperation === 'repair' || repairOutcomeMessage || gatewayRepairUnavailable || showOpenClawLogs ? (
        <>
        <div role="status" aria-live="polite" className="space-y-2 text-xs text-muted-foreground">
          {gatewayRepair && (gatewayRepairActive || gatewayRepair.trigger === 'automatic') && (
            <p>
              {gatewayRepair.trigger && `${t(`gateway.repair.${gatewayRepair.trigger}`)} · `}
              {t(`gateway.repair.phases.${gatewayRepair.phase}`)}
              {gatewayRepair.failure && ` · ${t(`gateway.repair.failures.${gatewayRepair.failure}`)}`}
            </p>
          )}
          {gatewayLifecycleOperation === 'repair' && !gatewayRepairActive && (
            <p>{t('gateway.repair.pending')}</p>
          )}
          {repairOutcomeMessage && (
            <p className={gatewayRepairOutcome === 'succeeded' ? 'text-emerald-700 dark:text-emerald-200' : 'text-muted-foreground'}>
              {t('gateway.repair.manual')}{' · '}{repairOutcomeMessage}
            </p>
          )}
          {gatewayRepairUnavailable && <p>{t('gateway.repair.statusUnavailable')}</p>}
        </div>
        {showOpenClawLogs && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium">{t('gateway.openclawLogs')}</p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleOpenOpenClawLogDir}>
                <ExternalLink className="h-3 w-3" />
                {t('gateway.openFolder')}
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => {
                openClawLogsReadRef.current += 1;
                setShowOpenClawLogs(false);
              }}>
                {t('common:actions.close')}
              </Button>
            </div>
          </div>
          <StableScrollArea className="max-h-60 overflow-auto overscroll-contain rounded bg-background/60 [scrollbar-gutter:stable]">
            <pre className="whitespace-pre-wrap p-3 font-mono text-xs text-muted-foreground">
              {openClawLogContent || t('chat:noLogs')}
            </pre>
          </StableScrollArea>
        </div>
        )}
        </>
      ) : undefined,
    },
    {
      id: 'matcha-agent-app-server',
      title: t('gateway.localServiceRuntimeLabel'),
      status: matchaAgentAppServerStatusLabel,
      tone: matchaAgentAppServerTone,
      actions: [
        {
          id: 'restart',
          label: t('common:actions.restart'),
          icon: 'refresh',
          onClick: () => void restartMatchaAgentAppServer(),
          disabled: matchaAgentAppServerLoading || matchaAgentAppServerRestarting,
          loading: matchaAgentAppServerRestarting,
        },
        {
          id: 'refresh',
          label: t('common:actions.refresh'),
          icon: 'refresh',
          onClick: () => void loadMatchaAgentAppServerStatus(),
          disabled: matchaAgentAppServerLoading || matchaAgentAppServerRestarting,
          loading: matchaAgentAppServerLoading,
        },
      ],
      details: matchaAgentAppServerStatusError ? (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {matchaAgentAppServerStatusError}
        </p>
      ) : undefined,
    },
  ];
  const runtimeStatusSummaryTone = summarizeRuntimeStatusTone(runtimeStatusItems);
  const runtimeStatusSummary = runtimeStatusSummaryLabel(runtimeStatusSummaryTone, t);

  return (
    <>
      <ConfirmDialog
        open={!licenseLocked && showRepairConfirmation}
        title={t('gateway.repair.confirmTitle')}
        message={t('gateway.repair.confirmDescription')}
        confirmLabel={t('gateway.repair.confirmAction')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onCancel={() => setShowRepairConfirmation(false)}
        onConfirm={async () => {
          setShowRepairConfirmation(false);
          if (!gatewayActionsBusy) await repairGateway();
        }}
      />
      <Card className="order-1">
        {active && <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle>{t('gateway.runtimeTitle')}</CardTitle>
          <div className="flex items-center gap-2 rounded-[var(--radius-pill)] border border-border/80 bg-background/60 px-3 py-1.5">
            <span className="text-xs font-medium text-muted-foreground">{runtimeStatusSummary}</span>
            <RuntimeStatusDot tone={runtimeStatusSummaryTone} />
          </div>
        </CardHeader>}
        <CardContent className="space-y-4">
          {active && <>
          <RuntimeStatusList items={runtimeStatusItems} />


          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>{t('gateway.autoStart')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('gateway.autoStartDesc')}
              </p>
            </div>
            <Switch
              checked={gatewayAutoStart}
              onCheckedChange={(value) => { void setGatewayAutoStart(value).catch(() => {}); }}
            />
          </div>

          <Separator />
          </>}
          <ProxySettings active={active} />
        </CardContent>
      </Card>
    </>
  );
}
