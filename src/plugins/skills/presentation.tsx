import { createContext, useContext, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, FolderOpen, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { invokeIpc } from '@/lib/api-client';
import { hostOpenClawGetSkillsDir } from '@/lib/host-api';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/plugins/runtime/store';
import type { GatewayStatus } from '@/types/gateway';
import type { Skill } from '@/types/skill';
import type { SkillOwnerProps, SkillScopeContext, SkillViewProps } from './extensions';
import { useSkillsStore } from './stores/skills';
import { useSealedSkillsStore } from './stores/sealed-skills';

export const SKILL_CARD_DESCRIPTION_CLASS_NAME = 'mt-3 min-h-10 line-clamp-2 text-sm leading-5 text-muted-foreground group-data-[view=list]/skills:mt-2 group-data-[view=list]/skills:min-h-0';
export const SKILL_CARD_ICON_CLASS_NAME = 'size-11';
export const PACKAGE_CARD_FOOTER_CLASS_NAME = 'rounded-none border-t bg-transparent px-0 pb-0 pt-3 ring-0 [border-color:hsl(var(--shell-border))]';

export function normalizeSkillErrorCode(error: string): string {
  return error.replace(/^Error:\s*/, '');
}

export function buildMarketplaceSkillUrl(slug: string): string {
  return `https://cn.clawhub-mirror.com/s/${slug}`;
}

export function isPackageDigest(version?: string): boolean {
  return /^[a-f0-9]{64}$/i.test(version || '');
}

export function resolveSkillSourceLabel(skill: Skill, t: (key: string, options?: Record<string, unknown>) => string): string {
  const source = (skill.source || '').trim().toLowerCase();
  if (!source) return t(skill.isBundled ? 'source.badge.bundled' : 'source.badge.unknown');
  if (source === 'bundled' || source === 'openclaw-bundled') return t('source.badge.bundled');
  if (source === 'managed' || source === 'openclaw-managed') return t('source.badge.managed');
  if (source === 'openclaw-workspace') return t('source.badge.workspace');
  if (source === 'openclaw-extra') return t('source.badge.extra');
  if (source === 'agents-skills-personal') return t('source.badge.agentsPersonal');
  if (source === 'agents-skills-project') return t('source.badge.agentsProject');
  return source;
}

const SkillsDirectoryContext = createContext('~/.openclaw/skills');

export function useSkillsDirectoryPath(): string {
  return useContext(SkillsDirectoryContext);
}

function useSkillsDirectory(openClaw: boolean): string {
  const [path, setPath] = useState(openClaw ? '~/.openclaw/skills' : '');
  const [previousOpenClaw, setPreviousOpenClaw] = useState(openClaw);
  if (previousOpenClaw !== openClaw) {
    setPreviousOpenClaw(openClaw);
    if (!openClaw) setPath('');
  }
  useEffect(() => {
    if (!openClaw) return;
    let cancelled = false;
    hostOpenClawGetSkillsDir()
      .then((dir) => { if (!cancelled) setPath(dir); })
      .catch(console.error);
    return () => { cancelled = true; };
  }, [openClaw]);
  return path;
}

type SkillsGatewayBannerState = 'none' | 'starting' | 'stopped';

function getSkillsGatewayBannerState(status: GatewayStatus, skillsFeatureReady: boolean): SkillsGatewayBannerState {
  if (status.processState === 'starting' || status.processState === 'control_connecting' || status.processState === 'reconnecting') return 'starting';
  if (status.processState === 'running' && !(status.gatewayReady === true || skillsFeatureReady)) return 'starting';
  if (status.processState === 'stopped' || status.processState === 'error') return 'stopped';
  return 'none';
}

const GatewayBannerContext = createContext<{ state: SkillsGatewayBannerState; visible: boolean }>({ state: 'none', visible: false });

export function SkillRuntimeOwner({ scope, scopeKey, openClaw, children }: SkillOwnerProps) {
  const skillsDirPath = useSkillsDirectory(openClaw);
  const [searchParams] = useSearchParams();
  const isSealedTabActive = searchParams.get('tab') === 'sealed' && Boolean(scope);
  const gatewayStatus = useGatewayStore((state) => state.status);
  const snapshotReady = useSkillsStore((state) => state.snapshotReady);
  const storeScopeKey = useSkillsStore((state) => state.scopeKey);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const gatewayProcessRunning = openClaw ? gatewayStatus.processState === 'running' : Boolean(scope);
  const gatewayReportedReady = openClaw ? gatewayStatus.gatewayReady === true : snapshotReady && storeScopeKey === scopeKey;
  const gatewayRuntimeKey = `${gatewayStatus.pid ?? 'none'}:${gatewayStatus.connectedAt ?? 'none'}:${gatewayStatus.port}`;
  const [skillsFeatureReady, setSkillsFeatureReady] = useState(() => gatewayProcessRunning && gatewayReportedReady);
  const state = openClaw ? getSkillsGatewayBannerState(gatewayStatus, skillsFeatureReady) : 'none';
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(state !== 'none'), state === 'none' ? 0 : 1500);
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    useSkillsStore.getState().setScope(scope);
    useSealedSkillsStore.getState().setScope(scope);
    if (scope) void fetchSkills({ force: true });
  }, [scopeKey, scope, fetchSkills]);

  useEffect(() => {
    if (!openClaw) return;
    if (!gatewayProcessRunning) {
      setSkillsFeatureReady(false);
      return;
    }
    setSkillsFeatureReady(gatewayReportedReady);
    let cancelled = false;
    const attemptFetch = async (force: boolean) => {
      await fetchSkills({ force, silent: true });
      if (!cancelled && !useSkillsStore.getState().error) setSkillsFeatureReady(true);
    };
    if (!isSealedTabActive && (!snapshotReady || !gatewayReportedReady)) {
      void attemptFetch(!snapshotReady || !skillsFeatureReady);
    }
    return () => { cancelled = true; };
  }, [openClaw, fetchSkills, gatewayProcessRunning, gatewayReportedReady, gatewayRuntimeKey, isSealedTabActive, skillsFeatureReady, snapshotReady]);

  return <SkillsDirectoryContext.Provider value={skillsDirPath}>
    <GatewayBannerContext.Provider value={{ state, visible }}>{children}</GatewayBannerContext.Provider>
  </SkillsDirectoryContext.Provider>;
}

