import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, Download, Globe, Package, RefreshCw, Search, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AgentPageToolbar, AgentResourceCard, AgentResourceFooter, AgentResourceGrid, AgentResourceIcon, AgentResourcePill } from '@/components/common/AgentPage';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { invokeIpc } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import type { MarketplaceSkill, Skill } from '@/types/skill';
import type { SkillOwnerProps, SkillToolbarProps, SkillViewProps } from '../extensions';
import { buildMarketplaceSkillUrl, normalizeSkillErrorCode, SKILL_CARD_DESCRIPTION_CLASS_NAME, SKILL_CARD_ICON_CLASS_NAME, useSkillsDirectoryPath } from '../presentation';
import { useSkillsStore } from '../stores/skills';

export { SkillDefaultHeaderActions as ClawHubHeaderActions } from '../presentation';

const INSTALL_ERROR_CODES = new Set(['installTimeoutError', 'installRateLimitError']);
const SEARCH_ERROR_CODES = new Set(['searchTimeoutError', 'searchRateLimitError', 'timeoutError', 'rateLimitError']);

interface ClawHubIntent {
  marketplaceQuery: string;
  updateMarketplaceQuery: (query: string) => void;
  search: (event: FormEvent) => void;
  discover: () => void;
  openDetail: (skill: MarketplaceSkill) => void;
  install: (slug: string) => Promise<void>;
  uninstall: (skillKey: string, slug?: string) => Promise<void>;
}

const ClawHubContext = createContext<ClawHubIntent | null>(null);

function findInstalledMarketplaceSkill(skills: Skill[], marketplaceSkill: MarketplaceSkill): Skill | undefined {
  return skills.find((skill) =>
    skill.id === marketplaceSkill.slug
    || skill.slug === marketplaceSkill.slug
    || skill.name === marketplaceSkill.name
  );
}

type MarketplaceSkillAction = 'install' | 'uninstall' | null;

function resolveMarketplaceSkillAction(isInstalled: boolean, canUninstall: boolean): MarketplaceSkillAction {
  if (!isInstalled) return 'install';
  return canUninstall ? 'uninstall' : null;
}

interface MarketplaceSkillCardProps {
  skill: MarketplaceSkill;
  isInstalling: boolean;
  isInstalled: boolean;
  canUninstall: boolean;
  mutationLocked: boolean;
  onOpenDetail: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}

