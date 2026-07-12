import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Plus, RefreshCw, Server } from 'lucide-react';
import { toast } from 'sonner';
import { FeedbackState } from '@/components/common/FeedbackState';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import {
  useRemoteFleetStore,
  type RemoteFleetConnectionRegistration,
  type RemoteFleetConnectionSummary,
  type RemoteFleetCredentialWriteInput,
  type RemoteFleetEndpointSummary,
  type RemoteFleetEnvironmentRegistration,
  type RemoteFleetEnvironmentSummary,
  type RemoteFleetManagedResourceSummary,
  remoteFleetCommandOutcome,
  type RemoteFleetRuntimeSummary,
} from '@/stores/remote-fleet';
import { RemoteFleetDetailPanel } from './components/RemoteFleetDetailPanel';
import { RemoteFleetOperationsSection } from './components/RemoteFleetOperationsSection';
import { RemoteFleetRegistrationSheet } from './components/RemoteFleetRegistrationSheet';
import { RemoteFleetResourceBrowser } from './components/RemoteFleetResourceBrowser';
import { RemoteFleetTerminalDrawer } from './components/RemoteFleetTerminalDrawer';
import type {
  RemoteFleetConsoleSelection,
  RemoteFleetConsoleSelectionKind,
  RemoteFleetDetailTab,
  RemoteFleetPageMode,
  RemoteFleetResourceType,
  RemoteFleetWorkspaceLayout,
} from './components/remote-fleet-console-types';
import type {
  RemoteFleetTerminalConnectionRequest,
  RemoteFleetTerminalDrawerTarget,
} from './components/remote-fleet-terminal-types';

type RemoteFleetSelectionKind = NonNullable<RemoteFleetConsoleSelectionKind>;
type RemoteFleetSinglePane = 'index' | 'detail';
type RemoteFleetDeleteConfirmation =
  | { readonly kind: 'connection'; readonly connection: RemoteFleetConnectionSummary }
  | {
    readonly kind: 'environment';
    readonly environment: RemoteFleetEnvironmentSummary;
    readonly managedResources: readonly RemoteFleetManagedResourceSummary[];
  };

type RemoteFleetInventoryCollections = {
  readonly connections: ReturnType<typeof useRemoteFleetStore.getState>['connections'];
  readonly environments: ReturnType<typeof useRemoteFleetStore.getState>['environments'];
  readonly managedResources: ReturnType<typeof useRemoteFleetStore.getState>['managedResources'];
  readonly nodes: ReturnType<typeof useRemoteFleetStore.getState>['nodes'];
  readonly agents: ReturnType<typeof useRemoteFleetStore.getState>['agents'];
  readonly runtimes: ReturnType<typeof useRemoteFleetStore.getState>['runtimes'];
  readonly endpoints: ReturnType<typeof useRemoteFleetStore.getState>['endpoints'];
};

const REMOTE_FLEET_PAGE_MODES: readonly RemoteFleetPageMode[] = ['resources', 'operations'];
const REMOTE_FLEET_RESOURCE_TYPE_FOR_SELECTION: Record<RemoteFleetSelectionKind, RemoteFleetResourceType> = {
  connection: 'connections',
  environment: 'environments',
  managedResource: 'managedResources',
  node: 'nodes',
  agent: 'agents',
  runtime: 'runtimes',
  endpoint: 'endpoints',
};
const REMOTE_FLEET_SELECTION_KIND_FOR_RESOURCE_TYPE: Record<RemoteFleetResourceType, RemoteFleetSelectionKind> = {
  connections: 'connection',
  environments: 'environment',
  managedResources: 'managedResource',
  nodes: 'node',
  agents: 'agent',
  runtimes: 'runtime',
  endpoints: 'endpoint',
};
const REMOTE_FLEET_SELECTION_ORDER: readonly RemoteFleetSelectionKind[] = [
  'connection',
  'environment',
  'managedResource',
  'agent',
  'runtime',
  'endpoint',
  'node',
];

