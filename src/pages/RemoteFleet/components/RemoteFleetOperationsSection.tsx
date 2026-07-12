import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  Command,
  FileWarning,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type {
  RemoteFleetAuditEventSummary,
  RemoteFleetCommandSummary,
  RemoteFleetMetricsSnapshot,
} from '@/stores/remote-fleet';
import type { RemoteFleetWorkspaceLayout } from './remote-fleet-console-types';
import {
  RemoteFleetEmptyPanel,
  RemoteFleetFieldRow,
  RemoteFleetStatusBadge,
  remoteFleetStatusLabel,
  safeRemoteFleetDisplayValue,
} from './remote-fleet-console-shared';

const REMOTE_FLEET_HISTORY_DISPLAY_LIMIT = 50;

type OperationsView = 'overview' | 'commands' | 'audit';

type LoadState = 'not-loaded' | 'loading' | 'loaded' | 'failed';

const OPERATIONS_VIEWS: readonly OperationsView[] = ['overview', 'commands', 'audit'];
const OPERATIONS_PROJECTION_GAPS = [
  {
    id: 'routing-explain',
    titleKey: 'remoteFleet.operations.gaps.routingExplain.title',
    descriptionKey: 'remoteFleet.operations.gaps.routingExplain.description',
  },
  {
    id: 'log-redaction',
    titleKey: 'remoteFleet.operations.gaps.logRedaction.title',
    descriptionKey: 'remoteFleet.operations.gaps.logRedaction.description',
  },
] as const;

export interface RemoteFleetOperationsSectionProps {
  readonly metrics: RemoteFleetMetricsSnapshot | null;
  readonly commands: readonly RemoteFleetCommandSummary[];
  readonly auditEvents: readonly RemoteFleetAuditEventSummary[];
  readonly loadingMetrics: boolean;
  readonly loadingCommands: boolean;
  readonly loadingAuditEvents: boolean;
  readonly onLoadMetrics: () => Promise<void>;
  readonly onLoadCommands: () => Promise<void>;
  readonly onLoadAuditEvents: () => Promise<void>;
  readonly layout: RemoteFleetWorkspaceLayout;
}

function operationViewLabel(
  view: OperationsView,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (view) {
    case 'overview':
      return t('remoteFleet.operations.tabs.overview', { defaultValue: 'Overview' });
    case 'commands':
      return t('remoteFleet.operations.tabs.commands');
    case 'audit':
      return t('remoteFleet.operations.tabs.audit');
  }
}

function operationViewIcon(view: OperationsView) {
  switch (view) {
    case 'overview':
      return <BarChart3 className="h-4 w-4" />;
    case 'commands':
      return <Command className="h-4 w-4" />;
    case 'audit':
      return <Activity className="h-4 w-4" />;
  }
}

function countFor(counts: Record<string, number>, key: string): number {
  return counts[key] ?? 0;
}

function percentValue(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function CountBadges({ counts, translateStatus = false }: { readonly counts: Record<string, number>; readonly translateStatus?: boolean }) {
  const { t } = useTranslation('common');
  const entries = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    return <span className="text-xs text-muted-foreground">{t('remoteFleet.operations.metrics.noNonZeroBuckets')}</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([name, count]) => (
        <Badge key={name} variant="outline">
          {translateStatus ? remoteFleetStatusLabel(name, t) : name}: {count}
        </Badge>
      ))}
    </div>
  );
}

function RefreshButton({ loading, onLoad }: { readonly loading: boolean; readonly onLoad: () => Promise<void> }) {
  const { t } = useTranslation('common');
  return (
    <Button variant="outline" size="sm" disabled={loading} onClick={() => { void onLoad().catch(() => undefined); }}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      {t('remoteFleet.operations.refresh', { defaultValue: 'Refresh' })}
    </Button>
  );
}

function MetricProgressRow({
  label,
  value,
  total,
  hasFailure = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly total: number;
  readonly hasFailure?: boolean;
}) {
  return (
    <div className="border-b border-border/70 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-4 text-sm">
        <span className="min-w-0 truncate font-medium">{label}</span>
        <Badge variant={hasFailure ? 'destructive' : 'secondary'}>{value}/{total}</Badge>
      </div>
      <Progress className="mt-2 h-1.5" value={percentValue(value, total)} />
    </div>
  );
}