export function SkillGatewayBanner() {
  const { t } = useTranslation('skills');
  const { state, visible } = useContext(GatewayBannerContext);
  if (!visible || state === 'none') return null;
  return (
    <Card className={cn(state === 'starting' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/10' : 'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10')}>
      <CardContent className="py-4 flex items-center gap-3">
        <AlertCircle className={cn('h-5 w-5', state === 'starting' ? 'text-blue-600' : 'text-yellow-600')} />
        <span className={cn(state === 'starting' ? 'text-blue-700 dark:text-blue-400' : 'text-yellow-700 dark:text-yellow-400')}>
          {state === 'starting' ? t('gatewayStarting') : t('gatewayWarning')}
        </span>
      </CardContent>
    </Card>
  );
}

export function SkillRefreshButton({ refreshing, disabled, onClick }: { refreshing: boolean; disabled: boolean; onClick: () => void }) {
  const { t } = useTranslation('skills');
  return (
    <Button variant="outline" size="icon" className="size-9 rounded-full" aria-label={t('refresh')} title={t('refresh')} onClick={onClick} disabled={disabled}>
      <RefreshCw className={cn('size-4', refreshing && 'animate-spin motion-reduce:animate-none')} />
    </Button>
  );
}

export function SkillFolderButton({ openClaw, scopeKey }: SkillScopeContext) {
  const { t } = useTranslation('skills');
  const hasInstalledSkills = useSkillsStore((state) => state.scopeKey === scopeKey && state.skills.some((skill) => !skill.isBundled));
  if (!openClaw || !hasInstalledSkills) return null;
  const openFolder = async () => {
    try {
      const skillsDir = await hostOpenClawGetSkillsDir();
      if (!skillsDir) throw new Error('Skills directory not available');
      const result = await invokeIpc<string>('shell:openPath', skillsDir);
      if (result) {
        if (result.toLowerCase().includes('no such file') || result.toLowerCase().includes('not found') || result.toLowerCase().includes('failed to open')) toast.error(t('toast.failedFolderNotFound'));
        else throw new Error(result);
      }
    } catch (error) {
      toast.error(t('toast.failedOpenFolder') + ': ' + String(error));
    }
  };
  return <Button variant="outline" size="sm" className="h-9 gap-2 rounded-full" onClick={() => { void openFolder(); }}><FolderOpen className="size-4" />{t('openFolder')}</Button>;
}

export function SkillDefaultHeaderActions(props: SkillViewProps) {
  const refreshing = useSkillsStore((state) => state.refreshing);
  const mutating = useSkillsStore((state) => state.mutating);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const processState = useGatewayStore((state) => state.status.processState);
  const running = props.openClaw ? processState === 'running' : Boolean(props.scope);
  return <>
    <SkillRefreshButton refreshing={refreshing} disabled={!running || refreshing || mutating} onClick={() => { void fetchSkills({ force: true, fresh: true }); }} />
    <SkillFolderButton {...props} />
  </>;
}