function itemsForSelectionKind(
  kind: RemoteFleetSelectionKind,
  collections: RemoteFleetInventoryCollections,
): readonly { readonly id: string }[] {
  switch (kind) {
    case 'connection':
      return collections.connections;
    case 'environment':
      return collections.environments;
    case 'managedResource':
      return collections.managedResources;
    case 'agent':
      return collections.agents;
    case 'runtime':
      return collections.runtimes;
    case 'endpoint':
      return collections.endpoints;
    case 'node':
      return collections.nodes;
  }
}

function resolveSelection(
  selection: RemoteFleetConsoleSelection,
  collections: RemoteFleetInventoryCollections,
): RemoteFleetConsoleSelection {
  if (selection.kind) {
    const sameKindItems = itemsForSelectionKind(selection.kind, collections);
    if (!selection.id) {
      return sameKindItems.length > 0
        ? { kind: selection.kind, id: sameKindItems[0]!.id }
        : selection;
    }
    if (sameKindItems.some((item) => item.id === selection.id)) {
      return selection;
    }
    if (sameKindItems.length > 0) {
      return { kind: selection.kind, id: sameKindItems[0]!.id };
    }
  }

  for (const kind of REMOTE_FLEET_SELECTION_ORDER) {
    const items = itemsForSelectionKind(kind, collections);
    if (items.length > 0) {
      return { kind, id: items[0]!.id };
    }
  }

  return { kind: null, id: null };
}

function resolveWorkspaceLayout(width: number): RemoteFleetWorkspaceLayout {
  if (width >= 1160) return 'wide';
  if (width >= 760) return 'compact';
  return 'single';
}

function remoteFleetPageModeLabel(
  mode: RemoteFleetPageMode,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return mode === 'resources'
    ? t('remoteFleet.modes.resources', { defaultValue: 'Resources' })
    : t('remoteFleet.modes.operations', { defaultValue: 'Operations' });
}