function MetricGroup({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="border-t border-border/70 py-4 first:border-t-0">
      <h4 className="mb-3 text-sm font-semibold">{title}</h4>
      {children}
    </section>
  );
}

function OverviewPanel({
  metrics,
  loadingMetrics,
  onLoadMetrics,
  layout,
}: Pick<RemoteFleetOperationsSectionProps, 'metrics' | 'loadingMetrics' | 'onLoadMetrics' | 'layout'>) {
  const { t } = useTranslation('common');
  const runtimeRunningCount = metrics ? countFor(metrics.runtimes.countByStatus, 'running') : 0;
  const runtimeTotalCount = metrics?.runtimes.totalCount ?? 0;
  const endpointReadyCount = metrics ? countFor(metrics.endpoints.countByStatus, 'ready') : 0;
  const endpointTotalCount = metrics?.endpoints.totalCount ?? 0;
  const commandFailureCount = metrics?.commands.recentFailureCount ?? 0;
  const commandTotalCount = metrics?.commands.totalCount ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">{t('remoteFleet.operations.tabs.overview', { defaultValue: 'Overview' })}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('remoteFleet.operations.overview.description', { defaultValue: 'Fleet-wide runtime health, endpoint availability, and data coverage.' })}
          </p>
        </div>
        <RefreshButton loading={loadingMetrics} onLoad={onLoadMetrics} />
      </div>

      {!metrics ? (
        <RemoteFleetEmptyPanel
          icon={loadingMetrics ? <Loader2 className="h-5 w-5 animate-spin" /> : <BarChart3 className="h-5 w-5" />}
          title={loadingMetrics
            ? t('remoteFleet.operations.metrics.loadingTitle', { defaultValue: 'Loading fleet metrics' })
            : t('remoteFleet.operations.metrics.emptyTitle')}
          description={loadingMetrics
            ? t('remoteFleet.operations.metrics.loadingDescription', { defaultValue: 'Reading the latest fleet-wide projection.' })
            : t('remoteFleet.operations.metrics.emptyDescription')}
        />
      ) : (
        <>
          <div className={cn('grid gap-x-8', layout === 'wide' ? 'grid-cols-3' : layout === 'compact' ? 'grid-cols-2' : 'grid-cols-1')}>
            <MetricProgressRow label={t('remoteFleet.operations.metrics.runtimeRunning')} value={runtimeRunningCount} total={runtimeTotalCount} />
            <MetricProgressRow label={t('remoteFleet.operations.metrics.endpointReady')} value={endpointReadyCount} total={endpointTotalCount} />
            <MetricProgressRow label={t('remoteFleet.operations.metrics.recentFailures')} value={commandFailureCount} total={commandTotalCount} hasFailure={commandFailureCount > 0} />
          </div>

          <div className={cn('grid gap-x-10', layout === 'wide' ? 'grid-cols-2' : 'grid-cols-1')}>
            <div>
              <MetricGroup title={t('remoteFleet.operations.metrics.nodeStatus')}>
                <CountBadges counts={metrics.nodes.countByStatus} translateStatus />
                <h5 className="mb-2 mt-4 text-xs font-medium text-muted-foreground">{t('remoteFleet.operations.metrics.targetKind')}</h5>
                <CountBadges counts={metrics.nodes.countByTargetKind} />
              </MetricGroup>
              <MetricGroup title={t('remoteFleet.operations.metrics.runtimeStatus')}>
                <CountBadges counts={metrics.runtimes.countByStatus} translateStatus />
                <h5 className="mb-2 mt-4 text-xs font-medium text-muted-foreground">{t('remoteFleet.operations.metrics.runtimeKind')}</h5>
                <CountBadges counts={metrics.runtimes.countByRuntimeKind} />
              </MetricGroup>
            </div>
            <div>
              <MetricGroup title={t('remoteFleet.operations.metrics.endpointStatus')}>
                <CountBadges counts={metrics.endpoints.countByStatus} translateStatus />
                <div className="mt-4 space-y-2">
                  <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.draining')} value={metrics.endpoints.drainingEndpoints.map((endpoint) => endpoint.id)} />
                  <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.retired')} value={metrics.endpoints.retiredEndpoints.map((endpoint) => endpoint.id)} />
                </div>
              </MetricGroup>
              <MetricGroup title={t('remoteFleet.operations.metrics.commandAudit')}>
                <CountBadges counts={metrics.commands.countByStatus} translateStatus />
                <div className="mt-4 space-y-2">
                  <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.activeLeases')} value={metrics.leases.activeCount} />
                  <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.staleCapabilities')} value={metrics.capabilities.staleCount} />
                  <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.auditEvents')} value={metrics.auditEvents.totalCount} />
                </div>
              </MetricGroup>
            </div>
          </div>
        </>
      )}

      <section className="border-t border-border/70 pt-5">
        <div className="flex items-center gap-2">
          <FileWarning className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t('remoteFleet.operations.dataCoverage', { defaultValue: 'Data coverage' })}</h3>
        </div>
        <div className="mt-3 divide-y divide-border/70 border-y border-border/70">
          {OPERATIONS_PROJECTION_GAPS.map((gap) => (
            <div key={gap.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t(gap.titleKey)}</span>
                <Badge variant="outline">{t('remoteFleet.operations.gaps.badge')}</Badge>
              </div>
              <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t(gap.descriptionKey)}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function TargetFields({
  nodeId,
  agentId,
  runtimeId,
  endpointId,
  commandId,
}: {
  readonly nodeId?: string;
  readonly agentId?: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly commandId?: string;
}) {
  const { t } = useTranslation('common');
  if (!nodeId && !agentId && !runtimeId && !endpointId && !commandId) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="min-w-0 space-y-1">
      <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.node')} value={nodeId} />
      <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.agent')} value={agentId} />
      <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.runtime')} value={runtimeId} />
      <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.endpoint')} value={endpointId} />
      <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.command')} value={commandId} />
    </div>
  );
}

function HistoryMessage({ message }: { readonly message?: string }) {
  return message
    ? <p className="min-w-0 break-words text-xs text-muted-foreground">{safeRemoteFleetDisplayValue(message)}</p>
    : <span className="text-xs text-muted-foreground">—</span>;
}

function HistoryToolbar({
  query,
  status,
  statuses,
  loading,
  filterLabel,
  allLabel,
  translateStatuses = false,
  onQueryChange,
  onStatusChange,
  onLoad,
}: {
  readonly query: string;
  readonly status: string;
  readonly statuses: readonly string[];
  readonly loading: boolean;
  readonly filterLabel: string;
  readonly allLabel: string;
  readonly translateStatuses?: boolean;
  readonly onQueryChange: (query: string) => void;
  readonly onStatusChange: (status: string) => void;
  readonly onLoad: () => Promise<void>;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          aria-label={t('remoteFleet.operations.searchHistory', { defaultValue: 'Search history' })}
          placeholder={t('remoteFleet.operations.searchHistory', { defaultValue: 'Search history' })}
          className="h-9 pl-9"
        />
      </div>
      <Select
        value={status}
        onChange={(event) => onStatusChange(event.target.value)}
        aria-label={filterLabel}
        className="h-9 sm:w-44"
      >
        <option value="all">{allLabel}</option>
        {statuses.map((item) => <option key={item} value={item}>{translateStatuses ? remoteFleetStatusLabel(item, t) : item}</option>)}
      </Select>
      <RefreshButton loading={loading} onLoad={onLoad} />
    </div>
  );
}

function CommandsPanel({
  commands,
  loading,
  loadState,
  layout,
  onLoad,
}: {
  readonly commands: readonly RemoteFleetCommandSummary[];
  readonly loading: boolean;
  readonly loadState: LoadState;
  readonly layout: RemoteFleetWorkspaceLayout;
  readonly onLoad: () => Promise<void>;
}) {
  const { t } = useTranslation('common');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const statuses = useMemo(() => [...new Set(commands.map((command) => command.status).filter(Boolean) as string[])].sort(), [commands]);
  const filtered = useMemo(() => commands.filter((command) => {
    if (status !== 'all' && command.status !== status) return false;
    const searchText = [command.id, command.command, command.status, command.nodeId, command.agentId, command.runtimeId, command.endpointId]
      .filter(Boolean)
      .join('\n')
      .toLocaleLowerCase();
    return !query.trim() || searchText.includes(query.trim().toLocaleLowerCase());
  }).slice(0, REMOTE_FLEET_HISTORY_DISPLAY_LIMIT), [commands, query, status]);

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{t('remoteFleet.operations.tabs.commands')}</h3>
          <Badge variant="outline">{t('remoteFleet.operations.summaryOnly')}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{t('remoteFleet.operations.commands.description', { defaultValue: 'Fleet-wide command summaries. Output and terminal bytes are not included.' })}</p>
      </div>
      <HistoryToolbar
        query={query}
        status={status}
        statuses={statuses}
        loading={loading}
        filterLabel={t('remoteFleet.operations.statusFilter', { defaultValue: 'Status filter' })}
        allLabel={t('remoteFleet.operations.allStatuses', { defaultValue: 'All statuses' })}
        translateStatuses
        onQueryChange={setQuery}
        onStatusChange={setStatus}
        onLoad={onLoad}
      />
      {loadState !== 'loaded' ? (
        <div className="space-y-3">
          <RemoteFleetEmptyPanel
            icon={loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Command className="h-5 w-5" />}
            title={loading
              ? t('remoteFleet.operations.loading', { defaultValue: 'Loading' })
              : loadState === 'failed'
                ? t('remoteFleet.operations.loadFailed', { defaultValue: 'Operations could not be loaded.' })
                : t('remoteFleet.operations.notLoaded', { defaultValue: 'Not loaded yet' })}
            description={loadState === 'failed'
              ? t('remoteFleet.operations.commands.loadFailedDescription', { defaultValue: 'Retry loading command summaries.' })
              : t('remoteFleet.operations.commands.notLoadedDescription', { defaultValue: 'Open this view to load command summaries.' })}
          />
          {loadState === 'failed' ? <Button variant="outline" size="sm" onClick={() => { void onLoad().catch(() => undefined); }}>{t('remoteFleet.operations.retry', { defaultValue: 'Retry' })}</Button> : null}
        </div>
      ) : filtered.length === 0 ? (
        <RemoteFleetEmptyPanel icon={<Command className="h-5 w-5" />} title={t('remoteFleet.operations.commands.emptyTitle')} description={t('remoteFleet.operations.commands.emptyDescription')} />
      ) : (
        <div className="divide-y divide-border/70 border-y border-border/70">
          {filtered.map((command) => (
            <div
              key={command.id}
              className={cn(
                'grid gap-3 py-3',
                layout === 'wide'
                  ? 'grid-cols-[minmax(0,1.1fr)_minmax(9rem,.7fr)_minmax(0,1fr)_minmax(0,1.2fr)]'
                  : layout === 'compact'
                    ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
                    : 'grid-cols-1',
              )}
            >
              <div className="min-w-0 space-y-1">
                <div className="truncate text-sm font-medium">{command.command || command.id}</div>
                <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.id')} value={command.id} />
              </div>
              <div className="min-w-0 space-y-1">
                <RemoteFleetStatusBadge status={command.status} />
                <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.created')} value={command.createdAt} />
                <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.updated')} value={command.updatedAt} />
              </div>
              <TargetFields nodeId={command.nodeId} agentId={command.agentId} runtimeId={command.runtimeId} endpointId={command.endpointId} />
              <HistoryMessage message={command.message} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AuditPanel({
  auditEvents,
  loading,
  loadState,
  layout,
  onLoad,
}: {
  readonly auditEvents: readonly RemoteFleetAuditEventSummary[];
  readonly loading: boolean;
  readonly loadState: LoadState;
  readonly layout: RemoteFleetWorkspaceLayout;
  readonly onLoad: () => Promise<void>;
}) {
  const { t } = useTranslation('common');
  const [query, setQuery] = useState('');
  const [eventName, setEventName] = useState('all');
  const eventNames = useMemo(() => [...new Set(auditEvents.map((event) => event.eventName).filter(Boolean) as string[])].sort(), [auditEvents]);
  const filtered = useMemo(() => auditEvents.filter((event) => {
    if (eventName !== 'all' && event.eventName !== eventName) return false;
    const searchText = [event.id, event.eventName, event.nodeId, event.agentId, event.runtimeId, event.endpointId, event.commandId]
      .filter(Boolean)
      .join('\n')
      .toLocaleLowerCase();
    return !query.trim() || searchText.includes(query.trim().toLocaleLowerCase());
  }).slice(0, REMOTE_FLEET_HISTORY_DISPLAY_LIMIT), [auditEvents, eventName, query]);

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{t('remoteFleet.operations.tabs.audit')}</h3>
          <Badge variant="outline">{t('remoteFleet.operations.summaryOnly')}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{t('remoteFleet.operations.audit.description', { defaultValue: 'Fleet-wide audit summaries with safe projected messages.' })}</p>
      </div>
      <HistoryToolbar
        query={query}
        status={eventName}
        statuses={eventNames}
        loading={loading}
        filterLabel={t('remoteFleet.operations.eventFilter', { defaultValue: 'Event filter' })}
        allLabel={t('remoteFleet.operations.allEvents', { defaultValue: 'All events' })}
        onQueryChange={setQuery}
        onStatusChange={setEventName}
        onLoad={onLoad}
      />
      {loadState !== 'loaded' ? (
        <div className="space-y-3">
          <RemoteFleetEmptyPanel
            icon={loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Activity className="h-5 w-5" />}
            title={loading
              ? t('remoteFleet.operations.loading', { defaultValue: 'Loading' })
              : loadState === 'failed'
                ? t('remoteFleet.operations.loadFailed', { defaultValue: 'Operations could not be loaded.' })
                : t('remoteFleet.operations.notLoaded', { defaultValue: 'Not loaded yet' })}
            description={loadState === 'failed'
              ? t('remoteFleet.operations.audit.loadFailedDescription', { defaultValue: 'Retry loading audit summaries.' })
              : t('remoteFleet.operations.audit.notLoadedDescription', { defaultValue: 'Open this view to load audit summaries.' })}
          />
          {loadState === 'failed' ? <Button variant="outline" size="sm" onClick={() => { void onLoad().catch(() => undefined); }}>{t('remoteFleet.operations.retry', { defaultValue: 'Retry' })}</Button> : null}
        </div>
      ) : filtered.length === 0 ? (
        <RemoteFleetEmptyPanel icon={<Activity className="h-5 w-5" />} title={t('remoteFleet.operations.audit.emptyTitle')} description={t('remoteFleet.operations.audit.emptyDescription')} />
      ) : (
        <div className="divide-y divide-border/70 border-y border-border/70">
          {filtered.map((event) => (
            <div
              key={event.id}
              className={cn(
                'grid gap-3 py-3',
                layout === 'wide'
                  ? 'grid-cols-[minmax(0,1.1fr)_minmax(9rem,.7fr)_minmax(0,1fr)_minmax(0,1.2fr)]'
                  : layout === 'compact'
                    ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
                    : 'grid-cols-1',
              )}
            >
              <div className="min-w-0 space-y-1">
                <div className="truncate text-sm font-medium">{event.eventName || event.id}</div>
                <RemoteFleetFieldRow label={t('remoteFleet.operations.fields.id')} value={event.id} />
              </div>
              <div className="min-w-0"><Badge variant="outline">{event.occurredAt || t('remoteFleet.operations.audit.unknownTime')}</Badge></div>
              <TargetFields nodeId={event.nodeId} agentId={event.agentId} runtimeId={event.runtimeId} endpointId={event.endpointId} commandId={event.commandId} />
              <HistoryMessage message={event.message} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RemoteFleetOperationsSection({
  metrics,
  commands,
  auditEvents,
  loadingMetrics,
  loadingCommands,
  loadingAuditEvents,
  onLoadMetrics,
  onLoadCommands,
  onLoadAuditEvents,
  layout,
}: RemoteFleetOperationsSectionProps) {
  const { t } = useTranslation('common');
  const [view, setView] = useState<OperationsView>('overview');
  const [commandsLoadState, setCommandsLoadState] = useState<LoadState>('not-loaded');
  const [auditLoadState, setAuditLoadState] = useState<LoadState>('not-loaded');
  const requestedMetricsRef = useRef(false);
  const requestedCommandsRef = useRef(false);
  const requestedAuditRef = useRef(false);

  useEffect(() => {
    if (metrics || loadingMetrics || requestedMetricsRef.current) return;
    requestedMetricsRef.current = true;
    void onLoadMetrics().catch(() => {
      requestedMetricsRef.current = false;
    });
  }, [loadingMetrics, metrics, onLoadMetrics]);

  useEffect(() => {
    if (view !== 'commands' || requestedCommandsRef.current) return;
    requestedCommandsRef.current = true;
    setCommandsLoadState('loading');
    void onLoadCommands()
      .then(() => setCommandsLoadState('loaded'))
      .catch(() => {
        requestedCommandsRef.current = false;
        setCommandsLoadState('failed');
      });
  }, [onLoadCommands, view]);

  useEffect(() => {
    if (view !== 'audit' || requestedAuditRef.current) return;
    requestedAuditRef.current = true;
    setAuditLoadState('loading');
    void onLoadAuditEvents()
      .then(() => setAuditLoadState('loaded'))
      .catch(() => {
        requestedAuditRef.current = false;
        setAuditLoadState('failed');
      });
  }, [onLoadAuditEvents, view]);

  const refreshCommands = async () => {
    setCommandsLoadState('loading');
    try {
      await onLoadCommands();
      requestedCommandsRef.current = true;
      setCommandsLoadState('loaded');
    } catch {
      requestedCommandsRef.current = false;
      setCommandsLoadState('failed');
    }
  };

  const refreshAudit = async () => {
    setAuditLoadState('loading');
    try {
      await onLoadAuditEvents();
      requestedAuditRef.current = true;
      setAuditLoadState('loaded');
    } catch {
      requestedAuditRef.current = false;
      setAuditLoadState('failed');
    }
  };

  const navigationTabs = (
    <div role="tablist" aria-orientation={layout === 'single' ? 'horizontal' : 'vertical'} className={cn(layout === 'single' ? 'flex gap-1 overflow-x-auto' : 'space-y-0.5')}>
      {OPERATIONS_VIEWS.map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={view === item}
          onClick={() => setView(item)}
          className={cn(
            'flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            layout === 'single' ? 'shrink-0' : 'w-full',
            view === item ? 'bg-secondary font-medium text-foreground' : 'hover:bg-muted/60 hover:text-foreground',
          )}
        >
          {operationViewIcon(item)}
          <span className="min-w-0 flex-1 truncate">{operationViewLabel(item, t)}</span>
          {item === 'commands' && commandsLoadState === 'loaded' ? <span className="text-xs tabular-nums">{commands.length}</span> : null}
          {item === 'audit' && auditLoadState === 'loaded' ? <span className="text-xs tabular-nums">{auditEvents.length}</span> : null}
        </button>
      ))}
    </div>
  );

  return (
    <section className={cn('h-full min-h-0 min-w-0 bg-card', layout === 'single' ? 'flex flex-col' : 'grid grid-cols-[minmax(10rem,13rem)_minmax(0,1fr)]')}>
      <nav className={cn('min-h-0 p-3', layout === 'single' ? 'border-b border-border/70' : 'border-r border-border/70')} aria-label={t('remoteFleet.operations.title')}>
        <div className={cn(layout === 'single' ? 'mb-3 flex items-center justify-between gap-3 px-1' : 'mb-4 px-2')}>
          <h2 className="text-sm font-semibold">{t('remoteFleet.operations.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('remoteFleet.operations.fleetWide', { defaultValue: 'Fleet-wide' })}</p>
        </div>
        {navigationTabs}
      </nav>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-5" role="tabpanel">
        <div className="mx-auto w-full max-w-6xl">
          {view === 'overview' ? <OverviewPanel metrics={metrics} loadingMetrics={loadingMetrics} onLoadMetrics={onLoadMetrics} layout={layout} /> : null}
          {view === 'commands' ? <CommandsPanel commands={commands} loading={loadingCommands} loadState={commandsLoadState} layout={layout} onLoad={refreshCommands} /> : null}
          {view === 'audit' ? <AuditPanel auditEvents={auditEvents} loading={loadingAuditEvents} loadState={auditLoadState} layout={layout} onLoad={refreshAudit} /> : null}
        </div>
      </div>
    </section>
  );
}

export default RemoteFleetOperationsSection;
