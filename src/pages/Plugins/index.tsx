import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Box, Loader2, Search } from 'lucide-react';
import { AgentViewToggle } from '@/components/common/AgentViewToggle';
import { AgentPage, AgentPageSection, AgentPageToolbar, AgentResourceCard, AgentResourceFooter, AgentResourceGrid, AgentResourceIcon, AgentResourcePill } from '@/components/common/AgentPage';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { usePluginsStore } from '@/stores/plugins-store';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

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
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('q') ?? '';
  const kindFilter = searchParams.get('kind') ?? 'all';
  const statusFilter = searchParams.get('status') ?? 'all';
  const view = searchParams.get('view') === 'list' ? 'list' : 'grid';
  const updateFilter = (key: string, value: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === '' || (key !== 'q' && value === 'all') || (key === 'view' && value === 'grid')) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  };

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
  const visiblePlugins = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return catalog.filter((plugin) => (
      (kindFilter === 'all' || plugin.kind === kindFilter)
      && (statusFilter === 'all' || enabledPluginIdSet.has(plugin.id) === (statusFilter === 'enabled'))
      && (!query || [plugin.name, plugin.id, plugin.description, plugin.platform, plugin.version]
        .some((value) => value?.toLocaleLowerCase().includes(query)))
    ));
  }, [catalog, enabledPluginIdSet, kindFilter, search, statusFilter]);

  return (
    <AgentPage>
      <AgentPageSection>
        <h2 className="flex min-h-12 items-center gap-2 border-b-2 border-foreground pb-3 text-sm font-medium">
          {t('plugins:catalog.title')}
          {catalogReady && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{catalog.length}</Badge>}
        </h2>
      </AgentPageSection>

      <AgentPageToolbar>
        <div className="relative w-full sm:w-[300px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input className="h-10 pl-9 text-sm" aria-label={t('plugins:catalog.search')} placeholder={t('plugins:catalog.search')} value={search} onChange={(event) => updateFilter('q', event.target.value)} />
        </div>
        <Select className="h-10 w-auto min-w-28 text-sm" aria-label={t('plugins:catalog.columns.kind')} value={kindFilter} onChange={(event) => updateFilter('kind', event.target.value)}>
          <option value="all">{t('plugins:catalog.allTypes')}</option>
          <option value="builtin">{t('plugins:catalog.kind.builtin')}</option>
          <option value="third-party">{t('plugins:catalog.kind.third-party')}</option>
        </Select>
        <Select className="h-10 w-auto min-w-28 text-sm" aria-label={t('plugins:catalog.status')} value={statusFilter} onChange={(event) => updateFilter('status', event.target.value)}>
          <option value="all">{t('plugins:catalog.allStatuses')}</option>
          <option value="enabled">{t('plugins:catalog.enabled')}</option>
          <option value="disabled">{t('plugins:catalog.disabled')}</option>
        </Select>
        <div className="ml-auto flex items-center gap-3">
          {catalogReady && <span className="text-xs text-muted-foreground">{t('plugins:catalog.count', { count: visiblePlugins.length })}</span>}
          <AgentViewToggle value={view} onChange={(value) => updateFilter('view', value)} gridLabel={t('plugins:catalog.gridView')} listLabel={t('plugins:catalog.listView')} />
        </div>
      </AgentPageToolbar>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {t(error)}
        </p>
      )}

      {showCatalogLoading ? (
        <AgentResourceGrid aria-busy="true" className={cn(view === 'list' && 'md:grid-cols-1 lg:grid-cols-1 xl:grid-cols-1 2xl:grid-cols-1')}>
          {Array.from({ length: 5 }).map((_, index) => (
            <AgentResourceCard key={index} className={cn('gap-4', view === 'grid' && 'min-h-60')}>
              <div className="h-4 w-40 animate-pulse rounded bg-muted" />
              <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
              <div className="h-3 w-2/5 animate-pulse rounded bg-muted" />
            </AgentResourceCard>
          ))}
        </AgentResourceGrid>
      ) : visiblePlugins.length === 0 ? (
        <div className="flex min-h-80 flex-col items-center justify-center gap-5 rounded-[1.75rem] border border-border/70 bg-gradient-to-b from-card to-secondary/20 p-8 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.75),0_24px_64px_rgba(15,23,42,0.04)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <AgentResourceIcon className="size-16 rounded-[1.25rem]"><Box className="size-7" /></AgentResourceIcon>
          <p className="text-sm text-muted-foreground">{t(catalog.length === 0 ? 'plugins:catalog.empty' : 'plugins:catalog.noResults')}</p>
        </div>
      ) : (
        <AgentResourceGrid className={cn(view === 'list' && 'md:grid-cols-1 lg:grid-cols-1 xl:grid-cols-1 2xl:grid-cols-1')}>
          {visiblePlugins.map((plugin) => {
            const enabled = enabledPluginIdSet.has(plugin.id);
            const metadata = (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <AgentResourcePill>{t(`plugins:catalog.platform.${plugin.platform}`)}</AgentResourcePill>
                <AgentResourcePill>{t(`plugins:catalog.kind.${plugin.kind}`)}</AgentResourcePill>
                <span className="min-w-24 tabular-nums">{plugin.version}</span>
              </div>
            );
            const status = (
              <div className="flex w-full shrink-0 items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
                  <span className={cn('size-1.5 rounded-full', enabled ? 'bg-emerald-500' : 'bg-muted-foreground')} />
                  {t(enabled ? 'plugins:catalog.enabled' : 'plugins:catalog.disabled')}
                </span>
                {mutatingPluginId === plugin.id && <Loader2 className="size-3.5 animate-spin" />}
                <Switch
                  aria-label={t('plugins:catalog.toggle', { name: plugin.name })}
                  checked={enabled}
                  disabled={!runtimeReady || runtimePending || mutatingAction !== null || mutatingPluginId !== null}
                  onCheckedChange={(checked) => { void togglePluginEnabled(plugin.id, checked); }}
                />
              </div>
            );
            if (view === 'list') {
              return (
                <AgentResourceCard key={plugin.id} className="gap-3 p-4 lg:flex-row lg:items-center lg:gap-7">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <AgentResourceIcon><Box className="size-5" /></AgentResourceIcon>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-sm font-semibold" title={plugin.name}>{plugin.name}</h3>
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary className="cursor-pointer truncate rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={plugin.description ?? plugin.id}>
                          {plugin.description || plugin.id}
                        </summary>
                        <div className="space-y-2 pt-2">
                          <p>{plugin.id}</p>
                          {plugin.description && <p className="break-words leading-5">{plugin.description}</p>}
                          {plugin.companionSkillSlugs && plugin.companionSkillSlugs.length > 0 && (
                            <p className="break-words leading-5">{t('plugins:catalog.companionSkills', { skills: plugin.companionSkillSlugs.join(', ') })}</p>
                          )}
                        </div>
                      </details>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-4 pl-[52px] lg:shrink-0 lg:gap-8 lg:pl-0">
                    {metadata}
                    <div className="w-28 shrink-0">{status}</div>
                  </div>
                </AgentResourceCard>
              );
            }
            return (
              <AgentResourceCard key={plugin.id} className="min-h-56 gap-3 p-4">
                <div className="flex min-w-0 items-center gap-3">
                  <AgentResourceIcon><Box className="size-5" /></AgentResourceIcon>
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold" title={plugin.name}>{plugin.name}</h3>
                    <p className="mt-1 truncate text-xs text-muted-foreground" title={plugin.id}>{plugin.id}</p>
                  </div>
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-4">
                  {plugin.description && <p className="line-clamp-2 text-sm text-muted-foreground" title={plugin.description}>{plugin.description}</p>}
                  {plugin.companionSkillSlugs && plugin.companionSkillSlugs.length > 0 && (
                    <p className="break-words text-xs text-muted-foreground">
                      {t('plugins:catalog.companionSkills', { skills: plugin.companionSkillSlugs.join(', ') })}
                    </p>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <AgentResourcePill>{t(`plugins:catalog.platform.${plugin.platform}`)}</AgentResourcePill>
                    <AgentResourcePill>{t(`plugins:catalog.kind.${plugin.kind}`)}</AgentResourcePill>
                    <span>{plugin.version}</span>
                  </div>
                </div>
                <AgentResourceFooter>{status}</AgentResourceFooter>
              </AgentResourceCard>
            );
          })}
        </AgentResourceGrid>
      )}
    </AgentPage>
  );
}

export default PluginsPage;
