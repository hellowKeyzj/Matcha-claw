import { useCallback, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { usePluginsStore } from '@/stores/plugins-store';
import { useTranslation } from 'react-i18next';

export function PluginsPage() {
  const { t } = useTranslation(['plugins', 'common']);
  const runtime = usePluginsStore((state) => state.runtime);
  const catalog = usePluginsStore((state) => state.catalog);
  const runtimeReady = usePluginsStore((state) => state.runtimeReady);
  const catalogReady = usePluginsStore((state) => state.catalogReady);
  const runtimePending = usePluginsStore((state) => state.runtimePending);
  const catalogPending = usePluginsStore((state) => state.catalogPending);
  const mutatingAction = usePluginsStore((state) => state.mutatingAction);
  const mutatingPluginId = usePluginsStore((state) => state.mutatingPluginId);
  const error = usePluginsStore((state) => state.error);
  const refreshRuntime = usePluginsStore((state) => state.refreshRuntime);
  const refreshCatalog = usePluginsStore((state) => state.refreshCatalog);
  const togglePluginEnabledAction = usePluginsStore((state) => state.togglePluginEnabled);

  useEffect(() => {
    const hadRuntime = usePluginsStore.getState().runtimeReady;
    void refreshRuntime({ reason: 'initial' }).catch(() => {
      if (!hadRuntime) {
        toast.error(t('plugins:errors.loadFailed'));
      }
    });
    void refreshCatalog({ reason: 'initial' }).catch(() => {});
  }, [refreshCatalog, refreshRuntime, t]);

  const enabledPluginIds = useMemo(
    () => runtime?.execution.enabledPluginIds ?? [],
    [runtime],
  );
  const enabledPluginIdSet = useMemo(
    () => new Set(enabledPluginIds),
    [enabledPluginIds],
  );
  const togglePluginEnabled = useCallback(async (pluginId: string, nextEnabled: boolean) => {
    try {
      await togglePluginEnabledAction(pluginId, nextEnabled);
    } catch {
      toast.error(t('plugins:errors.togglePluginFailed'));
    }
  }, [togglePluginEnabledAction, t]);
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
              {catalog.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('plugins:catalog.empty')}</p>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-[1.7fr_0.9fr_0.8fr_0.8fr_0.7fr] gap-2 px-3 text-xs text-muted-foreground">
                    <span>{t('plugins:catalog.columns.plugin')}</span>
                    <span>{t('plugins:catalog.columns.platform')}</span>
                    <span>{t('plugins:catalog.columns.kind')}</span>
                    <span>{t('plugins:catalog.columns.version')}</span>
                    <span className="text-right">{t('plugins:catalog.columns.enabled')}</span>
                  </div>
                  {catalog.map((plugin) => (
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
                            || mutatingAction !== null
                            || mutatingPluginId !== null
                          }
                          onCheckedChange={(checked) => {
                            void togglePluginEnabled(plugin.id, checked);
                          }}
                        />
                      </div>
                    </div>
                  ))}
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
