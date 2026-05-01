import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DEFAULT_PLUGIN_GROUP_ID,
  PLUGIN_GROUP_REGISTRY,
  type PluginGroupId,
} from '@/features/plugins/plugin-groups';
import { useGatewayStore } from '@/stores/gateway';
import { usePluginsStore, type PluginCatalogItem } from '@/stores/plugins-store';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { useTranslation } from 'react-i18next';

function formatIsoTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

function buildPluginsByGroup(catalog: PluginCatalogItem[]): Record<PluginGroupId, PluginCatalogItem[]> {
  const grouped: Record<PluginGroupId, PluginCatalogItem[]> = {
    channel: [],
    model: [],
    general: [],
  };

  for (const plugin of catalog) {
    grouped[plugin.group].push(plugin);
  }

  return grouped;
}

function pickFirstNonEmptyGroupId(groupedCatalog: Record<PluginGroupId, PluginCatalogItem[]>): PluginGroupId {
  return PLUGIN_GROUP_REGISTRY.find((group) => groupedCatalog[group.id].length > 0)?.id ?? DEFAULT_PLUGIN_GROUP_ID;
}

export function PluginsPage() {
  const { t } = useTranslation(['plugins', 'common']);
  const runtimeHostEventState = useGatewayStore((state) => state.runtimeHost);
  const initGatewayEvents = useGatewayStore((state) => state.init);
  const runtime = usePluginsStore((state) => state.runtime);
  const catalog = usePluginsStore((state) => state.catalog);
  const runtimeReady = usePluginsStore((state) => state.runtimeReady);
  const catalogReady = usePluginsStore((state) => state.catalogReady);
  const runtimePending = usePluginsStore((state) => state.runtimePending);
  const catalogPending = usePluginsStore((state) => state.catalogPending);
  const refreshing = usePluginsStore((state) => state.refreshing);
  const refreshReason = usePluginsStore((state) => state.refreshReason);
  const mutating = usePluginsStore((state) => state.mutating);
  const mutatingAction = usePluginsStore((state) => state.mutatingAction);
  const mutatingPluginId = usePluginsStore((state) => state.mutatingPluginId);
  const error = usePluginsStore((state) => state.error);
  const refreshRuntime = usePluginsStore((state) => state.refreshRuntime);
  const refreshCatalog = usePluginsStore((state) => state.refreshCatalog);
  const refreshSnapshot = usePluginsStore((state) => state.refreshSnapshot);
  const restartHostAction = usePluginsStore((state) => state.restartHost);
  const togglePluginEnabledAction = usePluginsStore((state) => state.togglePluginEnabled);
  const manualRefreshing = refreshing && refreshReason === 'manual';
  const showRefreshingHint = useDelayedFlag(refreshing && !manualRefreshing, 180);
  const [activeGroupId, setActiveGroupId] = useState<PluginGroupId>(() => pickFirstNonEmptyGroupId(buildPluginsByGroup(catalog)));
  const didUserSelectGroupRef = useRef(false);

  useEffect(() => {
    void initGatewayEvents();
    const hadRuntime = usePluginsStore.getState().runtimeReady;
    void refreshRuntime({ reason: 'initial' }).catch(() => {
      if (!hadRuntime) {
        toast.error(t('plugins:errors.loadFailed'));
      }
    });
    void refreshCatalog({ reason: 'initial' }).catch(() => {});
  }, [initGatewayEvents, refreshCatalog, refreshRuntime, t]);

  const enabledPluginIds = useMemo(
    () => runtime?.execution.enabledPluginIds ?? [],
    [runtime],
  );
  const enabledPluginIdSet = useMemo(
    () => new Set(enabledPluginIds),
    [enabledPluginIds],
  );
  const pluginsByGroup = useMemo(
    () => buildPluginsByGroup(catalog),
    [catalog],
  );
  const preferredGroupId = useMemo(
    () => pickFirstNonEmptyGroupId(pluginsByGroup),
    [pluginsByGroup],
  );
  const visiblePlugins = pluginsByGroup[activeGroupId];
  const lifecycleTags = useMemo(() => {
    if (!runtime) {
      return [];
    }
    return [
      {
        id: 'host',
        label: t(`plugins:lifecycle.host.${runtime.state.lifecycle}`),
      },
      {
        id: 'runtime',
        label: t(`plugins:lifecycle.runtime.${runtime.state.runtimeLifecycle}`),
      },
    ];
  }, [runtime, t]);

  useEffect(() => {
    if (!catalogReady || didUserSelectGroupRef.current) {
      return;
    }
    if (pluginsByGroup[activeGroupId].length === 0) {
      setActiveGroupId(preferredGroupId);
    }
  }, [activeGroupId, catalogReady, pluginsByGroup, preferredGroupId]);

  const observedRuntimeHostStatus = runtimeHostEventState.lifecycle;
  const effectiveRuntimeHostStatus = observedRuntimeHostStatus !== 'unknown'
    ? observedRuntimeHostStatus
    : (runtime?.health.ok ? 'running' : 'stopped');
  const recoveredAt = runtimeHostEventState.lastRestartAt
    ? formatIsoTime(runtimeHostEventState.lastRestartAt)
    : '';

  const refresh = useCallback(async () => {
    try {
      await refreshSnapshot({ reason: 'manual', force: true });
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

  const togglePluginEnabled = useCallback(async (pluginId: string, nextEnabled: boolean) => {
    try {
      await togglePluginEnabledAction(pluginId, nextEnabled);
    } catch {
      toast.error(t('plugins:errors.togglePluginFailed'));
    }
  }, [togglePluginEnabledAction, t]);
  const handleGroupChange = useCallback((value: string) => {
    didUserSelectGroupRef.current = true;
    setActiveGroupId(value as PluginGroupId);
  }, []);

  const showRuntimeLoading = !runtimeReady && runtimePending;
  const showCatalogLoading = !catalogReady && catalogPending;

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
          {showRuntimeLoading ? (
            <div className="space-y-2">
              <div className="h-5 w-48 animate-pulse rounded bg-muted" />
              <div className="h-3 w-full animate-pulse rounded bg-muted" />
              <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
            </div>
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
          <CardTitle>{t('plugins:catalog.title')}</CardTitle>
          <CardDescription>{t('plugins:catalog.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {showCatalogLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={`plugin-catalog-loading-${index}`} className="rounded-md border border-border/70 px-3 py-3">
                  <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                  <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted" />
                  <div className="mt-2 h-3 w-2/5 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {catalog.length > 0 && (
                <Tabs value={activeGroupId} onValueChange={handleGroupChange}>
                  <TabsList className="grid h-auto w-full grid-cols-3 gap-1">
                    {PLUGIN_GROUP_REGISTRY.map((group) => (
                      <TabsTrigger key={group.id} value={group.id}>
                        {`${t(group.labelKey)} (${pluginsByGroup[group.id].length})`}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              )}
              {catalog.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('plugins:catalog.empty')}</p>
              ) : visiblePlugins.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('plugins:catalog.emptyGroup', {
                    group: t(PLUGIN_GROUP_REGISTRY.find((group) => group.id === activeGroupId)?.labelKey ?? 'plugins:catalog.groups.general'),
                  })}
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-[1.7fr_0.9fr_0.8fr_0.8fr_0.7fr] gap-2 px-3 text-xs text-muted-foreground">
                    <span>{t('plugins:catalog.columns.plugin')}</span>
                    <span>{t('plugins:catalog.columns.platform')}</span>
                    <span>{t('plugins:catalog.columns.kind')}</span>
                    <span>{t('plugins:catalog.columns.version')}</span>
                    <span className="text-right">{t('plugins:catalog.columns.enabled')}</span>
                  </div>
                  {visiblePlugins.map((plugin) => {
                    const channelManaged = plugin.controlMode === 'channel-config';
                    return (
                      <div
                        key={plugin.id}
                        className="grid grid-cols-[1.7fr_0.9fr_0.8fr_0.8fr_0.7fr] items-center gap-2 rounded-md border border-border/70 bg-background px-3 py-3"
                      >
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{plugin.name}</div>
                          <div className="truncate text-xs text-muted-foreground">{plugin.id}</div>
                          {plugin.description && (
                            <div className="truncate text-xs text-muted-foreground">{plugin.description}</div>
                          )}
                          {plugin.companionSkillSlugs && plugin.companionSkillSlugs.length > 0 && (
                            <div className="truncate text-xs text-muted-foreground">
                              {t('plugins:catalog.companionSkills', {
                                skills: plugin.companionSkillSlugs.join(', '),
                              })}
                            </div>
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
                        <span className="truncate text-sm">{plugin.version}</span>
                        <div className="justify-self-end">
                          {mutatingPluginId === plugin.id && (
                            <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin text-muted-foreground" />
                          )}
                          <Switch
                            checked={enabledPluginIdSet.has(plugin.id)}
                            disabled={
                              !runtimeReady
                              || runtimePending
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
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export default PluginsPage;
