import { isTraceEnabled } from '@/lib/trace-logger';
import { Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Plus, Radio, RefreshCw, Trash2, Loader2, AlertCircle, UserCheck, Settings } from 'lucide-react';
import { ChannelIcon } from './ChannelIcon';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useChannelsStore } from './store';
import { useGatewayStore } from '@/plugins/runtime/store';
import { RuntimeScopeSelector } from '@/plugins/runtime/RuntimeScopeSelector';
import { useRuntimeEndpointsStore, selectManagementEndpoint, isRuntimeEndpointReady, isRuntimeEndpointStarting } from '@/plugins/runtime/directory';
import { buildCapabilityScopeKey, runtimeInstanceScope, runtimeEndpointsEqual, type RuntimeInstanceScope } from '@/types/desktop/runtime-address';
import { StatusBadge, type Status } from '@/components/common/StatusBadge';
import { logChannelTrace } from './channel-runtime';
import { subscribeHostEvent } from '@/lib/host-events';
import { isGatewayOperational, isGatewayPreparing } from '@/plugins/runtime/gateway-status';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { cn } from '@/lib/utils';
import type { ChannelType, Channel } from '@/types/channel';
import { useTranslation } from 'react-i18next';
import { useContributions } from '@/plugin-host/react';
import { channelConnectionLabelKey, channelPresentations, type ChannelPresentation, type ChannelDialogTarget } from './extensions';
import { ChannelCatalogDialog } from './ChannelCatalogDialog';

const CHANNELS_EVENT_REFRESH_COOLDOWN_MS = 400;
const CHANNELS_STATUS_POLL_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function Channels() {
  const { t } = useTranslation('channels');
  const endpoint = useRuntimeEndpointsStore(selectManagementEndpoint);
  const scope = useMemo(() => endpoint?.kind === 'native-runtime' && ['openclaw', 'matcha-agent'].includes(endpoint.runtimeAdapterId) ? runtimeInstanceScope(endpoint) : null, [endpoint]);
  useEffect(() => { useChannelsStore.getState().selectScope(scope); }, [scope]);
  if (!scope) return (
    <div className="space-y-4">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-[-0.035em] text-foreground">{t('title')}</h1>
        <RuntimeScopeSelector />
      </div>
      <p className="text-sm text-muted-foreground">请选择运行时。</p>
    </div>
  );
  return <ChannelsForRuntime key={buildCapabilityScopeKey(scope)} scope={scope} />;
}

