/**
 * Skills Page
 * Browse and manage AI skills
 */
import { memo, useDeferredValue, useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AgentPage, AgentPageSection, AgentPageToolbar, AgentResourceGrid, AgentResourceCard, AgentResourceFooter, AgentResourceIcon, AgentResourcePill } from '@/components/common/AgentPage';
import { Select } from '@/components/ui/select';
import { AgentViewToggle } from '@/components/common/AgentViewToggle';
import {
  Search,
  Puzzle,
  RefreshCw,
  Lock,
  Package,
  X,
  Settings,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ShieldCheck,
  ChevronRight,
  Sparkles,
  Download,
  Trash2,
  Globe,
  FileCode,
  Plus,
  Save,
  Key,
  ChevronDown,
  FolderOpen,
  Copy,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSkillsStore } from '@/stores/skills';
import { SEALED_SKILL_CLOUD_UNAVAILABLE_ERROR, getSealedSkillCloudPackageKey, useSealedSkillsStore } from '@/stores/sealed-skills';
import { useGatewayStore } from '@/stores/gateway';
import {
  hostApiFetch,
  hostOpenClawGetSkillsDir,
  resolveSingleCapabilityScope,
} from '@/lib/host-api';
import type { CapabilityTarget } from '../../../electron/desktop-contract/capability-target';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';
import { invokeIpc } from '@/lib/api-client';
import { readLocalSkillImport } from '@/services/local-path-picker';
import { scheduleIdleReady } from '@/lib/idle-ready';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { trackUiEvent } from '@/lib/telemetry';
import { toast } from 'sonner';
import type { Skill, MarketplaceSkill, SealedSkillCloudPackage, SealedSkillMetadata, SkillMissingRequirements } from '@/types/skill';
import type { GatewayStatus } from '@/types/gateway';
import { useTranslation } from 'react-i18next';

type SkillAvailabilityKind = 'eligible' | 'missing' | 'disabled' | 'unselectable' | 'unknown';
const SKILL_MANAGEMENT_CAPABILITY_ID = 'skill.management';
const SKILLS_HEAVY_CONTENT_IDLE_TIMEOUT_MS = 320;
const CLAWHUB_MARKETPLACE_PRIMARY_URL = 'https://cn.clawhub-mirror.com';
const SKILL_CARD_DESCRIPTION_CLASS_NAME = 'mt-3 min-h-10 line-clamp-2 text-sm leading-5 text-muted-foreground group-data-[view=list]/skills:mt-2 group-data-[view=list]/skills:min-h-0';
const SKILL_CARD_ICON_CLASS_NAME = 'size-11';
const INSTALL_ERROR_CODES = new Set(['installTimeoutError', 'installRateLimitError']);
const FETCH_ERROR_CODES = new Set(['fetchTimeoutError', 'fetchRateLimitError', 'timeoutError', 'rateLimitError']);
const SEARCH_ERROR_CODES = new Set(['searchTimeoutError', 'searchRateLimitError', 'timeoutError', 'rateLimitError']);
type SkillsGatewayBannerState = 'none' | 'starting' | 'stopped';

async function skillManagementCapabilityExecute<TResult>(
  operationId: string,
  input: Record<string, unknown>,
  target: CapabilityTarget,
): Promise<TResult> {
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId,
      scope: await resolveSingleCapabilityScope(SKILL_MANAGEMENT_CAPABILITY_ID),
      target,
      input,
    }),
  });
}

function isSkillsGatewayReady(status: GatewayStatus, skillsFeatureReady: boolean): boolean {
  return status.processState === 'running' && (status.gatewayReady === true || skillsFeatureReady);
}

function getSkillsGatewayBannerState(
  status: GatewayStatus,
  skillsFeatureReady: boolean,
): SkillsGatewayBannerState {
  if (
    status.processState === 'starting'
    || status.processState === 'control_connecting'
    || status.processState === 'reconnecting'
  ) {
    return 'starting';
  }
  if (status.processState === 'running' && !isSkillsGatewayReady(status, skillsFeatureReady)) {
    return 'starting';
  }
  if (status.processState === 'stopped' || status.processState === 'error') {
    return 'stopped';
  }
  return 'none';
}

function normalizeSkillErrorCode(error: string): string {
  return error.replace(/^Error:\s*/, '');
}

function buildMarketplaceSkillUrl(slug: string) {
  return `${CLAWHUB_MARKETPLACE_PRIMARY_URL}/s/${slug}`;
}

function getSkillAvailabilityKind(skill: Skill): SkillAvailabilityKind {
  if (!skill.enabled || skill.unavailableReason === 'disabled') return 'disabled';
  if (skill.unavailableReason === 'missingRequirements' || formatMissingSummary(skill.missing) || (skill.missingCategories?.length ?? 0) > 0) return 'missing';
  if (skill.eligible === true) return 'eligible';
  if (skill.selectable === false || skill.unavailableReason === 'ineligible') return 'unselectable';
  return 'unknown';
}

function findInstalledMarketplaceSkill(skills: Skill[], marketplaceSkill: MarketplaceSkill): Skill | undefined {
  return skills.find((skill) =>
    skill.id === marketplaceSkill.slug
    || skill.slug === marketplaceSkill.slug
    || skill.name === marketplaceSkill.name
  );
}

function getAvailabilityBadgeClass(kind: SkillAvailabilityKind): string {
  switch (kind) {
    case 'eligible':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
    case 'missing':
      return 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400';
    case 'disabled':
      return 'border-muted bg-muted/20 text-muted-foreground';
    default:
      return 'border-muted bg-muted/10 text-muted-foreground';
  }
}

function formatMissingSummary(missing?: SkillMissingRequirements): string {
  if (!missing) return '';
  const parts: string[] = [];
  if (missing.bins?.length) parts.push(...missing.bins.map((value) => `bin:${value}`));
  if (missing.anyBins?.length) parts.push(`any-bin:${missing.anyBins.join('|')}`);
  if (missing.env?.length) parts.push(...missing.env.map((value) => `env:${value}`));
  if (missing.config?.length) parts.push(...missing.config.map((value) => `config:${value}`));
  if (missing.os?.length) parts.push(...missing.os.map((value) => `os:${value}`));
  return parts.join(', ');
}

function formatMissingCategories(skill: Skill): string {
  if (!skill.missingCategories?.length) return '';
  return skill.missingCategories.map((category) => {
    if (category === 'binaries') return 'bin';
    if (category === 'anyBinaries') return 'any-bin';
    if (category === 'environment') return 'env';
    if (category === 'configuration') return 'config';
    return 'os';
  }).join(', ');
}

function formatSkillMissingSummary(skill: Skill): string {
  return formatMissingSummary(skill.missing) || formatMissingCategories(skill);
}

function resolveAvailabilityLabel(kind: SkillAvailabilityKind, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (kind === 'disabled') return t('detail.disabled');
  if (kind === 'unselectable') return t('availability.unselectable', { defaultValue: 'Unavailable' });
  return t(`availability.${kind}`);
}

function resolveSkillSourceLabel(skill: Skill, t: (key: string, options?: Record<string, unknown>) => string): string {
  const source = (skill.source || '').trim().toLowerCase();
  if (!source) {
    if (skill.isBundled) {
      return t('source.badge.bundled');
    }
    return t('source.badge.unknown');
  }
  if (source === 'bundled' || source === 'openclaw-bundled') return t('source.badge.bundled');
  if (source === 'managed' || source === 'openclaw-managed') return t('source.badge.managed');
  if (source === 'openclaw-workspace') return t('source.badge.workspace');
  if (source === 'openclaw-extra') return t('source.badge.extra');
  if (source === 'agents-skills-personal') return t('source.badge.agentsPersonal');
  if (source === 'agents-skills-project') return t('source.badge.agentsProject');
  return source;
}




// Skill detail dialog component
interface SkillDetailDialogProps {
  skill: Skill;
  onClose: () => void;
  onToggle: (enabled: boolean) => void;
  onOpenFolder?: (skill: Skill) => Promise<void> | void;
}

