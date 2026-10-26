import { Fragment, Suspense, useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AgentPage, AgentPageSection } from '@/components/common/AgentPage';
import { AgentViewToggle } from '@/components/common/AgentViewToggle';
import { LoadingState } from '@/components/common/LoadingSpinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { selectedSkillsScope } from '@/lib/skills';
import { useContributions } from '@/plugin-host/react';
import { useRuntimeEndpointsStore, selectManagementEndpoint, selectManagementAgentScope } from '@/stores/runtime-endpoints';
import { buildCapabilityScopeKey, runtimeInstanceScope } from '@/types/desktop/runtime-address';
import { skillSources, skillTransfers, type SkillOwnerProps, type SkillSourceView, type SkillViewProps } from './extensions';
import { SkillGatewayBanner } from './presentation';

export function Skills() {
  const sources = useContributions(skillSources);
  const transfers = useContributions(skillTransfers);
  const endpoint = useRuntimeEndpointsStore(selectManagementEndpoint);
  const agentScope = useRuntimeEndpointsStore(selectManagementAgentScope);
  const nativeAgent = endpoint?.kind === 'native-runtime' && endpoint.runtimeAdapterId === 'matcha-agent';
  const openClaw = endpoint?.kind === 'native-runtime' && endpoint.runtimeAdapterId === 'openclaw';
  const scope = useMemo(() => openClaw && endpoint ? runtimeInstanceScope(endpoint) : nativeAgent ? agentScope : null, [openClaw, endpoint, nativeAgent, agentScope]);
  const scopeKey = scope ? buildCapabilityScopeKey(scope) : null;
  const selectionCurrent = useCallback(() => {
    const selected = selectedSkillsScope();
    return Boolean(selected && buildCapabilityScopeKey(selected) === scopeKey);
  }, [scopeKey]);
  const { t } = useTranslation('skills');
  const [searchParams, setSearchParams] = useSearchParams();
  const views = useMemo(() => sources.flatMap((source) => source.views).sort((a, b) => a.order - b.order), [sources]);
  const mainViews = views.filter((sourceView) => sourceView.area === 'main');
  const packageViews = views.filter((sourceView) => sourceView.area === 'packages');
  const tabParam = searchParams.get('tab');
  const activeTab = tabParam === 'sealed' && scope && packageViews.length
    ? 'sealed'
    : mainViews.find((sourceView) => sourceView.id === tabParam)?.id ?? mainViews[0]?.id ?? '';
  const packageTab = packageViews.find((sourceView) => sourceView.id === searchParams.get('packageTab'))?.id ?? packageViews[0]?.id ?? '';
  const activeViewId = activeTab === 'sealed' ? packageTab : activeTab;
  const activeView = views.find((sourceView) => sourceView.id === activeViewId);
  const view = searchParams.get('view') === 'list' ? 'list' : 'grid';
  const context = { scope, scopeKey, openClaw, nativeAgent, selectionCurrent };
  const ownerProps: Omit<SkillOwnerProps, 'children'> = { ...context, activeViewId, view };
  const setTab = (tab: string) => setSearchParams((params) => {
    const next = new URLSearchParams(params);
    next.set('tab', tab);
    return next;
  });
  const setPackageTab = (tab: string) => setSearchParams((params) => {
    const next = new URLSearchParams(params);
    next.set('packageTab', tab);
    return next;
  }, { replace: true });
  const viewControls = <AgentViewToggle value={view} onChange={(value) => setSearchParams((params) => {
    const next = new URLSearchParams(params);
    next.set('view', value);
    return next;
  }, { replace: true })} gridLabel={t('view.grid')} listLabel={t('view.list')} />;
  const tabs = [
    ...mainViews.map((sourceView) => ({ id: sourceView.id, order: sourceView.order, sourceView })),
    ...(scope && packageViews.length ? [{ id: 'sealed', order: 20, sourceView: undefined }] : []),
  ].sort((a, b) => a.order - b.order);
  const packageNavigation = <TabsList aria-label={t('tabs.sealed')} className="shrink-0">
    {packageViews.map((sourceView) => <TabsTrigger key={sourceView.id} value={sourceView.id} className="shrink-0">{t(sourceView.label)}</TabsTrigger>)}
  </TabsList>;

  const renderToolbar = (sourceView: SkillSourceView, navigation?: ReactNode) => {
    const props: SkillViewProps = { ...context, active: true, view };
    const Toolbar = sourceView.toolbar;
    const entries = transfers.flatMap((transfer) => transfer.toolbarEntries
      .filter((entry) => entry.viewId === sourceView.id)
      .map((entry, index) => <entry.component key={`${transfer.id}:${index}`} {...props} />));
    return Toolbar && <Toolbar {...props} navigation={navigation} entries={entries} viewControls={viewControls} />;
  };
  const Component = activeView?.component;
  const HeaderActions = activeView?.headerActions;

  let content: ReactNode = <AgentPage>
    <Tabs value={activeTab} onValueChange={setTab} className="group/skills space-y-6" data-view={view}>
      <AgentPageSection actions={HeaderActions && <HeaderActions key={activeViewId} {...context} active view={view} />}>
        <TabsList variant="line" aria-label={t('title')}>
          {tabs.map(({ id, sourceView }) => {
            const Badge = sourceView?.badge;
            return <TabsTrigger key={id} value={id} className={Badge ? 'gap-2' : undefined}>
              {t(sourceView?.label ?? 'tabs.sealed')}
              {Badge && <Badge {...context} active={activeViewId === id} view={view} />}
            </TabsTrigger>;
          })}
        </TabsList>
      </AgentPageSection>
      {!scope && <p className="text-sm text-muted-foreground">{t('common:runtimeScope.none')}</p>}
      <SkillGatewayBanner />
      {activeView && Component && (activeTab === 'sealed' ? (
        <TabsContent value="sealed" className="space-y-5 mt-6">
          <Tabs value={packageTab} onValueChange={setPackageTab} className="min-w-0 space-y-5">
            {renderToolbar(activeView, packageNavigation)}
            <TabsContent key={activeViewId} value={packageTab} className="mt-0 space-y-4">
              <Component {...context} active view={view} />
            </TabsContent>
          </Tabs>
        </TabsContent>
      ) : (
        <TabsContent key={activeViewId} value={activeTab} className="space-y-6 mt-6">
          {renderToolbar(activeView)}
          <Component {...context} active view={view} />
        </TabsContent>
      ))}
    </Tabs>
  </AgentPage>;

  for (const transfer of [...transfers].reverse()) {
    const Owner = transfer.owner;
    content = <Owner key={`transfer:${transfer.id}`} {...ownerProps}>{content}</Owner>;
  }
  for (const source of [...sources].reverse()) {
    const Owner = source.owner;
    if (Owner) content = <Owner key={`source:${source.id}`} {...ownerProps}>{content}</Owner>;
  }
  return <Suspense fallback={<LoadingState label={t('common:status.loading')} />}><Fragment>{content}</Fragment></Suspense>;
}

export default Skills;