function ChannelsForRuntime({ scope }: { scope: RuntimeInstanceScope }) {
  const { t } = useTranslation('channels');
  const channels = useChannelsStore((state) => state.channels);
  const snapshotReady = useChannelsStore((state) => state.snapshotReady);
  const initialLoading = useChannelsStore((state) => state.initialLoading);
  const refreshing = useChannelsStore((state) => state.refreshing);
  const mutating = useChannelsStore((state) => state.mutating);
  const mutatingByChannelId = useChannelsStore((state) => state.mutatingByChannelId);
  const error = useChannelsStore((state) => state.error);
  const fetchChannels = useChannelsStore((state) => state.fetchChannels);
  const probeChannels = useChannelsStore((state) => state.probeChannels);
  const deleteChannel = useChannelsStore((state) => state.deleteChannel);
  const gatewayStatus = useGatewayStore((state) => state.status);
  const gatewayInitialized = useGatewayStore((state) => state.isInitialized);
  const endpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const runtime = endpoints.find((entry) => runtimeEndpointsEqual(entry.endpointRef, scope.endpoint));
  const nativeMatcha = scope.endpoint.kind === 'native-runtime' && scope.endpoint.runtimeAdapterId === 'matcha-agent';
  const storeScope = useChannelsStore((state) => state.scope);
  const scopeMatches = storeScope && buildCapabilityScopeKey(storeScope) === buildCapabilityScopeKey(scope);

  const [dialogTarget, setDialogTarget] = useState<ChannelDialogTarget | null>(null);
  const [channelToDelete, setChannelToDelete] = useState<{ id: string; type: ChannelType; traceId: string | undefined; startedAt: number } | null>(null);
  const [pairingChannel, setPairingChannel] = useState<Channel | null>(null);
  const statusRefreshPendingRef = useRef(false);
  const statusRefreshRafRef = useRef<number | null>(null);
  const statusRefreshLastAtRef = useRef(0);
  const lastGatewayOperationalRef = useRef(isGatewayOperational(gatewayStatus));

  // Fetch channels on mount
  useEffect(() => {
    useChannelsStore.getState().selectScope(scope);
    void fetchChannels({ silent: true });
  }, [fetchChannels, scope]);

  const scheduleStatusRefresh = useCallback(() => {
    if (statusRefreshPendingRef.current) {
      return;
    }
    statusRefreshPendingRef.current = true;
    statusRefreshRafRef.current = window.requestAnimationFrame(() => {
      statusRefreshPendingRef.current = false;
      statusRefreshRafRef.current = null;
      const now = Date.now();
      if (now - statusRefreshLastAtRef.current < CHANNELS_EVENT_REFRESH_COOLDOWN_MS) {
        return;
      }
      statusRefreshLastAtRef.current = now;
      void fetchChannels({ silent: true });
    });
  }, [fetchChannels]);

  useEffect(() => {
    if (nativeMatcha) return;
    const unsubscribe = subscribeHostEvent('gateway:channel-status', (payload: unknown) => {
      if (isRecord(payload) && typeof payload.eventName === 'string' && payload.eventName.startsWith('channel:')) {
        return;
      }
      scheduleStatusRefresh();
    });
    return () => {
      if (statusRefreshRafRef.current != null) {
        window.cancelAnimationFrame(statusRefreshRafRef.current);
        statusRefreshRafRef.current = null;
      }
      statusRefreshPendingRef.current = false;
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [scheduleStatusRefresh, nativeMatcha]);

  useEffect(() => {
    const gatewayOperational = nativeMatcha ? Boolean(runtime && isRuntimeEndpointReady(runtime)) : isGatewayOperational(gatewayStatus);
    const previousGatewayOperational = lastGatewayOperationalRef.current;
    lastGatewayOperationalRef.current = gatewayOperational;
    if (!previousGatewayOperational && gatewayOperational) {
      scheduleStatusRefresh();
    }
  }, [gatewayStatus, scheduleStatusRefresh, nativeMatcha, runtime]);

  const contributions = useContributions(channelPresentations);
  const presentations = useMemo(() => contributions.filter((entry) => scope.endpoint.kind === 'native-runtime'
    && entry.runtimeAdapterId === scope.endpoint.runtimeAdapterId), [contributions, scope]);
  const availableChannels = presentations.filter((entry) => entry.availableToAdd);
  const selectedType = dialogTarget?.kind === 'new' ? dialogTarget.type
    : dialogTarget?.kind === 'configured' ? dialogTarget.channel.type : null;
  const presentation = presentations.find((entry) => entry.meta.id === selectedType);
  const Configuration = presentation?.configuration;
  const Pairing = presentations.find((entry) => entry.meta.id === pairingChannel?.type)?.pairing;
  const openCatalog = () => setDialogTarget(availableChannels.length === 1
    ? { kind: 'new', type: availableChannels[0].meta.id } : { kind: 'catalog' });
  const safeChannels = scopeMatches && Array.isArray(channels) ? channels : [];
  const configuredChannels: Channel[] = safeChannels;

  // Connected/disconnected channel counts
  const connectedCount = configuredChannels.filter((c) => c.status === 'connected').length;
  const gatewayOperational = nativeMatcha ? Boolean(runtime && isRuntimeEndpointReady(runtime)) : isGatewayOperational(gatewayStatus);
  const gatewayPreparing = nativeMatcha ? Boolean(runtime && isRuntimeEndpointStarting(runtime)) : isGatewayPreparing(gatewayStatus, gatewayInitialized);
  const showInitialLoading = !snapshotReady && initialLoading;
  const manualRefreshBusy = refreshing || mutating;
  const showRefreshingHint = useDelayedFlag(refreshing && snapshotReady, 180);

  useEffect(() => {
    if (!gatewayOperational || configuredChannels.length === 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void fetchChannels({ silent: true });
    }, CHANNELS_STATUS_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [configuredChannels.length, fetchChannels, gatewayOperational]);

  return (
    <div className="space-y-6 text-foreground">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex min-h-11 items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-[-0.035em] text-foreground">{t('title')}</h1>
          <RuntimeScopeSelector />
        </div>
        <p className="mt-1 max-w-2xl text-sm text-[hsl(var(--shell-text-muted))]">
          {t('subtitle')}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-4">
          {!showInitialLoading && (
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex h-8 items-center gap-2 rounded-full border bg-[hsl(var(--shell-surface-muted))] px-3 text-xs text-[hsl(var(--shell-text-muted))] [border-color:hsl(var(--shell-border))]">
                <Radio className="h-3.5 w-3.5" />
                <strong className="text-foreground">{configuredChannels.length}</strong>
                {t('stats.total')}
              </span>
              <span className="inline-flex h-8 items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 text-xs text-emerald-700 dark:text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <strong>{connectedCount}</strong>
                {t('stats.connected')}
              </span>
              <span className="inline-flex h-8 items-center gap-2 rounded-full border bg-[hsl(var(--shell-surface-muted))] px-3 text-xs text-[hsl(var(--shell-text-muted))] [border-color:hsl(var(--shell-border))]">
                <strong className="text-foreground">{configuredChannels.filter((channel) => channel.status === 'disconnected').length}</strong>
                {t('stats.disconnected')}
              </span>
            </div>
          )}
          <div className="ml-auto flex shrink-0 flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                void probeChannels();
              }}
              disabled={manualRefreshBusy || !gatewayOperational}
            >
              <RefreshCw className={cn('h-4 w-4 mr-2', refreshing && 'animate-spin')} />
              {t('refresh')}
            </Button>
            <Button onClick={openCatalog}>
              <Plus className="h-4 w-4 mr-2" />
              {t('addChannel')}
            </Button>
          </div>
        </div>
      </div>

      {/* Gateway Warning */}
      {!gatewayOperational && (
        <Card className={gatewayPreparing ? 'border-border bg-muted/30' : 'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10'}>
          <CardContent className="py-4 flex items-center gap-3">
            {gatewayPreparing ? (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            ) : (
              <AlertCircle className="h-5 w-5 text-yellow-500" />
            )}
            <span className={gatewayPreparing ? 'text-muted-foreground' : 'text-yellow-700 dark:text-yellow-400'}>
              {gatewayPreparing ? t('gatewayPreparing') : t('gatewayWarning')}
            </span>
          </CardContent>
        </Card>
      )}

      {/* Error Display */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-destructive">
            {error}
          </CardContent>
        </Card>
      )}

      {showRefreshingHint && (
        <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          {t('common:status.loading', 'Loading...')}
        </div>
      )}

      {showInitialLoading ? (
        <Card>
          <CardContent className="py-10">
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('common:status.loading', 'Loading...')}
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Configured Channels */}
          {configuredChannels.length > 0 && (
            <section className="space-y-3">
              <div>
                <h2 className="text-base font-semibold tracking-[-0.02em]">{t('configured')}</h2>
                <p className="text-sm text-muted-foreground">{t('configuredDesc')}</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {configuredChannels.map((channel) => (
                  <ChannelCard
                    key={channel.id}
                    channel={channel}
                    presentation={presentations.find((entry) => entry.meta.id === channel.type)!}
                    isMutating={Boolean(mutatingByChannelId[channel.id])}
                    onConfigure={() => setDialogTarget({ kind: 'configured', channel })}
                    onManagePairing={presentations.some((entry) => entry.meta.id === channel.type && entry.pairing) ? () => setPairingChannel(channel) : undefined}
                    onDelete={() => {
                      const traceId = isTraceEnabled() ? crypto.randomUUID() : undefined;
                      logChannelTrace('delete.click', traceId);
                      setChannelToDelete({ id: channel.id, type: channel.type, traceId, startedAt: isTraceEnabled() ? Date.now() : 0 });
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Available Channels */}
          <section className="space-y-3 rounded-[1.5rem] border bg-[hsl(var(--shell-surface-muted))] p-5 [border-color:hsl(var(--shell-border))]">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-base font-semibold tracking-[-0.02em]">{t('available')}</h2>
                <p className="text-sm text-[hsl(var(--shell-text-muted))]">{t('availableDesc')}</p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
              {availableChannels.map(({ meta }) => {
                const type = meta.id;
                const isConfigured = configuredChannels.some((channel) => channel.type === type);
                const connectionLabel = t(channelConnectionLabelKey(meta.connectionType));
                return (
                  <button
                    key={type}
                    className={cn(
                      'group relative flex min-h-[148px] flex-col rounded-[1.1rem] border p-4 text-left transition-[background-color,border-color] duration-150 hover:[border-color:hsl(var(--shell-border-strong))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20',
                      isConfigured
                        ? 'border-emerald-500/45 bg-emerald-500/10'
                        : 'bg-[hsl(var(--shell-surface))] [border-color:hsl(var(--shell-border))] hover:bg-[hsl(var(--shell-surface-hover))]'
                    )}
                    onClick={() => setDialogTarget({ kind: 'new', type })}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="grid h-11 w-11 place-items-center rounded-[0.9rem] border bg-[hsl(var(--shell-surface-muted))] [border-color:hsl(var(--shell-border))]">
                        <ChannelIcon id={meta.iconId} className="h-7 w-7" />
                      </span>
                      {isConfigured ? (
                        <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
                          {t('configuredBadge')}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          {connectionLabel}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-4 min-w-0 flex-1 space-y-1">
                      <p className="truncate text-base font-semibold tracking-[-0.02em]">{meta.name}</p>
                      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {t(meta.description)}
                      </p>
                    </div>
                    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                      <span>{meta.isPlugin ? t('pluginBadge') : connectionLabel}</span>
                      <span>→</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        </>
      )}

      {/* Add Channel Dialog */}
      {dialogTarget?.kind === 'catalog' && (
        <ChannelCatalogDialog
          channels={availableChannels}
          onSelect={(type) => setDialogTarget({ kind: 'new', type })}
          onClose={() => setDialogTarget((current) => current === dialogTarget ? null : current)}
        />
      )}
      {dialogTarget && dialogTarget.kind !== 'catalog' && presentation && Configuration && (
        <Suspense fallback={null}>
          <Configuration
            key={dialogTarget.kind === 'new' ? dialogTarget.type : dialogTarget.channel.id}
            scope={scope}
            target={dialogTarget}
            presentation={presentation}
            onBack={openCatalog}
            onClose={() => setDialogTarget((current) => current === dialogTarget ? null : current)}
            onChannelAdded={() => setDialogTarget((current) => current === dialogTarget ? null : current)}
          />
        </Suspense>
      )}

      <ConfirmDialog
        open={!!channelToDelete}
        title={t('common.confirm', 'Confirm')}
        message={t('deleteConfirm')}
        confirmLabel={t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (channelToDelete) {
            logChannelTrace('delete.submit', channelToDelete.traceId);
            const deleted = await deleteChannel(channelToDelete.id, { traceId: channelToDelete.traceId });
            logChannelTrace('delete.final', channelToDelete.traceId, () => ({ outcome: deleted ? 'confirmed' : 'unconfirmed', durationMs: Date.now() - channelToDelete.startedAt }));
            setChannelToDelete(null);
          }
        }}
        onCancel={() => {
          if (channelToDelete) logChannelTrace('delete.final', channelToDelete.traceId, () => ({ outcome: 'cancelled', durationMs: Date.now() - channelToDelete.startedAt }));
          setChannelToDelete(null);
        }}
      />

      {pairingChannel && Pairing && (
        <Suspense fallback={null}>
          <Pairing
            scope={scope}
            channel={pairingChannel}
            onClose={() => setPairingChannel(null)}
          />
        </Suspense>
      )}
    </div>
  );
}

// ==================== Channel Card Component ====================

interface ChannelCardProps {
  channel: Channel;
  presentation: ChannelPresentation;
  isMutating?: boolean;
  onConfigure: () => void;
  onManagePairing?: () => void;
  onDelete: () => void;
}

function ChannelCard({ channel, presentation, isMutating = false, onConfigure, onManagePairing, onDelete }: ChannelCardProps) {
  const { t } = useTranslation('channels');
  const status = (channel.status === 'unknown' ? 'stopped' : channel.status) as Status;
  const statusLabel = channel.status === 'unknown' ? '连接状态未知' : t(`status.${status}`, { defaultValue: status });

  return (
    <Card className="h-full bg-[hsl(var(--shell-surface-muted))] [border-color:hsl(var(--shell-border))]">
      <CardContent className="flex h-full min-h-[118px] flex-col gap-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-[0.85rem] border bg-[hsl(var(--shell-surface))] [border-color:hsl(var(--shell-border))]">
              <ChannelIcon id={presentation.meta.iconId} className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <CardTitle className="truncate text-base tracking-[-0.02em]">{channel.name}</CardTitle>
              <CardDescription className="truncate text-xs leading-5">
                {presentation.meta.name}
              </CardDescription>
            </div>
          </div>
          <StatusBadge status={status} label={statusLabel} className="shrink-0 max-w-none" />
        </div>

        {channel.error && (
          <p className="line-clamp-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{channel.error}</p>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3 [border-color:hsl(var(--shell-border))]">
          <p className="truncate text-xs text-muted-foreground">
            {presentation.meta.name}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onConfigure}
              disabled={isMutating}
              aria-label={t('dialog.configureTitle', { name: channel.name })}
            >
              <Settings className="h-4 w-4" />
            </Button>
            {onManagePairing && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onManagePairing}
                disabled={isMutating}
                aria-label={t('pairing.manage')}
              >
                <UserCheck className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={onDelete}
              disabled={isMutating}
            >
              {isMutating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}


export default Channels;