function MarketplaceSkillCard({
  skill,
  isInstalling,
  isInstalled,
  canUninstall,
  mutationLocked,
  onOpenDetail,
  onInstall,
  onUninstall
}: MarketplaceSkillCardProps) {
  const { t } = useTranslation('skills');
  const action = resolveMarketplaceSkillAction(isInstalled, canUninstall);
  return (
    <AgentResourceCard className="relative gap-3 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <AgentResourceIcon className={SKILL_CARD_ICON_CLASS_NAME}><Package className="size-5" aria-hidden="true" /></AgentResourceIcon>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">
            <button type="button" onClick={onOpenDetail} className="after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">
              {skill.name}
            </button>
          </h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">{skill.author || 'ClawHub'}</p>
        </div>
      </div>
      <p className={SKILL_CARD_DESCRIPTION_CLASS_NAME}>{skill.description}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <AgentResourcePill>ClawHub</AgentResourcePill>
        <span>v{skill.version}</span>
        {skill.downloads !== undefined && <span className="inline-flex items-center gap-1"><Download className="size-3" />{skill.downloads.toLocaleString()}</span>}
        {skill.stars !== undefined && <span className="inline-flex items-center gap-1"><Sparkles className="size-3" />{skill.stars.toLocaleString()}</span>}
      </div>
      <AgentResourceFooter>
        <span>{isInstalled ? t('sealed.packageInstalled') : t('sealed.packageAvailable')}</span>
        {action && (
          <Button
            variant="outline"
            size="sm"
            className={cn('relative z-10 h-8 gap-2', action === 'uninstall' && 'text-destructive hover:text-destructive')}
            onClick={action === 'uninstall' ? onUninstall : onInstall}
            disabled={isInstalling || mutationLocked}
          >
            {isInstalling ? <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" /> : action === 'uninstall' ? <Trash2 className="size-3.5" /> : <Download className="size-3.5" />}
            {action === 'uninstall' ? t('actions.uninstall') : t('actions.install')}
          </Button>
        )}
      </AgentResourceFooter>
    </AgentResourceCard>
  );
}

interface MarketplaceSkillDetailDialogProps {
  skill: MarketplaceSkill;
  isInstalling: boolean;
  isInstalled: boolean;
  canUninstall: boolean;
  mutationLocked: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onClose: () => void;
}

function MarketplaceSkillDetailDialog({
  skill,
  isInstalling,
  isInstalled,
  canUninstall,
  mutationLocked,
  onInstall,
  onUninstall,
  onClose,
}: MarketplaceSkillDetailDialogProps) {
  const { t } = useTranslation('skills');
  const action = resolveMarketplaceSkillAction(isInstalled, canUninstall);
  const openMarketplacePage = () => {
    void invokeIpc('shell:openExternal', buildMarketplaceSkillUrl(skill.slug));
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <Card className="w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="flex flex-row items-start justify-between pb-2">
          <div className="flex items-center gap-4 min-w-0">
            <span className="text-4xl shrink-0">📦</span>
            <div className="min-w-0">
              <CardTitle className="text-xl break-words">{skill.name}</CardTitle>
              <CardDescription className="mt-1 text-sm flex min-w-0 items-center gap-2">
                <span className="shrink-0">v{skill.version}</span>
                {skill.author && (
                  <>
                    <span className="shrink-0">•</span>
                    <span className="truncate">{skill.author}</span>
                  </>
                )}
              </CardDescription>
            </div>
          </div>
          <Button variant="ghost" size="icon" aria-label={t('actions.close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <CardContent className="space-y-4 overflow-y-auto">
          <p className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="size-4 shrink-0" />{t('marketplace.securityNote')}</p>
          <div>
            <h3 className="text-sm font-medium text-muted-foreground">{t('detail.description')}</h3>
            <p className="text-sm mt-1 leading-6">{skill.description || '-'}</p>
          </div>

          {(skill.downloads !== undefined || skill.stars !== undefined) && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {skill.downloads !== undefined && (
                <Badge variant="outline" className="gap-1">
                  <Download className="h-3 w-3" />
                  {skill.downloads.toLocaleString()}
                </Badge>
              )}
              {skill.stars !== undefined && (
                <Badge variant="outline" className="gap-1">
                  <Sparkles className="h-3 w-3" />
                  {skill.stars.toLocaleString()}
                </Badge>
              )}
            </div>
          )}
        </CardContent>

        <div className="flex items-center justify-between p-4 border-t bg-muted/10 gap-2">
          <Button variant="outline" className="gap-2" onClick={openMarketplacePage}>
            <Globe className="h-4 w-4" />
            ClawHub
          </Button>
          {action && (
            <Button
              variant={action === 'uninstall' ? 'destructive' : 'default'}
              className="gap-2"
              onClick={action === 'uninstall' ? onUninstall : onInstall}
              disabled={isInstalling || mutationLocked}
            >
              {isInstalling ? (
                <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              ) : action === 'uninstall' ? (
                <Trash2 className="h-4 w-4" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {action === 'uninstall' ? t('actions.uninstall') : t('actions.install')}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

export function ClawHubOwner({ scope, scopeKey, selectionCurrent, activeViewId, children }: SkillOwnerProps) {
  const { t } = useTranslation('skills');
  const [searchParams, setSearchParams] = useSearchParams();
  const marketplaceQuery = searchParams.get('marketSearch') || '';
  const [selectedMarketplaceSkill, setSelectedMarketplaceSkill] = useState<MarketplaceSkill | null>(null);
  const marketplaceDiscoveryAttemptedRef = useRef(false);
  const setSearchQuery = useSkillsStore((state) => state.setSearchQuery);
  const searchSkills = useSkillsStore((state) => state.searchSkills);
  const searching = useSkillsStore((state) => state.searching);
  const installSkill = useSkillsStore((state) => state.installSkill);
  const uninstallSkill = useSkillsStore((state) => state.uninstallSkill);
  const storeScopeKey = useSkillsStore((state) => state.scopeKey);
  const storedSkills = useSkillsStore((state) => state.skills);
  const skills = useMemo(() => storeScopeKey === scopeKey ? storedSkills : [], [storeScopeKey, scopeKey, storedSkills]);
  const installing = useSkillsStore((state) => state.installing);
  const skillsDirPath = useSkillsDirectoryPath();

  const [detailScopeKey, setDetailScopeKey] = useState(scopeKey);
  if (detailScopeKey !== scopeKey) {
    setDetailScopeKey(scopeKey);
    setSelectedMarketplaceSkill(null);
  }

  const updateMarketplaceQuery = useCallback((query: string) => {
    setSearchQuery(query);
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      if (query) next.set('marketSearch', query);
      else next.delete('marketSearch');
      return next;
    }, { replace: true });
  }, [setSearchQuery, setSearchParams]);

  const handleMarketplaceSearch = useCallback((event: FormEvent) => {
    event.preventDefault();
    const trimmedQuery = marketplaceQuery.trim();
    if (!trimmedQuery) return;
    marketplaceDiscoveryAttemptedRef.current = true;
    void searchSkills(trimmedQuery);
  }, [marketplaceQuery, searchSkills]);

  useEffect(() => {
    setSearchQuery(marketplaceQuery);
    if (activeViewId !== 'marketplace') return;
    const trimmedQuery = marketplaceQuery.trim();
    if (!trimmedQuery) return;
    const timer = setTimeout(() => {
      marketplaceDiscoveryAttemptedRef.current = true;
      void searchSkills(trimmedQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [marketplaceQuery, activeViewId, searchSkills, setSearchQuery]);

  useEffect(() => {
    if (activeViewId !== 'marketplace' || marketplaceQuery.trim() || searching || marketplaceDiscoveryAttemptedRef.current) return;
    marketplaceDiscoveryAttemptedRef.current = true;
    void searchSkills('');
  }, [activeViewId, marketplaceQuery, searching, searchSkills]);

  const handleDiscover = useCallback(() => {
    updateMarketplaceQuery('');
    marketplaceDiscoveryAttemptedRef.current = true;
    void searchSkills('');
  }, [updateMarketplaceQuery, searchSkills]);

  const handleInstall = useCallback(async (slug: string) => {
    if (!scope) return;
    try {
      await installSkill(slug, undefined, scope);
      if (!selectionCurrent()) return;
      toast.success(t('toast.installed'));
    } catch (error) {
      if (!selectionCurrent()) return;
      const errorCode = normalizeSkillErrorCode(error instanceof Error ? error.message : String(error));
      if (INSTALL_ERROR_CODES.has(errorCode)) {
        toast.error(t(`toast.${errorCode}`, { path: skillsDirPath }), { duration: 10000 });
      } else {
        toast.error(t('toast.failedInstall') + ': ' + errorCode);
      }
    }
  }, [installSkill, scope, selectionCurrent, t, skillsDirPath]);

  const handleUninstall = useCallback(async (skillKey: string, slug?: string) => {
    try {
      await uninstallSkill(skillKey, slug);
      if (!selectionCurrent()) return;
      toast.success(t('toast.uninstalled'));
    } catch (error) {
      if (selectionCurrent()) toast.error(t('toast.failedUninstall') + ': ' + String(error));
    }
  }, [uninstallSkill, selectionCurrent, t]);

  const selectedInstalledMarketplaceSkill = useMemo(() => selectedMarketplaceSkill
    ? findInstalledMarketplaceSkill(skills, selectedMarketplaceSkill)
    : undefined, [skills, selectedMarketplaceSkill]);
  const selectedMarketplaceInstalling = selectedMarketplaceSkill
    ? Boolean(installing[selectedMarketplaceSkill.slug] || installing[selectedInstalledMarketplaceSkill?.id ?? ''])
    : false;

  return (
    <ClawHubContext.Provider value={{ marketplaceQuery, updateMarketplaceQuery, search: handleMarketplaceSearch, discover: handleDiscover, openDetail: setSelectedMarketplaceSkill, install: handleInstall, uninstall: handleUninstall }}>
      {children}
      {selectedMarketplaceSkill && (
        <MarketplaceSkillDetailDialog
          skill={selectedMarketplaceSkill}
          isInstalled={selectedInstalledMarketplaceSkill !== undefined}
          isInstalling={selectedMarketplaceInstalling}
          canUninstall={selectedInstalledMarketplaceSkill?.uninstallable === true}
          mutationLocked={!scope}
          onInstall={() => { void handleInstall(selectedMarketplaceSkill.slug); }}
          onUninstall={() => { void handleUninstall(selectedInstalledMarketplaceSkill?.id ?? selectedMarketplaceSkill.slug, selectedMarketplaceSkill.slug); }}
          onClose={() => setSelectedMarketplaceSkill(null)}
        />
      )}
    </ClawHubContext.Provider>
  );
}

export function ClawHubToolbar({ active, entries, viewControls }: SkillToolbarProps) {
  const { t } = useTranslation('skills');
  const { marketplaceQuery, updateMarketplaceQuery, search, discover } = useContext(ClawHubContext)!;
  const searching = useSkillsStore((state) => state.searching);
  if (!active) return null;
  return (
    <AgentPageToolbar>
      <form onSubmit={search} className="flex min-w-0 flex-1 gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            aria-label={t('searchMarketplace')}
            placeholder={t('searchMarketplace')}
            value={marketplaceQuery}
            onChange={(event) => updateMarketplaceQuery(event.target.value)}
            className="h-9 pl-9 pr-9 text-sm"
          />
          {marketplaceQuery && (
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('actions.clearSearch')}
              onClick={() => updateMarketplaceQuery('')}
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <Button type="submit" disabled={searching} className="h-9 gap-2">
          {searching && <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
          <span>{searching ? t('marketplace.searching') : t('searchButton')}</span>
        </Button>
      </form>
      {entries}
      <Button type="button" variant="outline" disabled={searching} onClick={discover}>{t('marketplace.discover')}</Button>
      {viewControls}
    </AgentPageToolbar>
  );
}

export function ClawHubView({ active, scope, scopeKey, view }: SkillViewProps) {
  const { t } = useTranslation('skills');
  const { marketplaceQuery, openDetail, install, uninstall } = useContext(ClawHubContext)!;
  const searchResults = useSkillsStore((state) => state.searchResults);
  const searching = useSkillsStore((state) => state.searching);
  const searchError = useSkillsStore((state) => state.searchError);
  const storeScopeKey = useSkillsStore((state) => state.scopeKey);
  const storedSkills = useSkillsStore((state) => state.skills);
  const skills = useMemo(() => storeScopeKey === scopeKey ? storedSkills : [], [storeScopeKey, scopeKey, storedSkills]);
  const installing = useSkillsStore((state) => state.installing);
  const skillsDirPath = useSkillsDirectoryPath();
  if (!active) return null;
  return (
    <div className="flex flex-col gap-4">
      {searchError && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="py-3 text-sm text-destructive flex items-start gap-2">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>
              {SEARCH_ERROR_CODES.has(normalizeSkillErrorCode(searchError))
                ? t(`toast.${normalizeSkillErrorCode(searchError)}`, { path: skillsDirPath })
                : searchError}
            </span>
          </CardContent>
        </Card>
      )}
      {searchResults.length > 0 ? (
        <AgentResourceGrid className={view === 'list' ? 'md:grid-cols-1 xl:grid-cols-1' : undefined}>
          {searchResults.map((skill) => {
            const installedSkill = findInstalledMarketplaceSkill(skills, skill);
            return (
              <MarketplaceSkillCard
                key={skill.slug}
                skill={skill}
                isInstalling={Boolean(installing[skill.slug] || installing[installedSkill?.id ?? ''])}
                isInstalled={installedSkill !== undefined}
                canUninstall={installedSkill?.uninstallable === true}
                mutationLocked={!scope}
                onOpenDetail={() => openDetail(skill)}
                onInstall={() => { void install(skill.slug); }}
                onUninstall={() => { void uninstall(installedSkill?.id ?? skill.slug, skill.slug); }}
              />
            );
          })}
        </AgentResourceGrid>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Package className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">{t('marketplace.title')}</h3>
            <p className="text-muted-foreground text-center max-w-sm">
              {searching
                ? t('marketplace.searching')
                : marketplaceQuery
                  ? t('marketplace.noResults')
                  : t('marketplace.emptyPrompt')}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
