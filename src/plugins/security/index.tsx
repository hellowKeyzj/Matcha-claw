import { Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useGatewayStore } from '@/plugins/runtime/store';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { isGatewayOperational, isGatewayPreparing } from '@/lib/gateway-status';
import { useContributions } from '@/plugin-host/react';
import { useTranslation } from 'react-i18next';
import { useSecurityPolicyStore } from './security-policy-store';
import { useSecuritySupportStore } from './security-support-store';
import { securitySections } from './extensions';

export function SecurityPage() {
  const { t } = useTranslation('security');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const gatewayInitialized = useGatewayStore((state) => state.isInitialized);
  const gatewayProcessState = gatewayStatus.processState;
  const gatewayOperational = isGatewayOperational(gatewayStatus);
  const gatewayPreparing = isGatewayPreparing(gatewayStatus, gatewayInitialized);
  const lastGatewayOperationalRef = useRef(gatewayOperational);

  const policyReady = useSecurityPolicyStore((state) => state.policyReady);
  const initialLoading = useSecurityPolicyStore((state) => state.initialLoading);
  const refreshing = useSecurityPolicyStore((state) => state.refreshing);
  const policy = useSecurityPolicyStore((state) => state.policy);
  const savedPolicySnapshot = useSecurityPolicyStore((state) => state.savedPolicySnapshot);
  const loadPolicy = useSecurityPolicyStore((state) => state.loadPolicy);
  const savePolicy = useSecurityPolicyStore((state) => state.savePolicy);
  const saving = useSecurityPolicyStore((state) => state.mutating);
  const policyError = useSecurityPolicyStore((state) => state.error);
  const platformToolsHydrated = useSecuritySupportStore((state) => state.platformToolsHydrated);
  const loadPlatformTools = useSecuritySupportStore((state) => state.loadPlatformTools);
  const loadRuleCatalog = useSecuritySupportStore((state) => state.loadRuleCatalog);
  const loadRecentAudits = useSecuritySupportStore((state) => state.loadRecentAudits);
  const activeSection = useSecuritySupportStore((state) => state.activeSection);
  const setActiveSection = useSecuritySupportStore((state) => state.setActiveSection);
  const showPolicyRefreshingHint = useDelayedFlag(refreshing, 180);
  const policyControlsDisabled = !policyReady || initialLoading || refreshing;
  const contributions = useContributions(securitySections);
  const sections = useMemo(() => [...contributions].sort((a, b) => a.order - b.order), [contributions]);
  const ActiveSection = sections.find((section) => section.id === activeSection)?.component;

  useEffect(() => {
    void loadPolicy({ silent: true });
  }, [loadPolicy]);

  useEffect(() => {
    const previousGatewayOperational = lastGatewayOperationalRef.current;
    lastGatewayOperationalRef.current = gatewayOperational;
    if (!previousGatewayOperational && gatewayOperational) {
      const state = useSecurityPolicyStore.getState();
      const hasUnsavedPolicyChange = JSON.stringify(state.policy) !== JSON.stringify(state.savedPolicySnapshot);
      if (!state.policyReady || !hasUnsavedPolicyChange) {
        void loadPolicy({ silent: true });
      }
    }
  }, [gatewayOperational, loadPolicy]);

  const handleSavePolicy = useCallback(async () => {
    if (!gatewayOperational) {
      toast.error(gatewayPreparing ? t('actionCenter.gatewayPreparing') : t('actionCenter.gatewayNotRunning'));
      return;
    }
    try {
      await savePolicy();
      const saveError = useSecurityPolicyStore.getState().error;
      if (saveError) {
        toast.error(saveError.startsWith('errors.') ? t(saveError) : saveError);
        return;
      }
      toast.success(t('messages.saved'));
    } catch {
      toast.error(t('messages.saveFailed'));
    }
  }, [gatewayOperational, gatewayPreparing, savePolicy, t]);

  useEffect(() => {
    void loadRecentAudits({ gatewayProcessState, page: 1, pageSize: 8 });
  }, [gatewayProcessState, loadRecentAudits]);

  useEffect(() => {
    if (activeSection !== 'allowlistRegex' || platformToolsHydrated) return;
    void loadPlatformTools({ refresh: false });
  }, [activeSection, loadPlatformTools, platformToolsHydrated]);

  useEffect(() => {
    void loadRuleCatalog();
  }, [loadRuleCatalog]);
  const isDirty = useMemo(
    () => JSON.stringify(policy) !== JSON.stringify(savedPolicySnapshot),
    [policy, savedPolicySnapshot],
  );

  if (!policyReady && initialLoading) {
    return <section className="space-y-4"><p className="text-sm text-muted-foreground">{t('loading')}</p></section>;
  }

  return (
    <section className="flex flex-col gap-6 text-foreground">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.035em] text-foreground">{t('title')}</h1>
          <p className="text-sm text-[hsl(var(--shell-text-muted))]">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          {showPolicyRefreshingHint && (
            <Badge variant="outline" className="text-xs font-normal">
              {t('loading')}
            </Badge>
          )}
          {isDirty && (
            <Badge variant="outline" className="border-amber-500 text-amber-700">
              {t('page.unsaved')}
            </Badge>
          )}
          <Button onClick={() => void handleSavePolicy()} disabled={saving || !isDirty || !gatewayOperational || policyControlsDisabled}>
            {saving ? t('actions.saving') : t('actions.save')}
          </Button>
        </div>
      </header>

      {policyError && (
        <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {policyError.startsWith('errors.') ? t(policyError) : policyError}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <Card className="h-fit bg-[hsl(var(--shell-surface-muted))] [border-color:hsl(var(--shell-border))]">
          <CardContent className="p-2.5">
            <nav className="space-y-1" aria-label={t('sections.navAria')}>
              {sections.map((section) => (
                <Button
                  key={section.id}
                  type="button"
                  variant="ghost"
                  className={`h-10 w-full justify-start rounded-lg border border-transparent px-2.5 text-sm font-medium transition-colors ${
                    activeSection === section.id
                      ? 'bg-[hsl(var(--shell-surface))] text-foreground [border-color:hsl(var(--shell-border))]'
                      : 'text-[hsl(var(--shell-text-muted))] hover:bg-[hsl(var(--shell-surface-hover))] hover:text-foreground'
                  }`}
                  onClick={() => setActiveSection(section.id)}
                >
                  <span
                    aria-hidden
                    className={`mr-2 h-1.5 w-1.5 rounded-full transition-colors ${
                      activeSection === section.id ? 'bg-primary' : 'bg-transparent'
                    }`}
                  />
                  <span className="truncate">{t(section.label)}</span>
                </Button>
              ))}
            </nav>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Suspense fallback={<p className="text-sm text-muted-foreground">{t('loading')}</p>}>
            {ActiveSection && (
              <ActiveSection
                key={activeSection}
                policyControlsDisabled={policyControlsDisabled}
                gatewayOperational={gatewayOperational}
                gatewayPreparing={gatewayPreparing}
                gatewayProcessState={gatewayProcessState}
              />
            )}
          </Suspense>
        </div>
      </div>
    </section>
  );
}

export default SecurityPage;
