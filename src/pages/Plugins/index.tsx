import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { hostApiFetch } from '@/lib/host-api';
import { useGatewayStore } from '@/stores/gateway';
import { useTranslation } from 'react-i18next';

type PluginCatalogItem = {
  id: string;
  name: string;
  version: string;
  kind: 'builtin' | 'third-party';
  platform: 'openclaw' | 'matchaclaw';
  category: string;
  description?: string;
  enabled: boolean;
};

type RuntimePayload = {
  success: boolean;
  state: {
    lifecycle: 'idle' | 'starting' | 'running' | 'stopped' | 'error';
    runtimeLifecycle: 'idle' | 'booting' | 'ready' | 'degraded' | 'stopped';
    activePluginCount: number;
    pluginExecutionEnabled: boolean;
    enabledPluginIds: string[];
    lastError?: string;
  };
  health: {
    ok: boolean;
    lifecycle: 'idle' | 'booting' | 'ready' | 'degraded' | 'stopped';
    activePluginCount: number;
    degradedPlugins: string[];
    error?: string;
  };
  execution: {
    pluginExecutionEnabled: boolean;
    enabledPluginIds: string[];
  };
};

type CatalogPayload = {
  success: boolean;
  execution: {
    pluginExecutionEnabled: boolean;
    enabledPluginIds: string[];
  };
  plugins: PluginCatalogItem[];
};

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
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<'refresh' | 'execution' | 'toggle-plugin' | 'restart' | null>(null);
  const [runtime, setRuntime] = useState<RuntimePayload | null>(null);
  const [plugins, setPlugins] = useState<PluginCatalogItem[]>([]);

  const loadSnapshot = useCallback(async () => {
    const [runtimePayload, catalogPayload] = await Promise.all([
      hostApiFetch<RuntimePayload>('/api/plugins/runtime'),
      hostApiFetch<CatalogPayload>('/api/plugins/catalog'),
    ]);
    setRuntime(runtimePayload);
    setPlugins(catalogPayload.plugins);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void initGatewayEvents();
    setLoading(true);
    void loadSnapshot()
      .catch(() => {
        if (cancelled) return;
        toast.error(t('plugins:errors.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initGatewayEvents, loadSnapshot, t]);

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
    setBusyAction('refresh');
    try {
      await loadSnapshot();
    } catch {
      toast.error(t('plugins:errors.loadFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [loadSnapshot, t]);

  const restartHost = useCallback(async () => {
    setBusyAction('restart');
    try {
      const payload = await hostApiFetch<RuntimePayload>('/api/plugins/runtime/restart', { method: 'POST' });
      setRuntime(payload);
      await loadSnapshot();
    } catch {
      toast.error(t('plugins:errors.restartFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [loadSnapshot, t]);

  const toggleExecution = useCallback(async (nextValue: boolean) => {
    setBusyAction('execution');
    try {
      const payload = await hostApiFetch<RuntimePayload>('/api/plugins/runtime/execution', {
        method: 'PUT',
        body: JSON.stringify({ enabled: nextValue }),
      });
      setRuntime(payload);
      await loadSnapshot();
    } catch {
      toast.error(t('plugins:errors.toggleExecutionFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [loadSnapshot, t]);

  const togglePluginEnabled = useCallback(async (pluginId: string, nextEnabled: boolean) => {
    if (!runtime) {
      return;
    }
    const nextIds = nextEnabled
      ? Array.from(new Set([...enabledPluginIds, pluginId]))
      : enabledPluginIds.filter((id) => id !== pluginId);
    setBusyAction('toggle-plugin');
    try {
      const payload = await hostApiFetch<RuntimePayload>('/api/plugins/runtime/enabled-plugins', {
        method: 'PUT',
        body: JSON.stringify({ pluginIds: nextIds }),
      });
      setRuntime(payload);
      await loadSnapshot();
    } catch {
      toast.error(t('plugins:errors.togglePluginFailed'));
    } finally {
      setBusyAction(null);
    }
  }, [enabledPluginIds, loadSnapshot, runtime, t]);

  return (
    <section className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{t('plugins:title')}</h1>
        <p className="text-sm text-muted-foreground">{t('plugins:description')}</p>
      </header>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t('plugins:runtime.title')}</CardTitle>
            <CardDescription>{t('plugins:runtime.description')}</CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void refresh()} disabled={busyAction !== null}>
              {busyAction === 'refresh' ? t('plugins:runtime.busy') : t('plugins:runtime.refresh')}
            </Button>
            <Button onClick={() => void restartHost()} disabled={busyAction !== null}>
              {busyAction === 'restart' ? t('plugins:runtime.busy') : t('plugins:runtime.restart')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading ? (
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
              disabled={loading || busyAction !== null}
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
          {loading ? (
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
              {plugins.map((plugin) => (
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
                    <Switch
                      checked={enabledPluginIdSet.has(plugin.id)}
                      disabled={busyAction !== null}
                      onCheckedChange={(checked) => {
                        void togglePluginEnabled(plugin.id, checked);
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export default PluginsPage;
