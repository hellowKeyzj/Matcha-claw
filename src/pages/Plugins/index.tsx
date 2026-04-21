import { useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useGatewayStore } from '@/stores/gateway';
import { usePluginsStore } from '@/stores/plugins-store';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { useTranslation } from 'react-i18next';

function formatLifecycleLabel(lifecycle: string): string {
  switch (lifecycle) {
    case 'running':
      return 'running';
    case 'starting':
      return 'starting';
    case 'ready':
      return 'ready';
    case 'booting':
      return 'booting';
    case 'degraded':
      return 'degraded';
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'error';
    case 'idle':
      return 'idle';
    default:
      return lifecycle;
  }
}

function formatIsoTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

export function PluginsPage() {
  const { t } = useTranslation(['plugins', 'common']);
  const runtimeHostEventState = useGatewayStore((state) => state.runtimeHost);
  const initGatewayEvents = useGatewayStore((state) => state.init);
  const pluginSnapshot = usePluginsStore((state) => state.pluginSnapshot);
  const snapshotReady = usePluginsStore((state) => state.snapshotReady);
  const initialLoading = usePluginsStore((state) => state.initialLoading);
  const refreshing = usePluginsStore((state) => state.refreshing);
  const refreshReason = usePluginsStore((state) => state.refreshReason);
  const mutating = usePluginsStore((state) => state.mutating);
  const mutatingAction = usePluginsStore((state) => state.mutatingAction);
  const mutatingPluginId = usePluginsStore((state) => state.mutatingPluginId);
  const error = usePluginsStore((state) => state.error);
  const refreshSnapshot = usePluginsStore((state) => state.refreshSnapshot);
  const restartHostAction = usePluginsStore((state) => state.restartHost);
  const toggleExecutionAction = usePluginsStore((state) => state.toggleExecution);
  const togglePluginEnabledAction = usePluginsStore((state) => state.togglePluginEnabled);
  const manualRefreshing = refreshing && refreshReason === 'manual';
  const showRefreshingHint = useDelayedFlag(refreshing && !manualRefreshing, 180);

  useEffect(() => {
    void initGatewayEvents();
    const hadSnapshot = usePluginsStore.getState().snapshotReady;
    void refreshSnapshot({ reason: 'initial', silent: true }).catch(() => {
      if (!hadSnapshot) {
        toast.error(t('plugins:errors.loadFailed'));
      }
    });
  }, [initGatewayEvents, refreshSnapshot, t]);

  const runtime = pluginSnapshot.runtime;
  const plugins = pluginSnapshot.plugins;

  const enabledPluginIds = useMemo(
    () => runtime?.execution.enabledPluginIds ?? [],
    [runtime],
  );
  const enabledPluginIdSet = useMemo(
    () => new Set(enabledPluginIds),
    [enabledPluginIds],
  );
  const executionEnabled = runtime?.execution.pluginExecutionEnabled ?? true;

  const lifecycleTags = useMemo(() => {
    if (!runtime) {
      return [];
    }
    return [
      {
        id: 'host',
        label: `host:${formatLifecycleLabel(runtime.state.lifecycle)}`,
      },
      {
        id: 'runtime',
        label: `runtime:${formatLifecycleLabel(runtime.state.runtimeLifecycle)}`,
      },
    ];
  }, [runtime]);

  const observedRuntimeHostStatus = runtimeHostEventState.lifecycle;
  const effectiveRuntimeHostStatus = observedRuntimeHostStatus !== 'unknown'
    ? observedRuntimeHostStatus
    : (runtime?.health.ok ? 'running' : 'stopped');
  const recoveredAt = runtimeHostEventState.lastRestartAt
    ? formatIsoTime(runtimeHostEventState.lastRestartAt)
    : '';

  const refresh = useCallback(async () => {
    try {
      await refreshSnapshot({ reason: 'manual' });
    } catch {
      toast.error(t('plugins:errors.loadFailed'));
    }
  }, [refreshSnapshot, t]);

  const restartHost = useCallback(async () => {
    try {
      await restartHostAction();
    } catch {
      toast.error(t('plugins:errors.restartFailed'));
    }
  }, [restartHostAction, t]);

  const toggleExecution = useCallback(async (nextValue: boolean) => {
    try {
      await toggleExecutionAction(nextValue);
    } catch {
      toast.error(t('plugins:errors.toggleExecutionFailed'));
    }
  }, [toggleExecutionAction, t]);

  const togglePluginEnabled = useCallback(async (pluginId: string, nextEnabled: boolean) => {
    try {
      await togglePluginEnabledAction(pluginId, nextEnabled);
    } catch {
      toast.error(t('plugins:errors.togglePluginFailed'));
    }
  }, [togglePluginEnabledAction, t]);

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('plugins:title')}</h1>
        <p className="text-sm text-muted-foreground">{t('plugins:description')}</p>
      </header>
      {error && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {t(error)}
        </p>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t('plugins:runtime.title')}</CardTitle>
            <CardDescription>{t('plugins:runtime.description')}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {showRefreshingHint && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('common:status.loading')}
              </span>
            )}
            <Button variant="outline" onClick={() => void refresh()} disabled={manualRefreshing || mutating}>
              {manualRefreshing ? t('plugins:runtime.busy') : t('plugins:runtime.refresh')}
            </Button>
            <Button onClick={() => void restartHost()} disabled={manualRefreshing || mutating}>
              {mutatingAction === 'restart' ? t('plugins:runtime.busy') : t('plugins:runtime.restart')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {!snapshotReady && initialLoading ? (
            <p className="text-sm text-muted-foreground">{t('common:status.loading')}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {effectiveRuntimeHostStatus === 'running' && (
                  <Badge variant="default">{t('plugins:state.hostRunning')}</Badge>
                )}
                {effectiveRuntimeHostStatus === 'starting' && (
                  <Badge variant="outline">{t('plugins:state.hostStarting')}</Badge>
                )}
                {effectiveRuntimeHostStatus === 'degraded' && (
                  <Badge variant="secondary">{t('plugins:state.hostDegraded')}</Badge>
                )}
                {(effectiveRuntimeHostStatus === 'stopped' || effectiveRuntimeHostStatus === 'error') && (
                  <Badge variant="destructive">{t('plugins:state.hostStopped')}</Badge>
                )}
                <Badge variant="outline">
                  {executionEnabled ? t('plugins:state.executionOn') : t('plugins:state.executionOff')}
                </Badge>
                {lifecycleTags.map((tag) => (
                  <Badge key={tag.id} variant="outline">{tag.label}</Badge>
                ))}
              </div>
              {runtime?.state.lastError && (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                  {runtime.state.lastError}
                </p>
              )}
              {runtimeHostEventState.error && (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                  {runtimeHostEventState.error}
                </p>
              )}
              {runtime?.health.error && (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
                  {runtime.health.error}
                </p>
              )}
              {runtimeHostEventState.restartCount > 0 && (
                <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-700">
                  {t('plugins:runtime.recoveredNotice', { count: runtimeHostEventState.restartCount })}
                </p>
              )}
              {recoveredAt && (
                <p className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-700">
                  {t('plugins:runtime.recoveredAt', { time: recoveredAt })}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('plugins:execution.title')}</CardTitle>
          <CardDescription>{t('plugins:execution.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3 rounded-md border border-border/80 p-3">
            <Label htmlFor="plugin-execution-toggle" className="text-sm">{t('plugins:execution.switchLabel')}</Label>
            <Switch
              id="plugin-execution-toggle"
              checked={executionEnabled}
              disabled={!snapshotReady || initialLoading || manualRefreshing || mutatingAction !== null}
              onCheckedChange={(checked) => {
                void toggleExecution(checked);
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('plugins:catalog.title')}</CardTitle>
          <CardDescription>{t('plugins:catalog.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {!snapshotReady && initialLoading ? (
            <p className="text-sm text-muted-foreground">{t('common:status.loading')}</p>
          ) : plugins.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('plugins:catalog.empty')}</p>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-[1.5fr_0.9fr_0.8fr_1fr_0.8fr_0.7fr] gap-2 px-3 text-xs text-muted-foreground">
                <span>{t('plugins:catalog.columns.plugin')}</span>
                <span>{t('plugins:catalog.columns.platform')}</span>
                <span>{t('plugins:catalog.columns.kind')}</span>
                <span>{t('plugins:catalog.columns.category')}</span>
                <span>{t('plugins:catalog.columns.version')}</span>
                <span className="text-right">{t('plugins:catalog.columns.enabled')}</span>
              </div>
              {plugins.map((plugin) => {
                const channelManaged = plugin.controlMode === 'channel-config';
                return (
                  <div
                    key={plugin.id}
                    className="grid grid-cols-[1.5fr_0.9fr_0.8fr_1fr_0.8fr_0.7fr] items-center gap-2 rounded-md border border-border/70 bg-background px-3 py-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{plugin.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{plugin.id}</div>
                      {plugin.description && (
                        <div className="truncate text-xs text-muted-foreground">{plugin.description}</div>
                      )}
                      {channelManaged && (
                        <div className="truncate text-xs text-muted-foreground">
                          {t('plugins:catalog.channelManaged')}
                        </div>
                      )}
                    </div>
                    <Badge variant={plugin.platform === 'matchaclaw' ? 'default' : 'secondary'} className="justify-self-start">
                      {t(`plugins:catalog.platform.${plugin.platform}`)}
                    </Badge>
                    <Badge variant="outline" className="justify-self-start">
                      {t(`plugins:catalog.kind.${plugin.kind}`)}
                    </Badge>
                    <span className="truncate text-sm">{plugin.category}</span>
                    <span className="truncate text-sm">{plugin.version}</span>
                    <div className="justify-self-end">
                      {mutatingPluginId === plugin.id && (
                        <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      )}
                      <Switch
                        checked={enabledPluginIdSet.has(plugin.id)}
                        disabled={
                          !snapshotReady
                          || initialLoading
                          || manualRefreshing
                          || mutatingAction !== null
                          || mutatingPluginId !== null
                          || channelManaged
                        }
                        onCheckedChange={(checked) => {
                          void togglePluginEnabled(plugin.id, checked);
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export default PluginsPage;