export function RemoteFleetPage() {
  const { t } = useTranslation('common');
  const connections = useRemoteFleetStore((state) => state.connections);
  const environments = useRemoteFleetStore((state) => state.environments);
  const managedResources = useRemoteFleetStore((state) => state.managedResources);
  const nodes = useRemoteFleetStore((state) => state.nodes);
  const agents = useRemoteFleetStore((state) => state.agents);
  const runtimes = useRemoteFleetStore((state) => state.runtimes);
  const endpoints = useRemoteFleetStore((state) => state.endpoints);
  const capabilities = useRemoteFleetStore((state) => state.capabilities);
  const commands = useRemoteFleetStore((state) => state.commands);
  const leases = useRemoteFleetStore((state) => state.leases);
  const terminalSessions = useRemoteFleetStore((state) => state.sessions);
  const auditEvents = useRemoteFleetStore((state) => state.auditEvents);
  const metrics = useRemoteFleetStore((state) => state.metrics);
  const ready = useRemoteFleetStore((state) => state.ready);
  const loading = useRemoteFleetStore((state) => state.loading);
  const mutatingAction = useRemoteFleetStore((state) => state.mutatingAction);
  const error = useRemoteFleetStore((state) => state.error);
  const refresh = useRemoteFleetStore((state) => state.refresh);
  const loadMetrics = useRemoteFleetStore((state) => state.loadMetrics);
  const registerConnectionAction = useRemoteFleetStore((state) => state.registerConnection);
  const probeConnectionAction = useRemoteFleetStore((state) => state.probeConnection);
  const registerEnvironmentAction = useRemoteFleetStore((state) => state.registerEnvironment);
  const deployEnvironmentAction = useRemoteFleetStore((state) => state.deployEnvironment);
  const deleteConnectionAction = useRemoteFleetStore((state) => state.deleteConnection);
  const deleteEnvironmentAction = useRemoteFleetStore((state) => state.deleteEnvironment);
  const writeCredentialAction = useRemoteFleetStore((state) => state.writeCredential);
  const removeAction = useRemoteFleetStore((state) => state.remove);
  const probeAction = useRemoteFleetStore((state) => state.probe);
  const installAction = useRemoteFleetStore((state) => state.install);
  const revokeAction = useRemoteFleetStore((state) => state.revoke);
  const startAction = useRemoteFleetStore((state) => state.start);
  const stopAction = useRemoteFleetStore((state) => state.stop);
  const drainAction = useRemoteFleetStore((state) => state.drain);
  const retireAction = useRemoteFleetStore((state) => state.retire);
  const syncAction = useRemoteFleetStore((state) => state.sync);
  const openTerminalAction = useRemoteFleetStore((state) => state.openTerminal);
  const reconnectTerminalAction = useRemoteFleetStore((state) => state.reconnectTerminal);
  const closeTerminalAction = useRemoteFleetStore((state) => state.closeTerminal);
  const listCommands = useRemoteFleetStore((state) => state.listCommands);
  const listAuditEvents = useRemoteFleetStore((state) => state.listAuditEvents);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const singleIndexRef = useRef<HTMLDivElement>(null);
  const singleDetailRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<RemoteFleetPageMode>('resources');
  const [selection, setSelection] = useState<RemoteFleetConsoleSelection>({ kind: null, id: null });
  const [activeResourceType, setActiveResourceType] = useState<RemoteFleetResourceType>('connections');
  const [detailActiveTab, setDetailActiveTab] = useState<RemoteFleetDetailTab>('overview');
  const [singlePane, setSinglePane] = useState<RemoteFleetSinglePane>('index');
  const [workspaceLayout, setWorkspaceLayout] = useState<RemoteFleetWorkspaceLayout>(() => (
    resolveWorkspaceLayout(typeof window === 'undefined' ? 1160 : window.innerWidth)
  ));
  const [terminalTarget, setTerminalTarget] = useState<RemoteFleetTerminalDrawerTarget | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<RemoteFleetDeleteConfirmation | null>(null);
  const [lastSnapshotAt, setLastSnapshotAt] = useState<Date | null>(null);

  const inventoryCollections = useMemo<RemoteFleetInventoryCollections>(() => ({
    connections,
    environments,
    managedResources,
    nodes,
    agents,
    runtimes,
    endpoints,
  }), [agents, connections, endpoints, environments, managedResources, nodes, runtimes]);
  const resolvedSelection = useMemo(
    () => resolveSelection(selection, inventoryCollections),
    [inventoryCollections, selection],
  );
  const resourceCount = connections.length
    + environments.length
    + managedResources.length
    + nodes.length
    + agents.length
    + runtimes.length
    + endpoints.length;
  const hasFleetData = resourceCount > 0;

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const applyWidth = (width: number) => {
      if (width <= 0) return;
      const nextLayout = resolveWorkspaceLayout(Math.round(width));
      setWorkspaceLayout((current) => current === nextLayout ? current : nextLayout);
    };

    applyWidth(workspace.clientWidth);
    if (typeof ResizeObserver !== 'function') return;

    const observer = new ResizeObserver((entries) => {
      applyWidth(entries[0]?.contentRect.width ?? workspace.clientWidth);
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (workspaceLayout !== 'single') {
      setSinglePane('index');
    }
  }, [workspaceLayout]);

  useEffect(() => {
    if (resolvedSelection.kind === selection.kind && resolvedSelection.id === selection.id) return;
    if (selection.kind && !selection.id) return;
    setSelection(resolvedSelection);
  }, [resolvedSelection, selection.id, selection.kind]);

  useEffect(() => {
    if (!resolvedSelection.kind || (selection.kind && !selection.id)) return;
    const resourceType = REMOTE_FLEET_RESOURCE_TYPE_FOR_SELECTION[resolvedSelection.kind];
    if (resourceType !== activeResourceType) {
      setActiveResourceType(resourceType);
    }
  }, [activeResourceType, resolvedSelection.kind, selection.id, selection.kind]);

  useEffect(() => {
    if (workspaceLayout !== 'single' || mode !== 'resources' || !hasFleetData) return;
    const target = singlePane === 'detail' ? singleDetailRef.current : singleIndexRef.current;
    target?.focus({ preventScroll: true });
  }, [hasFleetData, mode, singlePane, workspaceLayout]);

  const refreshProjection = useCallback(async () => {
    try {
      await refresh();
      setLastSnapshotAt(new Date());
    } catch {
      toast.error(t('remoteFleet.toasts.loadFailed'));
    }
  }, [refresh, t]);

  useEffect(() => {
    void refreshProjection();
  }, [refreshProjection]);

  const registerConnection = useCallback(async (connection: RemoteFleetConnectionRegistration) => {
    return await registerConnectionAction(connection);
  }, [registerConnectionAction]);

  const registerEnvironment = useCallback(async (environment: RemoteFleetEnvironmentRegistration) => {
    return await registerEnvironmentAction(environment);
  }, [registerEnvironmentAction]);

  const onProbeConnection = useCallback(async (connectionId: string) => {
    try {
      const payload = await probeConnectionAction(connectionId);
      if (remoteFleetCommandOutcome(payload.command) === 'succeeded') {
        toast.success(t('remoteFleet.toasts.connectionCheckCompleted', { defaultValue: 'Connection check completed' }));
      } else {
        toast.error(t('remoteFleet.toasts.connectionCheckFailed', { defaultValue: 'Connection check failed' }));
      }
    } catch {
      toast.error(t('remoteFleet.toasts.connectionCheckFailed', { defaultValue: 'Connection check failed' }));
    }
  }, [probeConnectionAction, t]);

  const writeCredential = useCallback(async (input: RemoteFleetCredentialWriteInput) => {
    return await writeCredentialAction(input);
  }, [writeCredentialAction]);

  const remove = useCallback(async (nodeId: string) => {
    try {
      await removeAction(nodeId);
      toast.success(t('remoteFleet.toasts.nodeRemoved'));
    } catch {
      toast.error(t('remoteFleet.toasts.nodeRemoveFailed'));
    }
  }, [removeAction, t]);

  const probe = useCallback(async (nodeId: string) => {
    try {
      await probeAction(nodeId);
      toast.success(t('remoteFleet.toasts.probeSubmitted'));
    } catch {
      toast.error(t('remoteFleet.toasts.probeFailed'));
    }
  }, [probeAction, t]);

  const install = useCallback(async (nodeId: string) => {
    try {
      await installAction(nodeId);
      toast.success(t('remoteFleet.toasts.installSubmitted'));
    } catch {
      toast.error(t('remoteFleet.toasts.installFailed'));
    }
  }, [installAction, t]);

  const deployEnvironment = useCallback(async (environmentId: string) => {
    try {
      const payload = await deployEnvironmentAction(environmentId);
      const outcome = remoteFleetCommandOutcome(payload.command);
      if (outcome === 'failed' || outcome === 'missing') {
        toast.error(t('remoteFleet.toasts.environmentDeployFailed'));
        return;
      }
      toast.success(t('remoteFleet.toasts.environmentDeploySubmitted'));
    } catch {
      toast.error(t('remoteFleet.toasts.environmentDeployFailed'));
    }
  }, [deployEnvironmentAction, t]);

  const requestDeleteConnection = useCallback((connection: RemoteFleetConnectionSummary) => {
    setDeleteConfirmation({ kind: 'connection', connection });
  }, []);

  const requestDeleteEnvironment = useCallback((
    environment: RemoteFleetEnvironmentSummary,
    relatedManagedResources: readonly RemoteFleetManagedResourceSummary[],
  ) => {
    setDeleteConfirmation({ kind: 'environment', environment, managedResources: relatedManagedResources });
  }, []);

  const confirmDelete = useCallback(async () => {
    const confirmation = deleteConfirmation;
    if (!confirmation) return;

    if (confirmation.kind === 'connection') {
      try {
        const payload = await deleteConnectionAction(confirmation.connection.id);
        if (!payload.snapshot || payload.snapshot.connections?.some((connection) => connection.id === confirmation.connection.id)) {
          setDeleteConfirmation(null);
          toast.error(t('remoteFleet.toasts.connectionDeleteFailed', { defaultValue: 'Failed to delete connection' }));
          return;
        }
        setDeleteConfirmation(null);
        toast.success(t('remoteFleet.toasts.connectionDeleted', { defaultValue: 'Connection deleted' }));
      } catch {
        setDeleteConfirmation(null);
        toast.error(t('remoteFleet.toasts.connectionDeleteFailed', { defaultValue: 'Failed to delete connection' }));
      }
      return;
    }

    try {
      const payload = await deleteEnvironmentAction(confirmation.environment.id);
      if (!payload.snapshot || payload.snapshot.environments?.some((environment) => environment.id === confirmation.environment.id)) {
        setDeleteConfirmation(null);
        toast.error(t('remoteFleet.toasts.environmentDeleteIncomplete', { defaultValue: 'Environment was not deleted because remote resource cleanup did not complete. The environment was kept.' }));
        return;
      }
      setDeleteConfirmation(null);
      if (confirmation.managedResources.some((resource) => (
        resource.ownership !== 'matcha-managed' || resource.cleanupPolicy !== 'delete-on-environment-delete'
      ))) {
        toast.warning(t('remoteFleet.toasts.environmentDeletedRemoteResourcesUnchanged', { defaultValue: 'Environment deleted. Some remote resources were left unchanged.' }));
        return;
      }
      toast.success(t('remoteFleet.toasts.environmentDeleted', { defaultValue: 'Environment deleted' }));
    } catch {
      setDeleteConfirmation(null);
      toast.error(t('remoteFleet.toasts.environmentDeleteFailed', { defaultValue: 'Failed to delete environment' }));
    }
  }, [deleteConfirmation, deleteConnectionAction, deleteEnvironmentAction, t]);

  const revoke = useCallback(async (agentId: string) => {
    try {
      await revokeAction(agentId);
      toast.success(t('remoteFleet.toasts.agentRevoked'));
    } catch {
      toast.error(t('remoteFleet.toasts.agentRevokeFailed'));
    }
  }, [revokeAction, t]);

  const start = useCallback(async (runtime: RemoteFleetRuntimeSummary) => {
    try {
      await startAction(runtime);
      toast.success(t('remoteFleet.toasts.startSubmitted'));
    } catch {
      toast.error(t('remoteFleet.toasts.startFailed'));
    }
  }, [startAction, t]);

  const stop = useCallback(async (runtime: RemoteFleetRuntimeSummary) => {
    try {
      await stopAction(runtime);
      toast.success(t('remoteFleet.toasts.stopSubmitted'));
    } catch {
      toast.error(t('remoteFleet.toasts.stopFailed'));
    }
  }, [stopAction, t]);

  const drain = useCallback(async (endpointId: string) => {
    try {
      await drainAction(endpointId);
      toast.success(t('remoteFleet.toasts.drainSubmitted'));
    } catch {
      toast.error(t('remoteFleet.toasts.drainFailed'));
    }
  }, [drainAction, t]);

  const retire = useCallback(async (endpointId: string) => {
    try {
      await retireAction(endpointId);
      toast.success(t('remoteFleet.toasts.retireSubmitted'));
    } catch {
      toast.error(t('remoteFleet.toasts.retireFailed'));
    }
  }, [retireAction, t]);

  const sync = useCallback(async (endpoint: RemoteFleetEndpointSummary) => {
    try {
      await syncAction(endpoint);
      toast.success(t('remoteFleet.toasts.syncSubmitted'));
    } catch {
      toast.error(t('remoteFleet.toasts.syncFailed'));
    }
  }, [syncAction, t]);

  const openTerminal = useCallback(async (request: RemoteFleetTerminalConnectionRequest) => {
    return await openTerminalAction({ ...request.target.openTarget, size: request.size });
  }, [openTerminalAction]);

  const reconnectTerminal = useCallback(async (sessionId: string) => {
    return await reconnectTerminalAction(sessionId);
  }, [reconnectTerminalAction]);

  const closeTerminal = useCallback(async (sessionId: string, reason?: string) => {
    await closeTerminalAction(sessionId, reason);
  }, [closeTerminalAction]);

  const loadOperationsMetrics = useCallback(async () => {
    try {
      await loadMetrics();
    } catch (error) {
      toast.error(t('remoteFleet.toasts.metricsFailed'));
      throw error;
    }
  }, [loadMetrics, t]);

  const loadCommandHistory = useCallback(async () => {
    try {
      await listCommands();
    } catch (error) {
      toast.error(t('remoteFleet.toasts.commandsFailed'));
      throw error;
    }
  }, [listCommands, t]);

  const loadAuditHistory = useCallback(async () => {
    try {
      await listAuditEvents();
    } catch (error) {
      toast.error(t('remoteFleet.toasts.auditFailed'));
      throw error;
    }
  }, [listAuditEvents, t]);

  const changeActiveResourceType = useCallback((type: RemoteFleetResourceType) => {
    setActiveResourceType(type);
    setSelection({ kind: REMOTE_FLEET_SELECTION_KIND_FOR_RESOURCE_TYPE[type], id: null });
  }, []);

  const selectFromIndex = useCallback((nextSelection: RemoteFleetConsoleSelection) => {
    setSelection(nextSelection);
    if (nextSelection.kind) {
      setActiveResourceType(REMOTE_FLEET_RESOURCE_TYPE_FOR_SELECTION[nextSelection.kind]);
    }
    if (workspaceLayout === 'single') {
      setSinglePane('detail');
    }
  }, [workspaceLayout]);

  const backToResourceIndex = useCallback(() => {
    setSinglePane('index');
  }, []);

  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<RemoteFleetConnectionSummary | undefined>();

  const openRegistration = useCallback(() => {
    setEditingConnection(undefined);
    setRegistrationOpen(true);
  }, []);

  const openConnectionEdit = useCallback((connection: RemoteFleetConnectionSummary) => {
    setEditingConnection(connection);
    setRegistrationOpen(true);
  }, []);

  const updateRegistrationOpen = useCallback((open: boolean) => {
    setRegistrationOpen(open);
    if (!open) {
      setEditingConnection(undefined);
    }
  }, []);

  const registrationSheet = (
    <RemoteFleetRegistrationSheet
      open={registrationOpen}
      onOpenChange={updateRegistrationOpen}
      editingConnection={editingConnection}
      connections={connections}
      onRegisterConnection={registerConnection}
      onRegisterEnvironment={registerEnvironment}
      onDeployEnvironment={deployEnvironmentAction}
      onWriteCredential={writeCredential}
      mutating={mutatingAction?.startsWith('register:')
        || mutatingAction?.startsWith('register-connection:')
        || mutatingAction?.startsWith('register-environment:')
        || mutatingAction?.startsWith('deploy-environment:')
        || mutatingAction?.startsWith('write-credential:')
        || false}
    />
  );

  const detailPanel = (
    <RemoteFleetDetailPanel
      selection={resolvedSelection}
      activeTab={detailActiveTab}
      onActiveTabChange={setDetailActiveTab}
      loading={loading && !ready}
      mutatingAction={mutatingAction}
      connections={connections}
      environments={environments}
      managedResources={managedResources}
      nodes={nodes}
      agents={agents}
      runtimes={runtimes}
      endpoints={endpoints}
      capabilities={capabilities}
      commands={commands}
      leases={leases}
      terminalSessions={terminalSessions}
      auditEvents={auditEvents}
      showBackAction={workspaceLayout === 'single'}
      onBackToIndex={backToResourceIndex}
      onProbe={probe}
      onProbeConnection={onProbeConnection}
      onEditConnection={openConnectionEdit}
      onRequestDeleteConnection={requestDeleteConnection}
      onRemove={remove}
      onInstallAgent={install}
      onDeployEnvironment={deployEnvironment}
      onRequestDeleteEnvironment={requestDeleteEnvironment}
      onRevokeAgent={revoke}
      onStart={start}
      onStop={stop}
      onOpenTerminal={setTerminalTarget}
      onDrainEndpoint={drain}
      onRetireEndpoint={retire}
      onSyncCapabilities={sync}
    />
  );

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-[1800px] flex-col gap-3">
      <header className="flex min-h-16 flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-card px-4 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background">
            <Server className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight">
              {t('remoteFleet.header.title')}
            </h1>
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className={cn('h-1.5 w-1.5 rounded-full', ready ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
              <span className="truncate">
                {ready
                  ? lastSnapshotAt
                    ? t('remoteFleet.workspace.syncedAt', {
                      defaultValue: 'Synced {{time}}',
                      time: lastSnapshotAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    })
                    : t('remoteFleet.header.snapshotReady')
                  : loading
                    ? t('remoteFleet.header.snapshotLoading')
                    : t('remoteFleet.header.snapshotIdle')}
              </span>
              {hasFleetData ? <span aria-hidden="true">·</span> : null}
              {hasFleetData ? (
                <span>{t('remoteFleet.workspace.resourceCount', { defaultValue: '{{count}} resources', count: resourceCount })}</span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex h-9 items-center rounded-full bg-muted/70 p-1" role="tablist" aria-label={t('remoteFleet.modes.label')}>
          {REMOTE_FLEET_PAGE_MODES.map((pageMode) => (
            <button
              key={pageMode}
              type="button"
              role="tab"
              aria-selected={mode === pageMode}
              onClick={() => setMode(pageMode)}
              className={cn(
                'h-7 rounded-full px-3 text-xs font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                mode === pageMode && 'bg-card text-foreground shadow-sm',
              )}
            >
              {remoteFleetPageModeLabel(pageMode, t)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void refreshProjection()} disabled={loading}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            <span className="hidden xl:inline">{t('remoteFleet.header.refreshSnapshot')}</span>
          </Button>
          <Button size="sm" onClick={openRegistration}>
            <Plus className="h-4 w-4" />
            {t('remoteFleet.workspace.addRemote', { defaultValue: 'Add remote' })}
          </Button>
        </div>
      </header>

      {error ? (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-destructive/45 bg-destructive/10 px-3 py-2 text-sm text-foreground">
          <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      ) : null}

      <div ref={workspaceRef} className="min-h-0 flex-1 overflow-hidden">
        {mode === 'resources' ? (
          !hasFleetData ? (
            <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto rounded-2xl border border-border/70 bg-card px-6">
              <FeedbackState
                state={loading && !ready ? 'loading' : 'empty'}
                title={loading && !ready
                  ? t('remoteFleet.detail.loadingDescription')
                  : t('remoteFleet.workspace.emptyTitle', { defaultValue: 'Connect your first remote environment' })}
                description={loading && !ready
                  ? undefined
                  : t('remoteFleet.workspace.emptyDescription', { defaultValue: 'Add an SSH host, Docker daemon, Kubernetes cluster, or VM to start managing remote runtimes.' })}
                action={loading && !ready ? undefined : (
                  <Button onClick={openRegistration}>
                    <Plus className="h-4 w-4" />
                    {t('remoteFleet.workspace.addConnection', { defaultValue: 'Add connection' })}
                  </Button>
                )}
              />
            </div>
          ) : workspaceLayout === 'single' ? (
            <div className="h-full min-h-0 overflow-hidden rounded-2xl border border-border/70 bg-card">
              {singlePane === 'index' ? (
                <div ref={singleIndexRef} tabIndex={-1} className="h-full min-h-0 focus:outline-none">
                  <RemoteFleetResourceBrowser
                    layout="single"
                    activeType={activeResourceType}
                    onActiveTypeChange={changeActiveResourceType}
                    connections={connections}
                    environments={environments}
                    managedResources={managedResources}
                    nodes={nodes}
                    agents={agents}
                    runtimes={runtimes}
                    endpoints={endpoints}
                    selected={resolvedSelection}
                    onSelect={selectFromIndex}
                  />
                </div>
              ) : (
                <div ref={singleDetailRef} tabIndex={-1} className="flex h-full min-h-0 focus:outline-none">
                  {detailPanel}
                </div>
              )}
            </div>
          ) : (
            <div
              className={cn(
                'grid h-full min-h-0 overflow-hidden rounded-2xl border border-border/70 bg-card',
                workspaceLayout === 'wide'
                  ? 'grid-cols-[minmax(27rem,35rem)_minmax(0,1fr)]'
                  : 'grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]',
              )}
            >
              <RemoteFleetResourceBrowser
                layout={workspaceLayout}
                activeType={activeResourceType}
                onActiveTypeChange={changeActiveResourceType}
                connections={connections}
                environments={environments}
                managedResources={managedResources}
                nodes={nodes}
                agents={agents}
                runtimes={runtimes}
                endpoints={endpoints}
                selected={resolvedSelection}
                onSelect={selectFromIndex}
              />
              <div className="flex min-h-0 min-w-0">{detailPanel}</div>
            </div>
          )
        ) : (
          <div className="h-full min-h-0 overflow-hidden rounded-2xl border border-border/70 bg-card">
            <RemoteFleetOperationsSection
              metrics={metrics}
              commands={commands}
              auditEvents={auditEvents}
              loadingMetrics={mutatingAction === 'load-metrics'}
              loadingCommands={mutatingAction === 'list-commands'}
              loadingAuditEvents={mutatingAction === 'list-audit-events'}
              onLoadMetrics={loadOperationsMetrics}
              onLoadCommands={loadCommandHistory}
              onLoadAuditEvents={loadAuditHistory}
              layout={workspaceLayout}
            />
          </div>
        )}
      </div>

      {registrationSheet}

      <ConfirmDialog
        open={deleteConfirmation !== null}
        title={deleteConfirmation?.kind === 'connection'
          ? t('remoteFleet.detail.confirmDeleteConnectionTitle', { defaultValue: 'Delete connection?' })
          : t('remoteFleet.detail.confirmDeleteEnvironmentTitle', { defaultValue: 'Delete environment?' })}
        message={deleteConfirmation?.kind === 'connection'
          ? t('remoteFleet.detail.confirmDeleteConnectionMessage', { defaultValue: 'Only the local connection configuration will be deleted. Remote resources will not be affected.' })
          : (() => {
            const managedCount = deleteConfirmation?.managedResources.filter((resource) => (
              resource.ownership === 'matcha-managed' && resource.cleanupPolicy === 'delete-on-environment-delete'
            )).length ?? 0;
            const retainedCount = (deleteConfirmation?.managedResources.length ?? 0) - managedCount;
            return retainedCount > 0
              ? `${t('remoteFleet.detail.confirmDeleteEnvironmentMessage', { defaultValue: 'Remove this environment from MatchaClaw and delete {{count}} managed remote resources selected for deletion.', count: managedCount })} ${t('remoteFleet.detail.confirmDeleteEnvironmentUnchangedMessage', { defaultValue: '{{count}} other remote resources will be left unchanged.', count: retainedCount })}`
              : managedCount > 0
                ? t('remoteFleet.detail.confirmDeleteEnvironmentMessage', { defaultValue: 'Remove this environment from MatchaClaw and delete {{count}} managed remote resources selected for deletion.', count: managedCount })
                : t('remoteFleet.detail.confirmDeleteEnvironmentNoRemoteResourcesMessage', { defaultValue: 'Remove this environment from MatchaClaw. No remote resources will be deleted.' });
          })()}
        confirmLabel={deleteConfirmation?.kind === 'connection'
          ? t('remoteFleet.detail.confirmDeleteConnectionLabel', { defaultValue: 'Delete connection' })
          : t('remoteFleet.detail.confirmDeleteEnvironmentLabel', { defaultValue: 'Delete environment' })}
        cancelLabel={t('actions.cancel', { defaultValue: 'Cancel' })}
        variant="destructive"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteConfirmation(null)}
      />

      <RemoteFleetTerminalDrawer
        open={terminalTarget !== null}
        target={terminalTarget}
        onOpenChange={(open) => { if (!open) setTerminalTarget(null); }}
        openTerminal={openTerminal}
        reconnectTerminal={reconnectTerminal}
        closeTerminal={closeTerminal}
      />
    </section>
  );
}

export default RemoteFleetPage;
