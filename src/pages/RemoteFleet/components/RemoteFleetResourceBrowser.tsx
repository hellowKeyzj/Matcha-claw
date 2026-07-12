import { useDeferredValue, useMemo, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Boxes,
  CircleDot,
  Database,
  Network,
  Search,
  Server,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type {
  RemoteFleetAgentSummary,
  RemoteFleetConnectionSummary,
  RemoteFleetEndpointSummary,
  RemoteFleetEnvironmentSummary,
  RemoteFleetManagedResourceSummary,
  RemoteFleetNodeSummary,
  RemoteFleetRuntimeSummary,
} from '@/stores/remote-fleet';
import type {
  RemoteFleetConsoleSelection,
  RemoteFleetResourceType,
  RemoteFleetWorkspaceLayout,
} from './remote-fleet-console-types';
import {
  RemoteFleetProviderBadge,
  RemoteFleetStatusBadge,
  remoteFleetStatusLabel,
  safeRemoteFleetDisplayValue,
  safeRemoteFleetTitle,
  shortenRemoteFleetValue,
} from './remote-fleet-console-shared';

type ResourceItem = {
  readonly id: string;
  readonly title: string;
  readonly context?: string;
  readonly status?: string;
  readonly kind?: string;
  readonly environmentId?: string;
  readonly labels?: readonly string[];
  readonly timestamp?: string;
};

type ResourceTypeDefinition = {
  readonly type: RemoteFleetResourceType;
  readonly icon: ComponentType<{ className?: string }>;
  readonly group: 'infrastructure' | 'execution';
};

const RESOURCE_TYPE_DEFINITIONS: readonly ResourceTypeDefinition[] = [
  { type: 'connections', icon: Server, group: 'infrastructure' },
  { type: 'environments', icon: Boxes, group: 'infrastructure' },
  { type: 'managedResources', icon: Database, group: 'infrastructure' },
  { type: 'nodes', icon: Server, group: 'infrastructure' },
  { type: 'agents', icon: Bot, group: 'execution' },
  { type: 'runtimes', icon: CircleDot, group: 'execution' },
  { type: 'endpoints', icon: Network, group: 'execution' },
];

function selectionKindForResourceType(type: RemoteFleetResourceType): NonNullable<RemoteFleetConsoleSelection['kind']> {
  switch (type) {
    case 'connections': return 'connection';
    case 'environments': return 'environment';
    case 'managedResources': return 'managedResource';
    case 'nodes': return 'node';
    case 'agents': return 'agent';
    case 'runtimes': return 'runtime';
    case 'endpoints': return 'endpoint';
  }
}

function resourceTypeLabel(type: RemoteFleetResourceType, t: (key: string, options?: Record<string, unknown>) => string): string {
  switch (type) {
    case 'connections': return t('remoteFleet.inventory.tabs.connections', { defaultValue: 'Connections' });
    case 'environments': return t('remoteFleet.inventory.tabs.environments', { defaultValue: 'Environments' });
    case 'managedResources': return t('remoteFleet.inventory.tabs.managedResources', { defaultValue: 'Resources' });
    case 'nodes': return t('remoteFleet.inventory.tabs.nodes', { defaultValue: 'Nodes' });
    case 'agents': return t('remoteFleet.inventory.tabs.agents', { defaultValue: 'Agents' });
    case 'runtimes': return t('remoteFleet.inventory.tabs.runtimes', { defaultValue: 'Runtimes' });
    case 'endpoints': return t('remoteFleet.inventory.tabs.endpoints', { defaultValue: 'Endpoints' });
  }
}

function buildResourceItems(input: Pick<RemoteFleetResourceBrowserProps,
  'activeType' | 'connections' | 'environments' | 'managedResources' | 'nodes' | 'agents' | 'runtimes' | 'endpoints'
>): readonly ResourceItem[] {
  const environmentNames = new Map(input.environments.map((item) => [item.id, item.displayName || item.description || item.id]));
  const connectionNames = new Map(input.connections.map((item) => [item.id, item.displayName || item.endpointUrl || item.id]));

  switch (input.activeType) {
    case 'connections':
      return input.connections.map((item) => ({
        id: item.id,
        title: item.displayName || item.endpointUrl || item.id,
        context: item.endpointUrl || item.description || item.reason,
        status: item.status,
        kind: item.connectionKind ?? item.targetKind,
        labels: item.labels,
        timestamp: item.lastSeenAt ?? item.updatedAt,
      }));
    case 'environments':
      return input.environments.map((item) => ({
        id: item.id,
        title: item.displayName || item.description || item.id,
        context: connectionNames.get(item.connectionId) || item.reason,
        status: item.status,
        kind: item.environmentKind ?? item.targetKind,
        environmentId: item.id,
        labels: item.labels,
        timestamp: item.updatedAt,
      }));
    case 'managedResources':
      return input.managedResources.map((item) => ({
        id: item.id,
        title: item.displayName || item.remoteResourceId || item.id,
        context: environmentNames.get(item.environmentId) || item.reason,
        status: item.status,
        kind: item.resourceKind ?? item.providerKind,
        environmentId: item.environmentId,
        labels: item.labels,
        timestamp: item.lastObservedAt ?? item.updatedAt,
      }));
    case 'nodes':
      return input.nodes.map((item) => ({
        id: item.id,
        title: item.displayName || item.endpointUrl || item.id,
        context: item.endpointUrl || environmentNames.get(item.environmentId ?? '') || connectionNames.get(item.connectionId ?? '') || item.description || item.reason,
        status: item.status,
        kind: item.targetKind,
        environmentId: item.environmentId,
        labels: item.labels,
        timestamp: item.lastSeenAt,
      }));
    case 'agents':
      return input.agents.map((item) => ({
        id: item.id,
        title: item.displayName || item.id,
        context: item.model || item.nodeId,
        status: item.status,
        environmentId: item.environmentId,
        labels: item.capabilities,
      }));
    case 'runtimes':
      return input.runtimes.map((item) => ({
        id: item.id,
        title: item.displayName || item.id,
        context: item.agentId || item.nodeId || item.reason,
        status: item.status,
        environmentId: item.environmentId,
        timestamp: item.startedAt,
      }));
    case 'endpoints':
      return input.endpoints.map((item) => ({
        id: item.id,
        title: item.id,
        context: item.url || item.runtimeId,
        status: item.status,
        kind: item.protocol,
        environmentId: item.environmentId,
        labels: item.labels,
        timestamp: item.lastProbeAt,
      }));
  }
}

function searchableResourceText(item: ResourceItem): string {
  return [item.title, item.id, item.context, item.status, item.kind, ...(item.labels ?? [])]
    .filter(Boolean)
    .map((value) => safeRemoteFleetDisplayValue(String(value)))
    .join('\n')
    .toLocaleLowerCase();
}

function countForType(type: RemoteFleetResourceType, props: RemoteFleetResourceBrowserProps): number {
  switch (type) {
    case 'connections': return props.connections.length;
    case 'environments': return props.environments.length;
    case 'managedResources': return props.managedResources.length;
    case 'nodes': return props.nodes.length;
    case 'agents': return props.agents.length;
    case 'runtimes': return props.runtimes.length;
    case 'endpoints': return props.endpoints.length;
  }
}

export interface RemoteFleetResourceBrowserProps {
  readonly connections: readonly RemoteFleetConnectionSummary[];
  readonly environments: readonly RemoteFleetEnvironmentSummary[];
  readonly managedResources: readonly RemoteFleetManagedResourceSummary[];
  readonly nodes: readonly RemoteFleetNodeSummary[];
  readonly agents: readonly RemoteFleetAgentSummary[];
  readonly runtimes: readonly RemoteFleetRuntimeSummary[];
  readonly endpoints: readonly RemoteFleetEndpointSummary[];
  readonly selected: RemoteFleetConsoleSelection;
  readonly activeType: RemoteFleetResourceType;
  readonly layout: RemoteFleetWorkspaceLayout;
  readonly onActiveTypeChange: (type: RemoteFleetResourceType) => void;
  readonly onSelect: (selection: RemoteFleetConsoleSelection) => void;
}

export function RemoteFleetResourceBrowser(props: RemoteFleetResourceBrowserProps) {
  const { t } = useTranslation('common');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [statusFilter, setStatusFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');
  const [environmentFilter, setEnvironmentFilter] = useState('all');

  const { activeType, agents, connections, endpoints, environments, managedResources, nodes, runtimes } = props;
  const items = useMemo(() => buildResourceItems({
    activeType,
    agents,
    connections,
    endpoints,
    environments,
    managedResources,
    nodes,
    runtimes,
  }), [activeType, agents, connections, endpoints, environments, managedResources, nodes, runtimes]);
  const statuses = useMemo(() => [...new Set(items.map((item) => item.status).filter(Boolean) as string[])].sort(), [items]);
  const kinds = useMemo(() => [...new Set(
    items
      .map((item) => item.kind && safeRemoteFleetDisplayValue(item.kind))
      .filter(Boolean) as string[],
  )].sort(), [items]);
  const environmentIds = useMemo(() => new Set(environments.map((environment) => environment.id)), [environments]);
  const supportsEnvironmentFilter = activeType !== 'connections' && activeType !== 'environments';
  const activeStatusFilter = statuses.includes(statusFilter) ? statusFilter : 'all';
  const activeKindFilter = kinds.includes(kindFilter) ? kindFilter : 'all';
  const activeEnvironmentFilter = supportsEnvironmentFilter && environmentIds.has(environmentFilter)
    ? environmentFilter
    : 'all';

  const filteredItems = useMemo(() => items
    .filter((item) => !deferredQuery || searchableResourceText(item).includes(deferredQuery))
    .filter((item) => activeStatusFilter === 'all' || item.status === activeStatusFilter)
    .filter((item) => activeKindFilter === 'all' || safeRemoteFleetDisplayValue(item.kind ?? '') === activeKindFilter)
    .filter((item) => activeEnvironmentFilter === 'all' || item.environmentId === activeEnvironmentFilter)
    .sort((left, right) => left.title.localeCompare(right.title)), [
    activeEnvironmentFilter,
    activeKindFilter,
    activeStatusFilter,
    deferredQuery,
    items,
  ]);
  const hasFilters = Boolean(query.trim() || activeStatusFilter !== 'all' || activeKindFilter !== 'all' || activeEnvironmentFilter !== 'all');
  const selectedKind = selectionKindForResourceType(props.activeType);

  const selectType = (type: RemoteFleetResourceType) => {
    props.onActiveTypeChange(type);
    setStatusFilter('all');
    setKindFilter('all');
    setEnvironmentFilter('all');
  };

  const clearFilters = () => {
    setQuery('');
    setStatusFilter('all');
    setKindFilter('all');
    setEnvironmentFilter('all');
  };

  const typeSelector = (
    <Select
      aria-label={t('remoteFleet.resourceBrowser.types', { defaultValue: 'Resource types' })}
      value={props.activeType}
      onChange={(event) => selectType(event.target.value as RemoteFleetResourceType)}
      className="h-9 rounded-lg px-3 pr-9 text-sm"
    >
      {RESOURCE_TYPE_DEFINITIONS.map(({ type }) => (
        <option key={type} value={type}>{resourceTypeLabel(type, t)} ({countForType(type, props)})</option>
      ))}
    </Select>
  );

  return (
    <div className={cn(
      'grid h-full min-h-0 min-w-0 bg-card',
      props.layout === 'wide' ? 'grid-cols-[minmax(10rem,13rem)_minmax(17rem,22rem)]' : 'grid-cols-1',
    )}>
      {props.layout === 'wide' ? (
        <nav className="min-h-0 border-r border-border/70 p-3" aria-label={t('remoteFleet.resourceBrowser.types', { defaultValue: 'Resource types' })}>
          {(['infrastructure', 'execution'] as const).map((group) => (
            <div key={group} className="mb-5 last:mb-0">
              <div className="mb-1.5 px-2 text-xs font-medium text-muted-foreground">
                {t(`remoteFleet.resourceBrowser.groups.${group}`, { defaultValue: group === 'infrastructure' ? 'Infrastructure' : 'Execution' })}
              </div>
              <div className="space-y-0.5">
                {RESOURCE_TYPE_DEFINITIONS.filter((definition) => definition.group === group).map(({ type, icon: Icon }) => (
                  <button
                    key={type}
                    type="button"
                    aria-current={props.activeType === type ? 'page' : undefined}
                    onClick={() => selectType(type)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      props.activeType === type ? 'bg-secondary font-medium text-foreground' : 'hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{resourceTypeLabel(type, t)}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">{countForType(type, props)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
      ) : null}

      <section className="flex min-h-0 min-w-0 flex-col" aria-labelledby="remote-fleet-resource-index-title">
        <div className="shrink-0 border-b border-border/70 px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 id="remote-fleet-resource-index-title" className="truncate text-sm font-semibold">
                {t('remoteFleet.resourceBrowser.index', { defaultValue: 'Resource index' })}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground" role="status" aria-live="polite">
                {t('remoteFleet.resourceBrowser.resultCount', { defaultValue: '{{visible}} of {{total}}', visible: filteredItems.length, total: items.length })}
              </p>
            </div>
            <Badge variant="outline">{resourceTypeLabel(props.activeType, t)}</Badge>
          </div>
          {props.layout !== 'wide' ? <div className="mt-3">{typeSelector}</div> : null}
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('remoteFleet.resourceBrowser.searchPlaceholder', { defaultValue: 'Search name, ID, URL, or label' })}
              aria-label={t('remoteFleet.resourceBrowser.search', { defaultValue: 'Search resources' })}
              className="h-9 rounded-lg pl-9 text-sm"
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Select aria-label={t('remoteFleet.resourceBrowser.statusFilter', { defaultValue: 'Status filter' })} value={activeStatusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="h-8 rounded-lg px-2.5 pr-8 text-xs">
              <option value="all">{t('remoteFleet.resourceBrowser.allStatuses', { defaultValue: 'All statuses' })}</option>
              {statuses.map((status) => <option key={status} value={status}>{remoteFleetStatusLabel(status, t)}</option>)}
            </Select>
            <Select aria-label={t('remoteFleet.resourceBrowser.kindFilter', { defaultValue: 'Kind filter' })} value={activeKindFilter} onChange={(event) => setKindFilter(event.target.value)} className="h-8 rounded-lg px-2.5 pr-8 text-xs">
              <option value="all">{t('remoteFleet.resourceBrowser.allKinds', { defaultValue: 'All kinds' })}</option>
              {kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </Select>
            {supportsEnvironmentFilter ? (
              <Select aria-label={t('remoteFleet.resourceBrowser.environmentFilter', { defaultValue: 'Environment filter' })} value={activeEnvironmentFilter} onChange={(event) => setEnvironmentFilter(event.target.value)} className="h-8 rounded-lg px-2.5 pr-8 text-xs">
                <option value="all">{t('remoteFleet.resourceBrowser.allEnvironments', { defaultValue: 'All environments' })}</option>
                {props.environments.map((environment) => {
                  const label = environment.displayName || environment.description || environment.id;
                  return <option key={environment.id} value={environment.id}>{safeRemoteFleetDisplayValue(label)}</option>;
                })}
              </Select>
            ) : <div />}
          </div>
          {hasFilters ? (
            <Button variant="ghost" size="sm" className="mt-1 h-8 px-2" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" />
              {t('remoteFleet.resourceBrowser.clearFilters', { defaultValue: 'Clear filters' })}
            </Button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {filteredItems.length === 0 ? (
            <div className="flex h-full min-h-52 flex-col items-center justify-center px-6 text-center">
              <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
              <div className="mt-3 text-sm font-medium">{t('remoteFleet.resourceBrowser.emptyTitle', { defaultValue: 'No matching resources' })}</div>
              <p className="mt-1 max-w-64 text-xs leading-relaxed text-muted-foreground">
                {hasFilters
                  ? t('remoteFleet.resourceBrowser.emptyFilteredDescription', { defaultValue: 'Change or clear the filters to see more resources.' })
                  : t('remoteFleet.resourceBrowser.emptyTypeDescription', { defaultValue: 'Resources of this type will appear here.' })}
              </p>
              {hasFilters ? <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>{t('remoteFleet.resourceBrowser.clearFilters', { defaultValue: 'Clear filters' })}</Button> : null}
            </div>
          ) : (
            <div className="divide-y divide-border/70">
              {filteredItems.map((item) => {
                const selected = props.selected.kind === selectedKind && props.selected.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => props.onSelect({ kind: selectedKind, id: item.id })}
                    className={cn(
                      'group w-full px-3 py-3 text-left transition-colors focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      selected ? 'bg-secondary/80' : 'hover:bg-muted/45',
                    )}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-sm font-medium" title={safeRemoteFleetTitle(item.title)}>{safeRemoteFleetDisplayValue(item.title)}</span>
                          <RemoteFleetStatusBadge status={item.status} />
                        </div>
                        {item.context ? <p className="mt-1 truncate text-xs text-muted-foreground" title={safeRemoteFleetTitle(item.context)}>{shortenRemoteFleetValue(item.context)}</p> : null}
                        <div className="mt-1.5 flex min-w-0 items-center gap-2">
                          {item.kind ? <RemoteFleetProviderBadge label={item.kind} /> : null}
                          {item.timestamp ? <span className="min-w-0 truncate text-[11px] text-muted-foreground">{shortenRemoteFleetValue(item.timestamp)}</span> : null}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export default RemoteFleetResourceBrowser;