function SkillDetailDialog({ skill, onClose, onToggle, onOpenFolder }: SkillDetailDialogProps) {
  const { t } = useTranslation('skills');
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const [activeTab, setActiveTab] = useState('info');
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [apiKey, setApiKey] = useState('');
  const [isEnvExpanded, setIsEnvExpanded] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const availabilityKind = getSkillAvailabilityKind(skill);
  const missingSummary = formatSkillMissingSummary(skill);
  const availabilityLabel = resolveAvailabilityLabel(availabilityKind, t);

  // Initialize config from skill
  useEffect(() => {
    // API Key
    if (skill.config?.apiKey) {
      setApiKey(String(skill.config.apiKey));
    } else {
      setApiKey('');
    }

    // Env Vars
    if (skill.config?.env) {
      const vars = Object.entries(skill.config.env).map(([key, value]) => ({
        key,
        value: String(value),
      }));
      setEnvVars(vars);
    } else {
      setEnvVars([]);
    }
  }, [skill.config]);

  const handleOpenClawhub = async () => {
    if (skill.slug) {
      await invokeIpc('shell:openExternal', buildMarketplaceSkillUrl(skill.slug));
    }
  };

  const handleOpenEditor = async () => {
    if (!skill?.id) return;
    try {
      const result = await skillManagementCapabilityExecute<{ success: boolean; error?: string }>(
        'clawhub.openReadme',
        {
          skillKey: skill.id,
          slug: skill.slug,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
        },
        { kind: 'skill', skillId: skill.id, slug: skill.slug },
      );
      if (result.success) {
        toast.success(t('toast.openedEditor'));
      } else {
        toast.error(result.error || t('toast.failedEditor'));
      }
    } catch (err) {
      toast.error(t('toast.failedEditor') + ': ' + String(err));
    }
  };

  const handleCopyPath = async () => {
    const path = skill.baseDir || skill.filePath;
    if (!path) {
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
      toast.success(t('toast.copiedPath'));
    } catch (err) {
      toast.error(t('toast.failedCopyPath') + ': ' + String(err));
    }
  };

  const handleAddEnv = () => {
    setEnvVars([...envVars, { key: '', value: '' }]);
  };

  const handleUpdateEnv = (index: number, field: 'key' | 'value', value: string) => {
    const newVars = [...envVars];
    newVars[index] = { ...newVars[index], [field]: value };
    setEnvVars(newVars);
  };

  const handleRemoveEnv = (index: number) => {
    const newVars = [...envVars];
    newVars.splice(index, 1);
    setEnvVars(newVars);
  };

  const handleSaveConfig = async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      // Build env object, filtering out empty keys
      const envObj = envVars.reduce((acc, curr) => {
        const key = curr.key.trim();
        const value = curr.value.trim();
        if (key) {
          acc[key] = value;
        }
        return acc;
      }, {} as Record<string, string>);

      const result = await skillManagementCapabilityExecute<{ success: boolean; error?: string }>(
        'skills.updateConfig',
        {
          skillKey: skill.id,
          apiKey: apiKey || '',
          env: envObj,
        },
        { kind: 'skill', skillId: skill.id, slug: skill.slug },
      );

      if (!result.success) {
        throw new Error(result.error || 'Unknown error');
      }

      await fetchSkills({ force: true, fresh: true });

      toast.success(t('detail.configSaved'));
    } catch (err) {
      toast.error(t('toast.failedSave') + ': ' + String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <Card className="w-full max-w-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="flex flex-row items-start justify-between pb-2">
          <div className="flex items-center gap-4">
            <span className="text-4xl">{skill.icon || '🔧'}</span>
            <div>
              <CardTitle className="flex items-center gap-2">
                {skill.name}
                {skill.isCore && <Lock className="h-4 w-4 text-muted-foreground" />}
              </CardTitle>
              <div className="flex gap-2 mt-2">
                {skill.slug && !skill.isBundled && !skill.isCore && (
                  <>
                    <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={handleOpenClawhub}>
                      <Globe className="h-3 w-3" />
                      ClawHub
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={handleOpenEditor} disabled={false}>
                      <FileCode className="h-3 w-3" />
                      {t('detail.openManual')}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
          <Button variant="ghost" size="icon" aria-label={t('actions.close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
          <div className="px-6">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="info">{t('detail.info')}</TabsTrigger>
              <TabsTrigger value="config" disabled={skill.isCore}>{t('detail.config')}</TabsTrigger>
            </TabsList>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="p-6">
              <TabsContent value="info" className="mt-0 space-y-4">
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground">{t('detail.description')}</h3>
                    <p className="text-sm mt-1">{skill.description}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h3 className="text-sm font-medium text-muted-foreground">{t('detail.version')}</h3>
                      <p className="font-mono text-sm">{skill.version}</p>
                    </div>
                    {skill.author && (
                      <div>
                        <h3 className="text-sm font-medium text-muted-foreground">{t('detail.author')}</h3>
                        <p className="text-sm">{skill.author}</p>
                      </div>
                    )}
                  </div>

                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground">{t('detail.source')}</h3>
                    <div className="mt-1 space-y-2">
                      <Badge variant="secondary" className="font-normal">
                        {resolveSkillSourceLabel(skill, t)}
                      </Badge>
                      <div className="flex items-center gap-2">
                        <Input
                          value={skill.baseDir || skill.filePath || t('detail.pathUnavailable')}
                          readOnly
                          className="font-mono text-xs"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-9 w-9"
                          disabled={!skill.baseDir && !skill.filePath}
                          title={t('detail.copyPath')}
                          onClick={handleCopyPath}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-9 w-9"
                          disabled={!skill.baseDir && !skill.filePath}
                          title={t('detail.openActualFolder')}
                          onClick={() => onOpenFolder?.(skill)}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground">{t('detail.availability')}</h3>
                    <div className="mt-1 flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={cn('font-normal', getAvailabilityBadgeClass(availabilityKind))}>
                        {availabilityLabel}
                      </Badge>
                    </div>
                    {missingSummary && availabilityKind !== 'eligible' && (
                      <p className="text-xs text-muted-foreground mt-2 break-all">
                        {t('availability.missingPrefix', { items: missingSummary })}
                      </p>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="config" className="mt-0 space-y-6">
                <div className="space-y-6">
                  {/* API Key Section */}
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium flex items-center gap-2">
                      <Key className="h-4 w-4 text-primary" />
                      {t('detail.apiKey')}
                    </h3>
                    <Input
                      placeholder={t('detail.apiKeyPlaceholder')}
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      type="password"
                      className="font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('detail.apiKeyDesc')}
                    </p>
                  </div>

                  {/* Environment Variables Section */}
                  <div className="space-y-2 border rounded-md p-3">
                    <div className="flex items-center justify-between w-full">
                      <button
                        className="flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors"
                        onClick={() => setIsEnvExpanded(!isEnvExpanded)}
                      >
                        {isEnvExpanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                        {t('detail.envVars')}
                        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] h-5">
                          {envVars.length}
                        </Badge>
                      </button>

                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-[10px] gap-1 px-2"
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsEnvExpanded(true);
                          handleAddEnv();
                        }}
                      >
                        <Plus className="h-3 w-3" />
                        {t('detail.addVariable')}
                      </Button>
                    </div>

                    {isEnvExpanded && (
                      <div className="pt-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200 motion-reduce:animate-none">
                        {envVars.length === 0 && (
                          <p className="text-xs text-muted-foreground italic h-8 flex items-center">
                            {t('detail.noEnvVars')}
                          </p>
                        )}

                        {envVars.map((env, index) => (
                          <div key={index} className="flex items-center gap-2">
                            <Input
                              value={env.key}
                              onChange={(e) => handleUpdateEnv(index, 'key', e.target.value)}
                              className="flex-1 font-mono text-xs bg-muted/20"
                              placeholder={t('detail.keyPlaceholder')}
                            />
                            <span className="text-muted-foreground ml-1 mr-1">=</span>
                            <Input
                              value={env.value}
                              onChange={(e) => handleUpdateEnv(index, 'value', e.target.value)}
                              className="flex-1 font-mono text-xs bg-muted/20"
                              placeholder={t('detail.valuePlaceholder')}
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:bg-destructive/10"
                              aria-label={t('actions.removeVariable')}
                              onClick={() => handleRemoveEnv(index)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}

                        {envVars.length > 0 && (
                          <p className="text-[10px] text-muted-foreground italic px-1 pt-1">
                            {t('detail.envNote')}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="pt-4 flex justify-end">
                  <Button onClick={handleSaveConfig} className="gap-2" disabled={isSaving}>
                    <Save className="h-4 w-4" />
                    {isSaving ? t('detail.saving') : t('detail.saveConfig')}
                  </Button>
                </div>
              </TabsContent>
            </div>
          </div>

          <div className="flex items-center justify-between p-4 border-t bg-muted/10">
            <div className="flex items-center gap-2">
              {skill.enabled ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                  <span className="text-green-600 dark:text-green-400">{t('detail.enabled')}</span>
                </>
              ) : (
                <>
                  <XCircle className="h-5 w-5 text-muted-foreground" />
                  <span className="text-muted-foreground">{t('detail.disabled')}</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={skill.enabled}
                onCheckedChange={() => onToggle(!skill.enabled)}
                disabled={skill.isCore}
              />
            </div>
          </div>
        </Tabs>
      </Card>
    </div>
  );
}

// Marketplace skill card component
interface MarketplaceSkillCardProps {
  skill: MarketplaceSkill;
  isInstalling: boolean;
  isInstalled: boolean;
  mutationLocked: boolean;
  onOpenDetail: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}

function MarketplaceSkillCard({
  skill,
  isInstalling,
  isInstalled,
  mutationLocked,
  onOpenDetail,
  onInstall,
  onUninstall
}: MarketplaceSkillCardProps) {
  const { t } = useTranslation('skills');
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
        <Button
          variant="outline"
          size="sm"
          className={cn('relative z-10 h-8 gap-2', isInstalled && 'text-destructive hover:text-destructive')}
          onClick={isInstalled ? onUninstall : onInstall}
          disabled={isInstalling || mutationLocked}
        >
          {isInstalling ? <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" /> : isInstalled ? <Trash2 className="size-3.5" /> : <Download className="size-3.5" />}
          {isInstalled ? t('actions.uninstall') : t('actions.install')}
        </Button>
      </AgentResourceFooter>
    </AgentResourceCard>
  );
}

interface MarketplaceSkillDetailDialogProps {
  skill: MarketplaceSkill;
  isInstalling: boolean;
  isInstalled: boolean;
  mutationLocked: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onClose: () => void;
}

function MarketplaceSkillDetailDialog({
  skill,
  isInstalling,
  isInstalled,
  mutationLocked,
  onInstall,
  onUninstall,
  onClose,
}: MarketplaceSkillDetailDialogProps) {
  const { t } = useTranslation('skills');
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
          <Button
            variant={isInstalled ? 'destructive' : 'default'}
            className="gap-2"
            onClick={isInstalled ? onUninstall : onInstall}
            disabled={isInstalling || mutationLocked}
          >
            {isInstalling ? (
              <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : isInstalled ? (
              <Trash2 className="h-4 w-4" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {isInstalled ? t('actions.uninstall') : t('actions.install')}
          </Button>
        </div>
      </Card>
    </div>
  );
}

interface LocalSkillUploadDialogProps {
  open: boolean;
  importing: boolean;
  selectedSourceName: string;
  selectedSourcePath: string;
  onClose: () => void;
  onChooseSource: () => void;
  onDropSourcePath: (path: string) => void;
  onImport: () => void;
}

function LocalSkillUploadDialog({
  open,
  importing,
  selectedSourceName,
  selectedSourcePath,
  onClose,
  onChooseSource,
  onDropSourcePath,
  onImport,
}: LocalSkillUploadDialogProps) {
  const { t } = useTranslation('skills');
  const [dragActive, setDragActive] = useState(false);

  if (!open) {
    return null;
  }

  const handleClose = () => {
    setDragActive(false);
    onClose();
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const droppedPaths = Array.from(event.dataTransfer.files)
      .map((file) => window.electron.getPathForFile(file))
      .filter((path): path is string => typeof path === 'string' && path.trim().length > 0);
    if (droppedPaths.length === 0) {
      return;
    }
    onDropSourcePath(droppedPaths[0]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={handleClose}>
      <Card
        className="w-full max-w-[30rem] rounded-[1.5rem] border border-border/80 bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="text-xl">{t('marketplace.uploadDialog.title')}</CardTitle>
          </div>
          <Button variant="ghost" size="icon" onClick={handleClose} disabled={importing}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <CardContent className="space-y-5">
          <div
            role="button"
            tabIndex={0}
            className={cn(
              'rounded-[1.25rem] border border-dashed px-6 py-8 text-center transition-colors',
              dragActive
                ? 'border-primary bg-primary/5'
                : 'border-border/70 bg-muted/15 hover:border-primary/50 hover:bg-muted/30',
            )}
            onClick={onChooseSource}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onChooseSource();
              }
            }}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragActive(false);
            }}
            onDrop={handleDrop}
          >
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
              <Upload className="h-5 w-5" />
            </div>
            {selectedSourceName ? (
              <div className="mt-4 space-y-1">
                <p className="text-base font-medium text-foreground">{selectedSourceName}</p>
                <p className="break-all text-xs text-muted-foreground">{selectedSourcePath}</p>
                <p className="pt-1 text-sm text-muted-foreground">{t('marketplace.uploadDialog.replace')}</p>
              </div>
            ) : (
              <div className="mt-4 space-y-1">
                <p className="text-base font-medium text-foreground">{t('marketplace.uploadDialog.empty')}</p>
                <p className="text-sm text-muted-foreground">{t('marketplace.uploadDialog.hint')}</p>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">{t('marketplace.uploadDialog.requirementsTitle')}</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t('marketplace.uploadDialog.requirementDirectoryZip')}</li>
              <li>{t('marketplace.uploadDialog.requirementMarkdown')}</li>
            </ul>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={importing}>
              {t('common:actions.cancel', 'Cancel')}
            </Button>
            <Button onClick={onImport} disabled={!selectedSourcePath || importing} className="gap-2">
              {importing ? <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Upload className="h-4 w-4" />}
              {t('marketplace.uploadDialog.confirm')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface SkillGridCardViewModel {
  skillId: string;
  skillName: string;
  skillDescription: string;
  skillIcon: string;
  sourceLabel: string;
  isCore: boolean;
  isBundled: boolean;
  slug?: string;
  version?: string;
  enabled: boolean;
  configurable: boolean;
  availabilityKind: SkillAvailabilityKind;
  availabilityLabel: string;
  missingSummaryLabel?: string;
  configurableLabel: string;
}

interface SkillGridCardProps extends SkillGridCardViewModel {
  onOpenDetail: (skillId: string) => void;
  mutationLocked: boolean;
  onToggleSkill: (skillId: string, enabled: boolean) => void;
  onUninstallSkill: (skillId: string) => void;
}

interface SealedSkillCardProps {
  skill: SealedSkillMetadata;
  enabled: boolean;
  mutationLocked: boolean;
  onToggleSkill: (skillId: string, enabled: boolean) => void;
}

interface SealedSkillCloudPackageCardProps {
  packageInfo: SealedSkillCloudPackage;
  installing: boolean;
  onInstall: (packageInfo: SealedSkillCloudPackage) => void;
}

interface SealedSkillPackageUploadDialogProps {
  open: boolean;
  uploading: boolean;
  selectedPackageName: string;
  selectedPackagePath: string;
  onClose: () => void;
  onChoosePackage: () => void;
  onDropPackagePath: (path: string) => void;
  onUpload: () => void;
}

interface ExportSkillPackageCardProps {
  skill: Skill;
  exporting: boolean;
  onExportSkillPackage: (skillId: string) => void;
}

type InstalledSkillSourceFilter = 'all' | 'built-in' | 'managed';

function SealedSkillCard({ skill, enabled, mutationLocked, onToggleSkill }: SealedSkillCardProps) {
  const { t } = useTranslation('skills');
  const runtimeLabel = skill.runtimes?.length ? skill.runtimes.join(', ') : t('sealed.runtimeAny');

  return (
    <AgentResourceCard className="gap-3 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <AgentResourceIcon className={SKILL_CARD_ICON_CLASS_NAME}><Lock className="size-5" aria-hidden="true" /></AgentResourceIcon>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{skill.name || skill.skillKey}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">{skill.skillKey}</p>
        </div>
      </div>
      <p className={SKILL_CARD_DESCRIPTION_CLASS_NAME}>{skill.description || t('sealed.noDescription')}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <AgentResourcePill>{skill.source || t('source.badge.unknown')}</AgentResourcePill>
        {skill.version && <span>v{skill.version}</span>}
        <span>{skill.installed === false ? t('sealed.packageAvailable') : t('sealed.packageInstalled')}</span>
        <span className="max-w-full truncate">{t('sealed.runtimeLabel', { runtime: runtimeLabel })}</span>
      </div>
      <AgentResourceFooter>
        <span className={cn('inline-flex items-center gap-2', enabled && 'text-emerald-700 dark:text-emerald-400')}>
          <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
          {enabled ? t('detail.enabled') : t('detail.disabled')}
        </span>
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => onToggleSkill(skill.skillKey, checked)}
          disabled={mutationLocked}
          aria-label={`${enabled ? t('detail.enabled') : t('detail.disabled')}: ${skill.name || skill.skillKey}`}
        />
      </AgentResourceFooter>
    </AgentResourceCard>
  );
}

function SealedSkillCloudPackageCard({ packageInfo, installing, onInstall }: SealedSkillCloudPackageCardProps) {
  const { t } = useTranslation('skills');
  const displayName = packageInfo.name?.trim() || packageInfo.skillKey?.trim() || packageInfo.fileName?.trim() || packageInfo.packageId || '-';

  return (
    <AgentResourceCard className="gap-3 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <AgentResourceIcon className={SKILL_CARD_ICON_CLASS_NAME}><Package className="size-5" aria-hidden="true" /></AgentResourceIcon>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{displayName}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">{packageInfo.skillKey || packageInfo.packageId || packageInfo.fileName || '-'}</p>
        </div>
      </div>
      <p className={SKILL_CARD_DESCRIPTION_CLASS_NAME}>{packageInfo.description || t('sealed.noDescription')}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <AgentResourcePill>{t('sealed.cloudTitle')}</AgentResourcePill>
        {packageInfo.version && <span>v{packageInfo.version}</span>}
        {typeof packageInfo.size === 'number' && <span>{t('sealed.packageSize', { size: packageInfo.size.toLocaleString() })}</span>}
      </div>
      <AgentResourceFooter>
        <span>{packageInfo.installed ? t('sealed.cloudInstalled') : t('sealed.cloudAvailable')}</span>
        <Button size="sm" variant="outline" className="h-8 shrink-0 gap-2" disabled={installing} onClick={() => onInstall(packageInfo)}>
          {installing ? <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Download className="size-3.5" />}
          {t('sealed.installFromCloud')}
        </Button>
      </AgentResourceFooter>
    </AgentResourceCard>
  );
}

function SealedSkillPackageUploadDialog({
  open,
  uploading,
  selectedPackageName,
  selectedPackagePath,
  onClose,
  onChoosePackage,
  onDropPackagePath,
  onUpload,
}: SealedSkillPackageUploadDialogProps) {
  const { t } = useTranslation('skills');
  const [dragActive, setDragActive] = useState(false);

  if (!open) {
    return null;
  }

  const handleClose = () => {
    setDragActive(false);
    onClose();
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const droppedPath = Array.from(event.dataTransfer.files)
      .map((file) => window.electron.getPathForFile(file))
      .find((path): path is string => typeof path === 'string' && path.trim().length > 0 && path.endsWith('.matcha-skillpkg'));
    if (!droppedPath) {
      return;
    }
    onDropPackagePath(droppedPath);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={handleClose}>
      <Card
        className="w-full max-w-[30rem] rounded-[1.5rem] border border-border/80 bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-4">
          <div>
            <CardTitle className="text-xl">{t('sealed.uploadDialog.title')}</CardTitle>
          </div>
          <Button variant="ghost" size="icon" onClick={handleClose} disabled={uploading}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <CardContent className="space-y-5">
          <div
            role="button"
            tabIndex={0}
            className={cn(
              'rounded-[1.25rem] border border-dashed px-6 py-8 text-center transition-colors',
              dragActive
                ? 'border-primary bg-primary/5'
                : 'border-border/70 bg-muted/15 hover:border-primary/50 hover:bg-muted/30',
            )}
            onClick={onChoosePackage}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onChoosePackage();
              }
            }}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragActive(false);
            }}
            onDrop={handleDrop}
          >
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
              <Upload className="h-5 w-5" />
            </div>
            {selectedPackageName ? (
              <div className="mt-4 space-y-1">
                <p className="text-base font-medium text-foreground">{selectedPackageName}</p>
                <p className="break-all text-xs text-muted-foreground">{selectedPackagePath}</p>
                <p className="pt-1 text-sm text-muted-foreground">{t('sealed.uploadDialog.replace')}</p>
              </div>
            ) : (
              <div className="mt-4 space-y-1">
                <p className="text-base font-medium text-foreground">{t('sealed.uploadDialog.empty')}</p>
                <p className="text-sm text-muted-foreground">{t('sealed.uploadDialog.hint')}</p>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={uploading}>
              {t('common:actions.cancel', 'Cancel')}
            </Button>
            <Button onClick={onUpload} disabled={!selectedPackagePath || uploading} className="gap-2">
              {uploading ? <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Upload className="h-4 w-4" />}
              {t('sealed.uploadDialog.confirm')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ExportSkillPackageCard({ skill, exporting, onExportSkillPackage }: ExportSkillPackageCardProps) {
  const { t } = useTranslation('skills');
  const displayName = skill.name.trim() || skill.slug?.trim() || skill.id;

  return (
    <AgentResourceCard className="gap-3 p-4">
      <div className="flex min-w-0 items-center gap-3">
        <AgentResourceIcon className={SKILL_CARD_ICON_CLASS_NAME}><Puzzle className="size-5" aria-hidden="true" /></AgentResourceIcon>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{displayName}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">{skill.id}</p>
        </div>
      </div>
      <p className={SKILL_CARD_DESCRIPTION_CLASS_NAME}>{skill.description}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <AgentResourcePill>{resolveSkillSourceLabel(skill, t)}</AgentResourcePill>
        {skill.version && <span>v{skill.version}</span>}
      </div>
      <AgentResourceFooter>
        <span>{t('sealed.exportTitle')}</span>
        <Button size="sm" variant="outline" className="h-8 shrink-0 gap-2" disabled={exporting} onClick={() => onExportSkillPackage(skill.id)}>
          {exporting ? <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" /> : <Lock className="size-3.5" />}
          {t('sealed.export')}
        </Button>
      </AgentResourceFooter>
    </AgentResourceCard>
  );
}

const SkillGridCard = memo(function SkillGridCard({
  skillId,
  skillName,
  skillDescription,
  skillIcon,
  sourceLabel,
  isCore,
  isBundled,
  slug,
  version,
  enabled,
  configurable,
  availabilityKind,
  availabilityLabel,
  missingSummaryLabel,
  configurableLabel,
  mutationLocked,
  onOpenDetail,
  onToggleSkill,
  onUninstallSkill
}: SkillGridCardProps) {
  const { t } = useTranslation('skills');
  return (
    <AgentResourceCard className="relative gap-3 p-4">
      <div className="flex items-start gap-3">
        <AgentResourceIcon className={SKILL_CARD_ICON_CLASS_NAME} aria-hidden="true">
          {skillIcon ? <span className="text-xl">{skillIcon}</span> : <Puzzle className="size-5" />}
        </AgentResourceIcon>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <button type="button" onClick={() => onOpenDetail(skillId)} className="min-w-0 truncate text-left after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring">
              {skillName}
            </button>
            {isCore && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label={t('detail.coreSystem')} />}
          </h3>
          {slug && <p className="mt-1 truncate text-xs text-muted-foreground">{slug}</p>}
        </div>
        {!isBundled && !isCore && (
          <Button
            variant="ghost"
            size="icon"
            className="relative z-10 size-8 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`${t('actions.uninstall')} ${skillName}`}
            onClick={() => onUninstallSkill(skillId)}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      <p className={SKILL_CARD_DESCRIPTION_CLASS_NAME}>{skillDescription}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <AgentResourcePill>{sourceLabel}</AgentResourcePill>
        {version && <span>v{version}</span>}
        {configurable && <span className="inline-flex items-center gap-1"><Settings className="size-3" />{configurableLabel}</span>}
      </div>
      <AgentResourceFooter>
        <span
          className={cn('inline-flex min-w-0 items-center gap-2', availabilityKind === 'eligible' && 'text-emerald-700 dark:text-emerald-400', availabilityKind === 'missing' && 'text-amber-700 dark:text-amber-400')}
          title={missingSummaryLabel}
        >
          <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
          <span className="truncate">{availabilityLabel}</span>
        </span>
        <Switch
          className="relative z-10 shrink-0"
          checked={enabled}
          onCheckedChange={(checked) => onToggleSkill(skillId, checked)}
          disabled={isCore || mutationLocked}
          aria-label={`${enabled ? t('detail.enabled') : t('detail.disabled')}: ${skillName}`}
        />
      </AgentResourceFooter>
    </AgentResourceCard>
  );
});

export function Skills() {
  const skills = useSkillsStore((state) => state.skills);
  const snapshotReady = useSkillsStore((state) => state.snapshotReady);
  const initialLoading = useSkillsStore((state) => state.initialLoading);
  const refreshing = useSkillsStore((state) => state.refreshing);
  const mutating = useSkillsStore((state) => state.mutating);
  const mutatingBySkillId = useSkillsStore((state) => state.mutatingBySkillId);
  const error = useSkillsStore((state) => state.error);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const enableSkill = useSkillsStore((state) => state.enableSkill);
  const disableSkill = useSkillsStore((state) => state.disableSkill);
  const batchSetSkillsEnabled = useSkillsStore((state) => state.batchSetSkillsEnabled);
  const searchResults = useSkillsStore((state) => state.searchResults);
  const searchSkills = useSkillsStore((state) => state.searchSkills);
  const installSkill = useSkillsStore((state) => state.installSkill);
  const importLocalSkill = useSkillsStore((state) => state.importLocalSkill);
  const uninstallSkill = useSkillsStore((state) => state.uninstallSkill);
  const searching = useSkillsStore((state) => state.searching);
  const searchError = useSkillsStore((state) => state.searchError);
  const installing = useSkillsStore((state) => state.installing);
  const sealedSkills = useSealedSkillsStore((state) => state.skills);
  const cloudPackages = useSealedSkillsStore((state) => state.cloudPackages);
  const sealedSkillsLoading = useSealedSkillsStore((state) => state.loading);
  const sealedCloudLoading = useSealedSkillsStore((state) => state.cloudLoading);
  const sealedCloudUploading = useSealedSkillsStore((state) => state.cloudUploading);
  const sealedSkillsError = useSealedSkillsStore((state) => state.error);
  const sealedCloudError = useSealedSkillsStore((state) => state.cloudError);
  const exportingBySkillKey = useSealedSkillsStore((state) => state.exportingBySkillKey);
  const cloudInstallingByPackageKey = useSealedSkillsStore((state) => state.cloudInstallingByPackageKey);
  const fetchSealedSkills = useSealedSkillsStore((state) => state.fetchSealedSkills);
  const fetchCloudSkillPackages = useSealedSkillsStore((state) => state.fetchCloudSkillPackages);
  const exportSkillPackage = useSealedSkillsStore((state) => state.exportSkillPackage);
  const uploadLocalSkillPackageToCloud = useSealedSkillsStore((state) => state.uploadLocalSkillPackageToCloud);
  const downloadAndInstallCloudSkillPackage = useSealedSkillsStore((state) => state.downloadAndInstallCloudSkillPackage);
  const { t } = useTranslation('skills');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [searchParams, setSearchParams] = useSearchParams();
  const updateQuery = (key: string, value: string) => {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  };
  const searchQuery = searchParams.get('search') || '';
  const marketplaceQuery = searchParams.get('marketSearch') || '';
  const [localSkillDialogOpen, setLocalSkillDialogOpen] = useState(false);
  const [localSkillSourcePath, setLocalSkillSourcePath] = useState('');
  const [localSkillImporting, setLocalSkillImporting] = useState(false);
  const [skillPackageUploadDialogOpen, setSkillPackageUploadDialogOpen] = useState(false);
  const [skillPackagePath, setSkillPackagePath] = useState('');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [selectedMarketplaceSkill, setSelectedMarketplaceSkill] = useState<MarketplaceSkill | null>(null);
  const tabParam = searchParams.get('tab');
  const activeTab = tabParam === 'sealed' || tabParam === 'marketplace' ? tabParam : 'all';
  const setActiveTab = (tab: string) => {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      next.set('tab', tab);
      return next;
    });
  };
  const isAllTabActive = activeTab === 'all';
  const isSealedTabActive = activeTab === 'sealed';
  const sourceParam = searchParams.get('source');
  const selectedSource: InstalledSkillSourceFilter = sourceParam === 'built-in' || sourceParam === 'managed' ? sourceParam : 'all';
  const statusParam = searchParams.get('status') || 'all';
  const selectedStatus = ['enabled', 'disabled', 'eligible', 'missing', 'unselectable', 'unknown'].includes(statusParam) ? statusParam : 'all';
  const view = searchParams.get('view') === 'list' ? 'list' : 'grid';
  const sealedQuery = searchParams.get('packageSearch') || '';
  const [skillsHeavyContentReady, setSkillsHeavyContentReady] = useState(
    () => import.meta.env.MODE === 'test' || skills.length > 0 || snapshotReady,
  );
  const marketplaceDiscoveryAttemptedRef = useRef(false);

  const gatewayProcessRunning = gatewayStatus.processState === 'running';
  const gatewayReportedReady = gatewayStatus.gatewayReady === true;
  const gatewayRuntimeKey = `${gatewayStatus.pid ?? 'none'}:${gatewayStatus.connectedAt ?? 'none'}:${gatewayStatus.port}`;
  const [skillsFeatureReady, setSkillsFeatureReady] = useState(
    () => gatewayProcessRunning && gatewayReportedReady,
  );
  const gatewayBannerState = getSkillsGatewayBannerState(gatewayStatus, skillsFeatureReady);
  const [showGatewayBanner, setShowGatewayBanner] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (gatewayBannerState === 'none') {
      timer = setTimeout(() => {
        setShowGatewayBanner(false);
      }, 0);
    } else {
      timer = setTimeout(() => {
        setShowGatewayBanner(true);
      }, 1500);
    }
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [gatewayBannerState]);

  useEffect(() => {
    if (!gatewayProcessRunning) {
      setSkillsFeatureReady(false);
      return;
    }

    setSkillsFeatureReady(gatewayReportedReady);

    let cancelled = false;

    const attemptFetch = async (force: boolean) => {
      await fetchSkills({ force, silent: true });
      if (cancelled) {
        return;
      }
      if (!useSkillsStore.getState().error) {
        setSkillsFeatureReady(true);
      }
    };

    if (!snapshotReady || !gatewayReportedReady) {
      void attemptFetch(!snapshotReady || !skillsFeatureReady);
    }

    return () => {
      cancelled = true;
    };
  }, [fetchSkills, gatewayProcessRunning, gatewayReportedReady, gatewayRuntimeKey, skillsFeatureReady, snapshotReady]);

  useEffect(() => {
    if (isSealedTabActive) {
      void fetchSealedSkills();
      void fetchCloudSkillPackages();
    }
  }, [fetchCloudSkillPackages, fetchSealedSkills, isSealedTabActive]);

  useEffect(() => {
    if (skillsHeavyContentReady) {
      return;
    }
    if (snapshotReady) {
      setSkillsHeavyContentReady(true);
      return;
    }
    const cancel = scheduleIdleReady(() => {
      setSkillsHeavyContentReady(true);
    }, {
      idleTimeoutMs: SKILLS_HEAVY_CONTENT_IDLE_TIMEOUT_MS,
      fallbackDelayMs: 120,
      useAnimationFrame: true,
    });
    return cancel;
  }, [skillsHeavyContentReady, snapshotReady]);

  // Filter skills
  const safeSkills = useMemo(() => (Array.isArray(skills) ? skills : []), [skills]);
  const skillById = useMemo(() => {
    return new Map(safeSkills.map((skill) => [skill.id, skill] as const));
  }, [safeSkills]);
  const exportableSkills = useMemo(() => {
    return safeSkills.filter((skill) => !skill.isCore && !skill.isBundled);
  }, [safeSkills]);
  const deferredSkills = useDeferredValue(safeSkills);
  const deferredSearchQuery = useDeferredValue(isAllTabActive ? searchQuery : '');
  const deferredSelectedSource = useDeferredValue(isAllTabActive ? selectedSource : 'all');
  const skillsForView = useMemo(
    () => (isAllTabActive && skillsHeavyContentReady ? deferredSkills : []),
    [deferredSkills, isAllTabActive, skillsHeavyContentReady],
  );

  const filteredSkills = useMemo(() => {
    const q = deferredSearchQuery.toLowerCase().trim();
    return skillsForView.filter((skill) => {
      const matchesSearch =
        q.length === 0
        || skill.name.toLowerCase().includes(q)
        || skill.description.toLowerCase().includes(q)
        || skill.id.toLowerCase().includes(q)
        || (skill.slug || '').toLowerCase().includes(q)
        || (skill.author || '').toLowerCase().includes(q);

      const matchesSource = deferredSelectedSource === 'all'
        || (deferredSelectedSource === 'built-in' && skill.isBundled)
        || (deferredSelectedSource === 'managed' && !skill.isBundled);

      const matchesStatus = selectedStatus === 'all'
        || (selectedStatus === 'enabled' ? skill.enabled : selectedStatus === 'disabled' ? !skill.enabled : getSkillAvailabilityKind(skill) === selectedStatus);
      return matchesSearch && matchesSource && matchesStatus;
    }).sort((a, b) => {
      // Enabled skills first
      if (a.enabled && !b.enabled) return -1;
      if (!a.enabled && b.enabled) return 1;
      // Then core/bundled
      if (a.isCore && !b.isCore) return -1;
      if (!a.isCore && b.isCore) return 1;
      // Finally alphabetical
      return a.name.localeCompare(b.name);
    });
  }, [deferredSearchQuery, deferredSelectedSource, selectedStatus, skillsForView]);
  const showInitialLoading = !snapshotReady && initialLoading;
  const manualRefreshBusy = refreshing || mutating;
  const showRefreshingHint = useDelayedFlag(refreshing && snapshotReady, 180);

  const filteredSkillCards = useMemo<SkillGridCardViewModel[]>(() => {
    const configurableLabel = t('detail.configurable');
    return filteredSkills.map((skill) => {
      const availabilityKind = getSkillAvailabilityKind(skill);
      const missingSummary = formatSkillMissingSummary(skill);
      const availabilityLabel = resolveAvailabilityLabel(availabilityKind, t);
      const displayName = skill.name.trim() || skill.slug?.trim() || skill.id;
      return {
        skillId: skill.id,
        skillName: displayName,
        skillDescription: skill.description,
        skillIcon: skill.icon || '',
        sourceLabel: resolveSkillSourceLabel(skill, t),
        isCore: Boolean(skill.isCore),
        isBundled: Boolean(skill.isBundled),
        slug: skill.slug && skill.slug !== displayName ? skill.slug : undefined,
        version: skill.version,
        enabled: skill.enabled,
        configurable: Boolean(skill.configurable),
        availabilityKind,
        availabilityLabel,
        missingSummaryLabel: missingSummary && availabilityKind !== 'eligible'
          ? t('availability.missingPrefix', { items: missingSummary })
          : undefined,
        configurableLabel,
      };
    });
  }, [filteredSkills, t]);

  const sourceStats = useMemo(() => {
    if (!isAllTabActive) {
      return { all: 0, builtIn: 0, managed: 0 };
    }
    return {
      all: safeSkills.length,
      builtIn: safeSkills.filter((skill) => skill.isBundled).length,
      managed: safeSkills.filter((skill) => !skill.isBundled).length,
    };
  }, [isAllTabActive, safeSkills]);

  const handleRefresh = useCallback(() => {
    if (isSealedTabActive) {
      void fetchSealedSkills();
      void fetchCloudSkillPackages();
      return;
    }
    void fetchSkills({ force: true, fresh: true });
  }, [fetchCloudSkillPackages, fetchSealedSkills, fetchSkills, isSealedTabActive]);

  const handleExportSkillPackage = useCallback(async (skillId: string) => {
    try {
      await exportSkillPackage(skillId);
      toast.success(t('sealed.exported'));
    } catch (err) {
      toast.error(t('sealed.exportFailed') + ': ' + String(err));
    }
  }, [exportSkillPackage, t]);

  const bulkToggleVisible = useCallback(async (enable: boolean) => {
    const candidates = filteredSkills.filter((skill) => !skill.isCore && skill.enabled !== enable);
    if (candidates.length === 0) {
      toast.info(enable ? t('toast.noBatchEnableTargets') : t('toast.noBatchDisableTargets'));
      return;
    }

    try {
      await batchSetSkillsEnabled(candidates.map((skill) => skill.id), enable);
      trackUiEvent('skills.batch_toggle', { enable, total: candidates.length, succeeded: candidates.length });
      toast.success(enable ? t('toast.batchEnabled', { count: candidates.length }) : t('toast.batchDisabled', { count: candidates.length }));
    } catch {
      trackUiEvent('skills.batch_toggle', { enable, total: candidates.length, succeeded: 0 });
      toast.warning(t('toast.batchPartial', { success: 0, total: candidates.length }));
    }
  }, [batchSetSkillsEnabled, filteredSkills, t]);

  // Handle toggle
  const handleToggle = useCallback(async (skillId: string, enable: boolean) => {
    try {
      if (enable) {
        await enableSkill(skillId);
        toast.success(t('toast.enabled'));
      } else {
        await disableSkill(skillId);
        toast.success(t('toast.disabled'));
      }
    } catch (err) {
      toast.error(String(err));
    }
  }, [enableSkill, disableSkill, t]);

  const handleOpenSkillDetail = useCallback((skillId: string) => {
    const nextSkill = skillById.get(skillId);
    if (!nextSkill) {
      return;
    }
    setSelectedSkill(nextSkill);
  }, [skillById]);

  const handleOpenSkillFolder = useCallback(async (skill: Skill) => {
    try {
      const result = await skillManagementCapabilityExecute<{ success: boolean; error?: string }>(
        'clawhub.openPath',
        {
          skillKey: skill.id,
          slug: skill.slug,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
        },
        { kind: 'skill', skillId: skill.id, slug: skill.slug },
      );
      if (!result.success) {
        throw new Error(result.error || t('toast.failedOpenActualFolder'));
      }
    } catch (err) {
      toast.error(t('toast.failedOpenActualFolder') + ': ' + String(err));
    }
  }, [t]);

  const handleToggleSkillQuick = useCallback((skillId: string, enable: boolean) => {
    void handleToggle(skillId, enable);
  }, [handleToggle]);

  const hasInstalledSkills = useMemo(() => safeSkills.some((s) => !s.isBundled), [safeSkills]);
  const cloudPackagesUnavailable = sealedCloudError === SEALED_SKILL_CLOUD_UNAVAILABLE_ERROR;

  const handleOpenSkillsFolder = useCallback(async () => {
    try {
      const skillsDir = await hostOpenClawGetSkillsDir();
      if (!skillsDir) {
        throw new Error('Skills directory not available');
      }
      const result = await invokeIpc<string>('shell:openPath', skillsDir);
      if (result) {
        // shell.openPath returns an error string if the path doesn't exist
        if (result.toLowerCase().includes('no such file') || result.toLowerCase().includes('not found') || result.toLowerCase().includes('failed to open')) {
          toast.error(t('toast.failedFolderNotFound'));
        } else {
          throw new Error(result);
        }
      }
    } catch (err) {
      toast.error(t('toast.failedOpenFolder') + ': ' + String(err));
    }
  }, [t]);

  const [skillsDirPath, setSkillsDirPath] = useState('~/.openclaw/skills');

  useEffect(() => {
    hostOpenClawGetSkillsDir()
      .then((dir) => setSkillsDirPath(dir as string))
      .catch(console.error);
  }, []);

  const localSkillSourceName = useMemo(() => {
    if (!localSkillSourcePath) {
      return '';
    }
    return localSkillSourcePath.split(/[\\/]/).pop() || localSkillSourcePath;
  }, [localSkillSourcePath]);

  const skillPackageName = useMemo(() => {
    if (!skillPackagePath) {
      return '';
    }
    return skillPackagePath.split(/[\\/]/).pop() || skillPackagePath;
  }, [skillPackagePath]);

  const resetLocalSkillDialog = useCallback(() => {
    setLocalSkillDialogOpen(false);
    setLocalSkillSourcePath('');
    setLocalSkillImporting(false);
  }, []);

  const resetSkillPackageUploadDialog = useCallback(() => {
    setSkillPackageUploadDialogOpen(false);
    setSkillPackagePath('');
  }, []);

  const handleChooseLocalSkillSource = useCallback(async () => {
    try {
      const result = await invokeIpc<{ canceled: boolean; filePaths?: string[] }>('dialog:open', {
        properties: ['openFile', 'openDirectory'],
        filters: [
          {
            name: t('marketplace.uploadDialog.skillSourceFilter'),
            extensions: ['zip', 'md'],
          },
          {
            name: t('marketplace.uploadDialog.allFilesFilter'),
            extensions: ['*'],
          },
        ],
      });
      if (result.canceled || !result.filePaths?.length) {
        return;
      }
      setLocalSkillSourcePath(result.filePaths[0]);
    } catch (error) {
      toast.error(t('toast.failedImportLocalSkill') + ': ' + String(error));
    }
  }, [t]);

  const handleImportLocalSkill = useCallback(async () => {
    if (localSkillImporting || !localSkillSourcePath.trim()) {
      return;
    }

    setLocalSkillImporting(true);
    try {
      const importedSkill = await readLocalSkillImport(localSkillSourcePath);
      if (!importedSkill) {
        return;
      }
      const skillKey = importedSkill.skillKey.trim();
      if (!skillKey) {
        throw new Error('Imported skill did not return a skill key');
      }
      await importLocalSkill(importedSkill);

      let enableError: unknown = null;
      try {
        await enableSkill(skillKey);
      } catch (error) {
        enableError = error;
      }

      try {
        await fetchSkills({ force: true, fresh: true });
      } catch (error) {
        console.error('Failed to refresh skills after local import:', error);
      }

      if (enableError) {
        toast.warning(t('toast.importedLocalSkillEnableFailed', { name: skillKey }) + ': ' + String(enableError));
      } else {
        toast.success(t('toast.importedLocalSkillEnabled', { name: skillKey }));
      }

      resetLocalSkillDialog();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('toast.failedImportLocalSkill') + ': ' + message);
    } finally {
      setLocalSkillImporting(false);
    }
  }, [enableSkill, fetchSkills, importLocalSkill, localSkillImporting, localSkillSourcePath, resetLocalSkillDialog, t]);

  const handleChooseSkillPackage = useCallback(async () => {
    try {
      const result = await invokeIpc<{ canceled: boolean; filePaths?: string[] }>('dialog:open', {
        properties: ['openFile'],
        filters: [
          {
            name: t('sealed.uploadDialog.packageFilter'),
            extensions: ['matcha-skillpkg'],
          },
        ],
      });
      if (result.canceled || !result.filePaths?.length) {
        return;
      }
      setSkillPackagePath(result.filePaths[0]);
    } catch (error) {
      toast.error(t('sealed.uploadFailed') + ': ' + String(error));
    }
  }, [t]);

  const handleUploadSkillPackageToCloud = useCallback(async () => {
    if (!skillPackagePath.trim() || sealedCloudUploading) {
      return;
    }
    try {
      await uploadLocalSkillPackageToCloud(skillPackagePath);
      toast.success(t('sealed.uploaded'));
      resetSkillPackageUploadDialog();
    } catch (error) {
      toast.error(t('sealed.uploadFailed') + ': ' + String(error));
    }
  }, [resetSkillPackageUploadDialog, sealedCloudUploading, skillPackagePath, t, uploadLocalSkillPackageToCloud]);

  const handleInstallCloudSkillPackage = useCallback(async (packageInfo: SealedSkillCloudPackage) => {
    try {
      await downloadAndInstallCloudSkillPackage(packageInfo);
      toast.success(t('sealed.installedFromCloud'));
      await fetchSkills({ force: true, fresh: true });
    } catch (error) {
      toast.error(t('sealed.installFromCloudFailed') + ': ' + String(error));
    }
  }, [downloadAndInstallCloudSkillPackage, fetchSkills, t]);

  // Handle marketplace search
  const handleMarketplaceSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const trimmedQuery = marketplaceQuery.trim();
    if (!trimmedQuery) {
      return;
    }
    marketplaceDiscoveryAttemptedRef.current = true;
    searchSkills(trimmedQuery);
  }, [marketplaceQuery, searchSkills]);

  // Marketplace query debounce（仅对非空关键词生效）
  useEffect(() => {
    if (activeTab !== 'marketplace') {
      return;
    }
    const trimmedQuery = marketplaceQuery.trim();
    if (!trimmedQuery) {
      return;
    }

    const timer = setTimeout(() => {
      marketplaceDiscoveryAttemptedRef.current = true;
      searchSkills(trimmedQuery);
    }, 250);

    return () => {
      clearTimeout(timer);
    };
  }, [marketplaceQuery, activeTab, searchSkills]);

  // Handle install
  const handleInstall = useCallback(async (slug: string) => {
    try {
      await installSkill(slug);
      toast.success(t('toast.installed'));
    } catch (err) {
      const errorCode = normalizeSkillErrorCode(err instanceof Error ? err.message : String(err));
      if (INSTALL_ERROR_CODES.has(errorCode)) {
        toast.error(t(`toast.${errorCode}`, { path: skillsDirPath }), { duration: 10000 });
      } else {
        toast.error(t('toast.failedInstall') + ': ' + errorCode);
      }
    }
  }, [installSkill, t, skillsDirPath]);

  // Initial marketplace load (Discovery)
  useEffect(() => {
    if (activeTab !== 'marketplace') {
      return;
    }
    if (marketplaceQuery.trim()) {
      return;
    }
    if (searching) {
      return;
    }
    if (marketplaceDiscoveryAttemptedRef.current) {
      return;
    }
    marketplaceDiscoveryAttemptedRef.current = true;
    searchSkills('');
  }, [activeTab, marketplaceQuery, searching, searchSkills]);

  // Handle uninstall
  const handleUninstall = useCallback(async (skillKey: string, slug?: string) => {
    try {
      await uninstallSkill(skillKey, slug);
      toast.success(t('toast.uninstalled'));
    } catch (err) {
      toast.error(t('toast.failedUninstall') + ': ' + String(err));
    }
  }, [uninstallSkill, t]);

  const handleUninstallSkillQuick = useCallback((skillKey: string) => {
    void handleUninstall(skillKey);
  }, [handleUninstall]);

  const selectedInstalledMarketplaceSkill = useMemo(() => {
    if (!selectedMarketplaceSkill) {
      return undefined;
    }
    return findInstalledMarketplaceSkill(safeSkills, selectedMarketplaceSkill);
  }, [safeSkills, selectedMarketplaceSkill]);
  const selectedMarketplaceInstalled = selectedInstalledMarketplaceSkill !== undefined;

  const selectedMarketplaceInstalling = selectedMarketplaceSkill
    ? Boolean(installing[selectedMarketplaceSkill.slug] || installing[selectedInstalledMarketplaceSkill?.id ?? ''])
    : false;
  const packageSearch = sealedQuery.trim().toLowerCase();
  const filteredSealedSkills = sealedSkills.filter((skill) => [skill.name, skill.skillKey, skill.description].some((value) => value?.toLowerCase().includes(packageSearch)));
  const filteredCloudPackages = cloudPackages.filter((item) => [item.name, item.skillKey, item.packageId, item.fileName, item.description].some((value) => value?.toLowerCase().includes(packageSearch)));
  const filteredExportableSkills = exportableSkills.filter((skill) => [skill.name, skill.id, skill.description].some((value) => value?.toLowerCase().includes(packageSearch)));
  const resourceGridClassName = view === 'list' ? 'md:grid-cols-1 xl:grid-cols-1' : undefined;
  const viewControls = <AgentViewToggle value={view} onChange={(value) => updateQuery('view', value)} gridLabel={t('view.grid')} listLabel={t('view.list')} />;

  return (
    <AgentPage>
      <Tabs value={activeTab} onValueChange={setActiveTab} className="group/skills space-y-6" data-view={view}>
        <AgentPageSection actions={(
          <>
            <Button variant="outline" size="icon" className="size-9 rounded-full" aria-label={t('refresh')} title={t('refresh')} onClick={handleRefresh} disabled={isSealedTabActive ? sealedSkillsLoading : (!gatewayProcessRunning || manualRefreshBusy)}>
              <RefreshCw className={cn('size-4', (refreshing || sealedSkillsLoading) && 'animate-spin motion-reduce:animate-none')} />
            </Button>
            {hasInstalledSkills && (
              <Button variant="outline" size="sm" className="h-9 gap-2 rounded-full" onClick={handleOpenSkillsFolder}>
                <FolderOpen className="size-4" />
                {t('openFolder')}
              </Button>
            )}
          </>
        )}>
          <TabsList variant="line" aria-label={t('title')}>
            <TabsTrigger value="all" className="gap-2">
              {t('tabs.installed')}
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">{safeSkills.length}</span>
            </TabsTrigger>
            <TabsTrigger value="sealed">{t('tabs.sealed')}</TabsTrigger>
            <TabsTrigger value="marketplace">{t('tabs.marketplace')}</TabsTrigger>
          </TabsList>
        </AgentPageSection>

      {/* Gateway Status */}
      {showGatewayBanner && gatewayBannerState !== 'none' && (
        <Card className={cn(
          gatewayBannerState === 'starting'
            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/10'
            : 'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10',
        )}>
          <CardContent className="py-4 flex items-center gap-3">
            <AlertCircle className={cn(
              'h-5 w-5',
              gatewayBannerState === 'starting' ? 'text-blue-600' : 'text-yellow-600',
            )} />
            <span className={cn(
              gatewayBannerState === 'starting'
                ? 'text-blue-700 dark:text-blue-400'
                : 'text-yellow-700 dark:text-yellow-400',
            )}>
              {gatewayBannerState === 'starting' ? t('gatewayStarting') : t('gatewayWarning')}
            </span>
          </CardContent>
        </Card>
      )}

      {showRefreshingHint && (
        <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          {t('common:status.loading', 'Loading...')}
        </div>
      )}


        {activeTab === 'all' ? (
          <TabsContent value="all" className="space-y-6 mt-6">
          {/* Search and Filter */}
          <AgentPageToolbar>
            <div className="relative w-full sm:w-72">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input aria-label={t('search')} placeholder={t('search')} value={searchQuery} onChange={(e) => updateQuery('search', e.target.value)} className="h-9 pl-9 text-sm" />
            </div>
            <Select aria-label={t('filter.source')} value={selectedSource} onChange={(e) => updateQuery('source', e.target.value)} className="h-9 w-auto max-w-full text-xs">
              <option value="all">{t('filter.all', { count: sourceStats.all })}</option>
              <option value="built-in">{t('filter.builtIn', { count: sourceStats.builtIn })}</option>
              <option value="managed">{t('filter.managed', { count: sourceStats.managed })}</option>
            </Select>
            <Select aria-label={t('filter.status')} value={selectedStatus} onChange={(e) => updateQuery('status', e.target.value)} className="h-9 w-auto max-w-full text-xs">
              <option value="all">{t('filter.allStatuses')}</option>
              <option value="enabled">{t('filter.enabled')}</option>
              <option value="disabled">{t('filter.disabled')}</option>
              {(['eligible', 'missing', 'unselectable', 'unknown'] as const).map((kind) => <option key={kind} value={kind}>{resolveAvailabilityLabel(kind, t)}</option>)}
            </Select>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => { void bulkToggleVisible(true); }}>{t('actions.enableVisible')}</Button>
              <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => { void bulkToggleVisible(false); }}>{t('actions.disableVisible')}</Button>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">{t('count', { count: filteredSkillCards.length })}</span>
              {viewControls}
            </div>
          </AgentPageToolbar>

          {/* Error Display */}
          {error && (
            <Card className="border-destructive">
              <CardContent className="py-4 text-destructive flex items-center gap-2">
                <AlertCircle className="h-5 w-5 shrink-0" />
                <span>
                  {FETCH_ERROR_CODES.has(normalizeSkillErrorCode(error))
                    ? t(`toast.${normalizeSkillErrorCode(error)}`, { path: skillsDirPath })
                    : error}
                </span>
              </CardContent>
            </Card>
          )}

          {/* Skills Grid */}
          {!skillsHeavyContentReady ? (
            <AgentResourceGrid className={resourceGridClassName}>
              {Array.from({ length: 6 }).map((_, index) => (
                <Card key={`skills-placeholder-${index}`}>
                  <CardHeader className="pb-3">
                    <div className="h-4 w-3/5 animate-pulse motion-reduce:animate-none rounded bg-muted" />
                    <div className="mt-2 h-3 w-4/5 animate-pulse motion-reduce:animate-none rounded bg-muted" />
                  </CardHeader>
                  <CardContent>
                    <div className="h-3 w-full animate-pulse motion-reduce:animate-none rounded bg-muted" />
                    <div className="mt-2 h-3 w-2/3 animate-pulse motion-reduce:animate-none rounded bg-muted" />
                    <div className="mt-4 h-6 w-24 animate-pulse motion-reduce:animate-none rounded bg-muted" />
                  </CardContent>
                </Card>
              ))}
            </AgentResourceGrid>
          ) : showInitialLoading ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <LoadingSpinner size="lg" />
              </CardContent>
            </Card>
          ) : filteredSkillCards.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Puzzle className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">{t('noSkills')}</h3>
                <p className="text-muted-foreground">
                  {searchQuery ? t('noSkillsSearch') : t('noSkillsAvailable')}
                </p>
              </CardContent>
            </Card>
          ) : (
            <AgentResourceGrid className={resourceGridClassName}>
              {filteredSkillCards.map((skill) => (
                <SkillGridCard
                  key={skill.skillId}
                  {...skill}
                  mutationLocked={false}
                  onOpenDetail={handleOpenSkillDetail}
                  onToggleSkill={handleToggleSkillQuick}
                  onUninstallSkill={handleUninstallSkillQuick}
                />
              ))}
            </AgentResourceGrid>
          )}
          </TabsContent>
        ) : null}

        {activeTab === 'sealed' ? (
          <TabsContent value="sealed" className="space-y-6 mt-6">
            <AgentPageToolbar>
              <div className="relative w-full sm:w-72">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input aria-label={t('sealed.search')} placeholder={t('sealed.search')} value={sealedQuery} onChange={(e) => updateQuery('packageSearch', e.target.value)} className="h-9 pl-9 text-sm" />
              </div>
              <div className="ml-auto">{viewControls}</div>
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                disabled={sealedCloudUploading}
                onClick={() => setSkillPackageUploadDialogOpen(true)}
              >
                {sealedCloudUploading ? <RefreshCw className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Upload className="h-4 w-4" />}
                {t('sealed.uploadLocalPackage')}
              </Button>
            </AgentPageToolbar>

            {sealedSkillsError && (
              <Card className="border-destructive/50 bg-destructive/5">
                <CardContent className="py-3 text-sm text-destructive flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{sealedSkillsError}</span>
                </CardContent>
              </Card>
            )}

            {sealedSkillsLoading && sealedSkills.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <LoadingSpinner size="lg" />
                </CardContent>
              </Card>
            ) : filteredSealedSkills.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <Lock className="h-12 w-12 text-muted-foreground mb-4" />
                  <h3 className="text-lg font-medium">{packageSearch ? t('noSkills') : t('sealed.emptyTitle')}</h3>
                </CardContent>
              </Card>
            ) : (
              <AgentResourceGrid className={resourceGridClassName}>
                {filteredSealedSkills.map((skill) => (
                  <SealedSkillCard
                    key={skill.skillKey}
                    skill={skill}
                    enabled={skillById.get(skill.skillKey)?.enabled ?? skill.enabled !== false}
                    mutationLocked={Boolean(mutatingBySkillId[skill.skillKey])}
                    onToggleSkill={handleToggleSkillQuick}
                  />
                ))}
              </AgentResourceGrid>
            )}

            <div className="space-y-3">
              <h2 className="text-lg font-semibold">{t('sealed.cloudTitle')}</h2>
              {sealedCloudLoading && cloudPackages.length === 0 ? (
                <Card>
                  <CardContent className="flex flex-col items-center justify-center py-12">
                    <LoadingSpinner size="lg" />
                  </CardContent>
                </Card>
              ) : cloudPackagesUnavailable ? (
                <Card>
                  <CardContent className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                    <Globe className="h-10 w-10 text-muted-foreground" />
                    <div>
                      <h3 className="text-base font-medium text-foreground">{t('sealed.cloudUnavailableTitle')}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{t('sealed.cloudUnavailableDescription')}</p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => { void fetchCloudSkillPackages(); }}>
                      <RefreshCw className={cn('mr-2 h-4 w-4', sealedCloudLoading && 'animate-spin')} />
                      {t('refresh')}
                    </Button>
                  </CardContent>
                </Card>
              ) : filteredCloudPackages.length === 0 ? (
                <Card>
                  <CardContent className="py-6 text-sm text-muted-foreground">
                    {packageSearch ? t('noSkills') : t('sealed.cloudEmpty')}
                  </CardContent>
                </Card>
              ) : (
                <AgentResourceGrid className={resourceGridClassName}>
                  {filteredCloudPackages.map((packageInfo) => {
                    const packageKey = getSealedSkillCloudPackageKey(packageInfo);
                    return (
                      <SealedSkillCloudPackageCard
                        key={packageKey}
                        packageInfo={packageInfo}
                        installing={Boolean(cloudInstallingByPackageKey[packageKey])}
                        onInstall={handleInstallCloudSkillPackage}
                      />
                    );
                  })}
                </AgentResourceGrid>
              )}
            </div>

            <div className="space-y-3">
              <h2 className="text-lg font-semibold">{t('sealed.exportTitle')}</h2>
              {filteredExportableSkills.length === 0 ? (
                <Card>
                  <CardContent className="py-6 text-sm text-muted-foreground">
                    {packageSearch ? t('noSkills') : t('sealed.noExportTargets')}
                  </CardContent>
                </Card>
              ) : (
                <AgentResourceGrid className={resourceGridClassName}>
                  {filteredExportableSkills.map((skill) => (
                    <ExportSkillPackageCard
                      key={skill.id}
                      skill={skill}
                      exporting={Boolean(exportingBySkillKey[skill.id])}
                      onExportSkillPackage={handleExportSkillPackage}
                    />
                  ))}
                </AgentResourceGrid>
              )}
            </div>
          </TabsContent>
        ) : null}

        {activeTab === 'marketplace' ? (
          <TabsContent value="marketplace" className="space-y-6 mt-6">
          <div className="flex flex-col gap-4">
            <AgentPageToolbar>
              <form onSubmit={handleMarketplaceSearch} className="flex min-w-0 flex-1 gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    aria-label={t('searchMarketplace')}
                    placeholder={t('searchMarketplace')}
                    value={marketplaceQuery}
                    onChange={(e) => updateQuery('marketSearch', e.target.value)}
                    className="h-9 pl-9 pr-9 text-sm"
                  />
                  {marketplaceQuery && (
                    <button
                      type="button"
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={t('actions.clearSearch')}
                      onClick={() => updateQuery('marketSearch', '')}
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
              <Button
                type="button"
                variant="outline"
                className="h-9 gap-2"
                disabled={false}
                onClick={() => setLocalSkillDialogOpen(true)}
              >
                <Upload className="h-4 w-4" />
                {t('marketplace.uploadSkill')}
              </Button>
              <Button type="button" variant="outline" disabled={searching} onClick={() => { updateQuery('marketSearch', ''); marketplaceDiscoveryAttemptedRef.current = true; void searchSkills(''); }}>{t('marketplace.discover')}</Button>
              {viewControls}
            </AgentPageToolbar>

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
              <AgentResourceGrid className={resourceGridClassName}>
                {searchResults.map((skill) => {
                  const installedSkill = findInstalledMarketplaceSkill(safeSkills, skill);
                  return (
                    <MarketplaceSkillCard
                      key={skill.slug}
                      skill={skill}
                      isInstalling={Boolean(installing[skill.slug] || installing[installedSkill?.id ?? ''])}
                      isInstalled={installedSkill !== undefined}
                      mutationLocked={false}
                      onOpenDetail={() => setSelectedMarketplaceSkill(skill)}
                      onInstall={() => handleInstall(skill.slug)}
                      onUninstall={() => handleUninstall(installedSkill?.id ?? skill.slug, skill.slug)}
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
          </TabsContent>
        ) : null}

        {/* <TabsContent value="bundles" className="space-y-6 mt-6">
          <p className="text-muted-foreground">
            Skill bundles are pre-configured collections of skills for common use cases.
            Enable a bundle to quickly set up multiple related skills at once.
          </p>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {skillBundles.map((bundle) => (
              <BundleCard
                key={bundle.id}
                bundle={bundle}
                skills={skills}
                onApply={() => handleBundleApply(bundle)}
              />
            ))}
          </div>
        </TabsContent> */}
      </Tabs>



      {/* Skill Detail Dialog */}
      {selectedSkill && (
        <SkillDetailDialog
          skill={selectedSkill}
          onClose={() => setSelectedSkill(null)}
          onToggle={(enabled) => {
            handleToggle(selectedSkill.id, enabled);
            setSelectedSkill({ ...selectedSkill, enabled });
          }}
          onOpenFolder={handleOpenSkillFolder}
        />
      )}

      {selectedMarketplaceSkill && (
        <MarketplaceSkillDetailDialog
          skill={selectedMarketplaceSkill}
          isInstalled={selectedMarketplaceInstalled}
          isInstalling={selectedMarketplaceInstalling}
          mutationLocked={false}
          onInstall={() => { void handleInstall(selectedMarketplaceSkill.slug); }}
          onUninstall={() => { void handleUninstall(selectedInstalledMarketplaceSkill?.id ?? selectedMarketplaceSkill.slug, selectedMarketplaceSkill.slug); }}
          onClose={() => setSelectedMarketplaceSkill(null)}
        />
      )}

      <LocalSkillUploadDialog
        open={localSkillDialogOpen}
        importing={localSkillImporting}
        selectedSourceName={localSkillSourceName}
        selectedSourcePath={localSkillSourcePath}
        onClose={() => {
          if (!localSkillImporting) {
            resetLocalSkillDialog();
          }
        }}
        onChooseSource={() => { void handleChooseLocalSkillSource(); }}
        onDropSourcePath={setLocalSkillSourcePath}
        onImport={() => { void handleImportLocalSkill(); }}
      />

      <SealedSkillPackageUploadDialog
        open={skillPackageUploadDialogOpen}
        uploading={sealedCloudUploading}
        selectedPackageName={skillPackageName}
        selectedPackagePath={skillPackagePath}
        onClose={() => {
          if (!sealedCloudUploading) {
            resetSkillPackageUploadDialog();
          }
        }}
        onChoosePackage={() => { void handleChooseSkillPackage(); }}
        onDropPackagePath={setSkillPackagePath}
        onUpload={() => { void handleUploadSkillPackageToCloud(); }}
      />
    </AgentPage>
  );
}

export default Skills;
