/**
 * Skills Page
 * Browse and manage AI skills
 */
import { memo, useDeferredValue, useEffect, useState, useCallback, useMemo, useRef } from 'react';
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
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useSkillsStore } from '@/stores/skills';
import { useGatewayStore } from '@/stores/gateway';
import { hostOpenClawGetSkillsDir } from '@/lib/host-api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';
import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { scheduleIdleReady } from '@/lib/idle-ready';
import { trackUiEvent } from '@/lib/telemetry';
import { toast } from 'sonner';
import type { Skill, MarketplaceSkill, SkillMissingRequirements } from '@/types/skill';
import { useTranslation } from 'react-i18next';

type SkillAvailabilityKind = 'eligible' | 'blocked' | 'missing' | 'disabled' | 'unknown';
const SKILLS_HEAVY_CONTENT_IDLE_TIMEOUT_MS = 320;
const CLAWHUB_MARKETPLACE_PRIMARY_URL = 'https://cn.clawhub-mirror.com';

function buildMarketplaceSkillUrl(slug: string) {
  return `${CLAWHUB_MARKETPLACE_PRIMARY_URL}/s/${slug}`;
}

function getSkillAvailabilityKind(skill: Skill): SkillAvailabilityKind {
  if (!skill.enabled) return 'disabled';
  if (skill.eligible === true) return 'eligible';
  if (skill.blockedByAllowlist) return 'blocked';
  if (skill.eligible === false) return 'missing';
  return 'unknown';
}

function getAvailabilityBadgeClass(kind: SkillAvailabilityKind): string {
  switch (kind) {
    case 'eligible':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';
    case 'blocked':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400';
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

function resolveSkillSourceLabel(skill: Skill, t: (key: string, options?: Record<string, unknown>) => string): string {
  const source = (skill.source || '').trim().toLowerCase();
  if (!source) {
    if (skill.isBundled) {
      return t('source.badge.bundled');
    }
    return t('source.badge.unknown');
  }
  if (source === 'openclaw-bundled') return t('source.badge.bundled');
  if (source === 'openclaw-managed') return t('source.badge.managed');
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
  const missingSummary = formatMissingSummary(skill.missing);
  const availabilityLabel = availabilityKind === 'disabled'
    ? t('detail.disabled')
    : t(`availability.${availabilityKind}`);

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
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/clawhub/open-readme', {
        method: 'POST',
        body: JSON.stringify({ skillKey: skill.id, slug: skill.slug, baseDir: skill.baseDir }),
      });
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
    if (!skill.baseDir) {
      return;
    }
    try {
      await navigator.clipboard.writeText(skill.baseDir);
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

      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/skills/config', {
        method: 'PUT',
        body: JSON.stringify({
          skillKey: skill.id,
          apiKey: apiKey || '',
          env: envObj,
        }),
      });

      if (!result.success) {
        throw new Error(result.error || 'Unknown error');
      }

      // Refresh skills from gateway to get updated config
      await fetchSkills({ force: true });

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
                    <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={handleOpenEditor}>
                      <FileCode className="h-3 w-3" />
                      {t('detail.openManual')}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
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
                          value={skill.baseDir || t('detail.pathUnavailable')}
                          readOnly
                          className="font-mono text-xs"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-9 w-9"
                          disabled={!skill.baseDir}
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
                          disabled={!skill.baseDir}
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
                    {availabilityKind === 'blocked' && (
                      <p className="text-xs text-muted-foreground mt-2">
                        {t('availability.blockedByAllowlist')}
                      </p>
                    )}
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
                      API Key
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
                        Environment Variables
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
                      <div className="pt-4 space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
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
  onOpenDetail: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}

function MarketplaceSkillCard({
  skill,
  isInstalling,
  isInstalled,
  onOpenDetail,
  onInstall,
  onUninstall
}: MarketplaceSkillCardProps) {
  return (
    <Card
      className="group flex h-full cursor-pointer flex-col overflow-hidden transition-colors hover:border-primary/50"
      onClick={onOpenDetail}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xl transition-transform group-hover:scale-110">
              📦
            </div>
            <div className="min-w-0">
              <CardTitle className="min-h-[3rem] break-words text-base leading-6 transition-colors group-hover:text-primary line-clamp-2">
                {skill.name}
              </CardTitle>
              <CardDescription className="mt-1 flex min-w-0 items-center gap-2 text-xs">
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
          <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
            <Button
              variant={isInstalled ? 'destructive' : 'default'}
              size="icon"
              className="h-8 w-8"
              onClick={isInstalled ? onUninstall : onInstall}
              disabled={isInstalling}
              aria-label={isInstalled ? 'uninstall-skill' : 'install-skill'}
            >
              {isInstalling ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : isInstalled ? (
                <Trash2 className="h-4 w-4" />
              ) : (
                <Download className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <p className="mb-3 min-h-[3rem] text-sm text-muted-foreground line-clamp-2">
          {skill.description}
        </p>
        <div className="mt-auto flex min-h-4 items-center gap-4 text-xs text-muted-foreground">
          {skill.downloads !== undefined && (
            <div className="flex items-center gap-1">
              <Download className="h-3 w-3" />
              {skill.downloads.toLocaleString()}
            </div>
          )}
          {skill.stars !== undefined && (
            <div className="flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              {skill.stars.toLocaleString()}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface MarketplaceSkillDetailDialogProps {
  skill: MarketplaceSkill;
  isInstalling: boolean;
  isInstalled: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onClose: () => void;
}

function MarketplaceSkillDetailDialog({
  skill,
  isInstalling,
  isInstalled,
  onInstall,
  onUninstall,
  onClose,
}: MarketplaceSkillDetailDialogProps) {
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
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <CardContent className="space-y-4 overflow-y-auto">
          <div>
            <h3 className="text-sm font-medium text-muted-foreground">描述</h3>
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
            disabled={isInstalling}
          >
            {isInstalling ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : isInstalled ? (
              <Trash2 className="h-4 w-4" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {isInstalled ? 'Uninstall' : 'Install'}
          </Button>
        </div>
      </Card>
    </div>
  );
}

interface SkillGridCardViewModel {
  skillId: string;
  skillName: string;
  skillDescription: string;
  skillIcon: string;
  isCore: boolean;
  isBundled: boolean;
  slug?: string;
  version?: string;
  enabled: boolean;
  configurable: boolean;
  availabilityKind: SkillAvailabilityKind;
  availabilityLabel: string;
  blockedLabel?: string;
  missingSummaryLabel?: string;
  configurableLabel: string;
  sourceLabel: string;
  baseDirText: string;
}

interface SkillGridCardProps extends SkillGridCardViewModel {
  onOpenDetail: (skillId: string) => void;
  onToggleSkill: (skillId: string, enabled: boolean) => void;
  onUninstallSkill: (skillId: string) => void;
}

const SkillGridCard = memo(function SkillGridCard({
  skillId,
  skillName,
  skillDescription,
  skillIcon,
  isCore,
  isBundled,
  slug,
  version,
  enabled,
  configurable,
  availabilityKind,
  availabilityLabel,
  blockedLabel,
  missingSummaryLabel,
  configurableLabel,
  sourceLabel,
  baseDirText,
  onOpenDetail,
  onToggleSkill,
  onUninstallSkill
}: SkillGridCardProps) {
  return (
    <Card
      className={cn(
        'group cursor-pointer rounded-[1.35rem] border border-border/65 bg-card/95 transition-[border-color,background-color,box-shadow]',
        'hover:border-border/85 hover:bg-card',
        enabled && 'bg-card'
      )}
      onClick={() => onOpenDetail(skillId)}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-secondary/45 text-xl">
              <span>{skillIcon}</span>
            </div>
            <div className="min-w-0">
              <CardTitle className="flex min-w-0 items-center gap-2 text-base">
                <span className="min-w-0 truncate">{skillName}</span>
                {isCore ? (
                  <Lock className="h-3 w-3 text-muted-foreground" />
                ) : isBundled ? (
                  <Puzzle className="h-3 w-3 text-blue-500/70" />
                ) : (
                  <Globe className="h-3 w-3 text-purple-500/70" />
                )}
                {slug && slug !== skillName ? (
                  <span className="shrink-0 rounded border border-black/10 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground dark:border-white/10">
                    {slug}
                  </span>
                ) : null}
              </CardTitle>
            </div>
          </div>
          <div className="flex w-[88px] shrink-0 items-center justify-end gap-2">
            {!isBundled && !isCore && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
                onClick={(event) => {
                  event.stopPropagation();
                  onUninstallSkill(skillId);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => {
                onToggleSkill(skillId, checked);
              }}
              disabled={isCore}
              onClick={(event) => event.stopPropagation()}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <p className="line-clamp-2 text-sm leading-6 text-muted-foreground">
          {skillDescription}
        </p>
        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="secondary" className="px-1.5 py-0 h-5 text-[10px] font-medium bg-black/5 dark:bg-white/10 border-0 shadow-none">
            {sourceLabel}
          </Badge>
          <span className="truncate font-mono">{baseDirText}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {version && (
            <Badge variant="outline" className="text-xs">
              v{version}
            </Badge>
          )}
          <Badge variant="outline" className={cn('text-xs', getAvailabilityBadgeClass(availabilityKind))}>
            {availabilityLabel}
          </Badge>
          {configurable && (
            <Badge variant="secondary" className="text-xs">
              <Settings className="h-3 w-3 mr-1" />
              {configurableLabel}
            </Badge>
          )}
        </div>
        {availabilityKind === 'blocked' && blockedLabel && (
          <p className="mt-2 text-xs text-muted-foreground">
            {blockedLabel}
          </p>
        )}
        {missingSummaryLabel && availabilityKind !== 'eligible' && (
          <p className="mt-2 text-xs text-muted-foreground break-all">
            {missingSummaryLabel}
          </p>
        )}
      </CardContent>
    </Card>
  );
});

export function Skills() {
  const skills = useSkillsStore((state) => state.skills);
  const snapshotReady = useSkillsStore((state) => state.snapshotReady);
  const initialLoading = useSkillsStore((state) => state.initialLoading);
  const refreshing = useSkillsStore((state) => state.refreshing);
  const mutating = useSkillsStore((state) => state.mutating);
  const error = useSkillsStore((state) => state.error);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const enableSkill = useSkillsStore((state) => state.enableSkill);
  const disableSkill = useSkillsStore((state) => state.disableSkill);
  const searchResults = useSkillsStore((state) => state.searchResults);
  const searchSkills = useSkillsStore((state) => state.searchSkills);
  const installSkill = useSkillsStore((state) => state.installSkill);
  const uninstallSkill = useSkillsStore((state) => state.uninstallSkill);
  const searching = useSkillsStore((state) => state.searching);
  const searchError = useSkillsStore((state) => state.searchError);
  const installing = useSkillsStore((state) => state.installing);
  const { t } = useTranslation('skills');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [searchQuery, setSearchQuery] = useState('');
  const [marketplaceQuery, setMarketplaceQuery] = useState('');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [selectedMarketplaceSkill, setSelectedMarketplaceSkill] = useState<MarketplaceSkill | null>(null);
  const [activeTab, setActiveTab] = useState('all');
  const isAllTabActive = activeTab === 'all';
  const [selectedSource, setSelectedSource] = useState<'all' | 'eligible' | 'built-in' | 'marketplace'>('eligible');
  const [skillsHeavyContentReady, setSkillsHeavyContentReady] = useState(false);
  const marketplaceDiscoveryAttemptedRef = useRef(false);

  const isGatewayRunning = gatewayStatus.state === 'running';
  const [showGatewayWarning, setShowGatewayWarning] = useState(false);

  // Debounce the gateway warning to avoid flickering during brief restarts (like skill toggles)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!isGatewayRunning) {
      // Wait 1.5s before showing the warning
      timer = setTimeout(() => {
        setShowGatewayWarning(true);
      }, 1500);
    } else {
      setShowGatewayWarning((prev) => (prev ? false : prev));
    }
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [isGatewayRunning]);

  // Fetch skills on mount.
  // 技能数据通常在 App 启动预热/其他页面交互后已存在，切页进入技能页时
  // 仅在本地快照未就绪时自动拉取，避免重复触发 skills.status 带来日志噪音。
  useEffect(() => {
    if (isGatewayRunning && !snapshotReady) {
      void fetchSkills();
    }
  }, [fetchSkills, isGatewayRunning, snapshotReady]);

  useEffect(() => {
    if (skillsHeavyContentReady) {
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
  }, [skillsHeavyContentReady]);

  // Filter skills
  const safeSkills = useMemo(() => (Array.isArray(skills) ? skills : []), [skills]);
  const skillById = useMemo(() => {
    return new Map(safeSkills.map((skill) => [skill.id, skill] as const));
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

      let matchesSource = true;
      if (deferredSelectedSource === 'eligible') {
        matchesSource = skill.eligible === true;
      } else if (deferredSelectedSource === 'built-in') {
        matchesSource = !!skill.isBundled;
      } else if (deferredSelectedSource === 'marketplace') {
        matchesSource = !skill.isBundled;
      }

      return matchesSearch && matchesSource;
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
  }, [deferredSearchQuery, deferredSelectedSource, skillsForView]);
  const showInitialLoading = !snapshotReady && initialLoading;
  const manualRefreshBusy = refreshing || mutating;

  const filteredSkillCards = useMemo<SkillGridCardViewModel[]>(() => {
    const configurableLabel = t('detail.configurable');
    const blockedLabel = t('availability.blockedByAllowlist');
    return filteredSkills.map((skill) => {
      const availabilityKind = getSkillAvailabilityKind(skill);
      const missingSummary = formatMissingSummary(skill.missing);
      const availabilityLabel = availabilityKind === 'disabled'
        ? t('detail.disabled')
        : t(`availability.${availabilityKind}`);
      return {
        skillId: skill.id,
        skillName: skill.name,
        skillDescription: skill.description,
        skillIcon: skill.icon || '🧩',
        isCore: Boolean(skill.isCore),
        isBundled: Boolean(skill.isBundled),
        slug: skill.slug,
        version: skill.version,
        enabled: skill.enabled,
        configurable: Boolean(skill.configurable),
        availabilityKind,
        availabilityLabel,
        blockedLabel,
        missingSummaryLabel: missingSummary && availabilityKind !== 'eligible'
          ? t('availability.missingPrefix', { items: missingSummary })
          : undefined,
        configurableLabel,
        sourceLabel: resolveSkillSourceLabel(skill, t),
        baseDirText: skill.baseDir || t('detail.pathUnavailable'),
      };
    });
  }, [filteredSkills, t]);

  const sourceStats = useMemo(() => {
    if (!isAllTabActive) {
      return { all: 0, eligible: 0, builtIn: 0, marketplace: 0 };
    }
    return {
      all: safeSkills.length,
      eligible: safeSkills.filter((s) => s.eligible === true).length,
      builtIn: safeSkills.filter((s) => s.isBundled).length,
      marketplace: safeSkills.filter((s) => !s.isBundled).length,
    };
  }, [isAllTabActive, safeSkills]);

  const bulkToggleVisible = useCallback(async (enable: boolean) => {
    const candidates = filteredSkills.filter((skill) => !skill.isCore && skill.enabled !== enable);
    if (candidates.length === 0) {
      toast.info(enable ? t('toast.noBatchEnableTargets') : t('toast.noBatchDisableTargets'));
      return;
    }

    let succeeded = 0;
    for (const skill of candidates) {
      try {
        if (enable) {
          await enableSkill(skill.id);
        } else {
          await disableSkill(skill.id);
        }
        succeeded += 1;
      } catch {
        // Continue to next skill and report final summary.
      }
    }

    trackUiEvent('skills.batch_toggle', { enable, total: candidates.length, succeeded });
    if (succeeded === candidates.length) {
      toast.success(enable ? t('toast.batchEnabled', { count: succeeded }) : t('toast.batchDisabled', { count: succeeded }));
      return;
    }
    toast.warning(t('toast.batchPartial', { success: succeeded, total: candidates.length }));
  }, [disableSkill, enableSkill, filteredSkills, t]);

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
      const targetDir = typeof skill.baseDir === 'string' ? skill.baseDir.trim() : '';
      if (!targetDir) {
        throw new Error('Skill path not available');
      }
      const openResult = await invokeIpc<string>('shell:openPath', targetDir);
      if (openResult) {
        if (
          openResult.toLowerCase().includes('no such file')
          || openResult.toLowerCase().includes('not found')
          || openResult.toLowerCase().includes('failed to open')
        ) {
          throw new Error(t('toast.failedFolderNotFound'));
        }
        throw new Error(openResult);
      }
    } catch (err) {
      toast.error(t('toast.failedOpenActualFolder') + ': ' + String(err));
    }
  }, [t]);

  const handleToggleSkillQuick = useCallback((skillId: string, enable: boolean) => {
    void handleToggle(skillId, enable);
  }, [handleToggle]);

  const hasInstalledSkills = useMemo(() => skills.some((s) => !s.isBundled), [skills]);

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
      // Automatically enable after install
      // We need to find the skill id which is usually the slug
      await enableSkill(slug);
      toast.success(t('toast.installed'));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (['installTimeoutError', 'installRateLimitError'].includes(errorMessage)) {
        toast.error(t(`toast.${errorMessage}`, { path: skillsDirPath }), { duration: 10000 });
      } else {
        toast.error(t('toast.failedInstall') + ': ' + errorMessage);
      }
    }
  }, [installSkill, enableSkill, t, skillsDirPath]);

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
  const handleUninstall = useCallback(async (slug: string) => {
    try {
      await uninstallSkill(slug);
      toast.success(t('toast.uninstalled'));
    } catch (err) {
      toast.error(t('toast.failedUninstall') + ': ' + String(err));
    }
  }, [uninstallSkill, t]);

  const handleUninstallSkillQuick = useCallback((slug: string) => {
    void handleUninstall(slug);
  }, [handleUninstall]);

  const selectedMarketplaceInstalled = useMemo(() => {
    if (!selectedMarketplaceSkill) {
      return false;
    }
    return safeSkills.some((s) => s.id === selectedMarketplaceSkill.slug || s.name === selectedMarketplaceSkill.name);
  }, [safeSkills, selectedMarketplaceSkill]);

  const selectedMarketplaceInstalling = selectedMarketplaceSkill
    ? Boolean(installing[selectedMarketplaceSkill.slug])
    : false;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => { void fetchSkills({ force: true }); }} disabled={!isGatewayRunning || manualRefreshBusy}>
            <RefreshCw className={cn('h-4 w-4 mr-2', refreshing && 'animate-spin')} />
            {t('refresh')}
          </Button>
          {hasInstalledSkills && (
            <Button variant="outline" onClick={handleOpenSkillsFolder}>
              <FolderOpen className="h-4 w-4 mr-2" />
              {t('openFolder')}
            </Button>
          )}
        </div>
      </div>

      {/* Gateway Warning */}
      {showGatewayWarning && (
        <Card className="border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10">
          <CardContent className="py-4 flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-yellow-600" />
            <span className="text-yellow-700 dark:text-yellow-400">
              {t('gatewayWarning')}
            </span>
          </CardContent>
        </Card>
      )}

      {refreshing && snapshotReady && (
        <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          {t('common:status.loading', 'Loading...')}
        </div>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all" className="gap-2">
            <Puzzle className="h-4 w-4" />
            {t('tabs.installed')}
          </TabsTrigger>
          <TabsTrigger value="marketplace" className="gap-2">
            <Globe className="h-4 w-4" />
            {t('tabs.marketplace')}
          </TabsTrigger>
          {/* <TabsTrigger value="bundles" className="gap-2">
            <Package className="h-4 w-4" />
            Bundles
          </TabsTrigger> */}
        </TabsList>

        {activeTab === 'all' ? (
          <TabsContent value="all" className="space-y-6 mt-6">
          {/* Search and Filter */}
          <div className="flex gap-4 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('search')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
            </div>

            <div className="flex gap-2">
              <Button
                variant={selectedSource === 'all' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedSource('all')}
              >
                All ({sourceStats.all})
              </Button>
              <Button
                variant={selectedSource === 'built-in' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedSource('built-in')}
                className="gap-2"
              >
                <Puzzle className="h-3 w-3" />
                {t('filter.builtIn', { count: sourceStats.builtIn })}
              </Button>
              <Button
                variant={selectedSource === 'eligible' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedSource('eligible')}
                className="gap-2"
              >
                <CheckCircle2 className="h-3 w-3" />
                {t('filter.eligible', { count: sourceStats.eligible })}
              </Button>
              <Button
                variant={selectedSource === 'marketplace' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedSource('marketplace')}
                className="gap-2"
              >
                <Globe className="h-3 w-3" />
                {t('filter.marketplace', { count: sourceStats.marketplace })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void bulkToggleVisible(true); }}
              >
                {t('actions.enableVisible')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void bulkToggleVisible(false); }}
              >
                {t('actions.disableVisible')}
              </Button>
            </div>
          </div>

          {/* Error Display */}
          {error && (
            <Card className="border-destructive">
              <CardContent className="py-4 text-destructive flex items-center gap-2">
                <AlertCircle className="h-5 w-5 shrink-0" />
                <span>
                  {['fetchTimeoutError', 'fetchRateLimitError', 'timeoutError', 'rateLimitError'].includes(error)
                    ? t(`toast.${error}`, { path: skillsDirPath })
                    : error}
                </span>
              </CardContent>
            </Card>
          )}

          {/* Skills Grid */}
          {!skillsHeavyContentReady ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <Card key={`skills-placeholder-${index}`}>
                  <CardHeader className="pb-3">
                    <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
                    <div className="mt-2 h-3 w-4/5 animate-pulse rounded bg-muted" />
                  </CardHeader>
                  <CardContent>
                    <div className="h-3 w-full animate-pulse rounded bg-muted" />
                    <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-muted" />
                    <div className="mt-4 h-6 w-24 animate-pulse rounded bg-muted" />
                  </CardContent>
                </Card>
              ))}
            </div>
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
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredSkillCards.map((skill) => (
                <SkillGridCard
                  key={skill.skillId}
                  {...skill}
                  onOpenDetail={handleOpenSkillDetail}
                  onToggleSkill={handleToggleSkillQuick}
                  onUninstallSkill={handleUninstallSkillQuick}
                />
              ))}
            </div>
          )}
          </TabsContent>
        ) : null}

        {activeTab === 'marketplace' ? (
          <TabsContent value="marketplace" className="space-y-6 mt-6">
          <div className="flex flex-col gap-4">
            <Card className="border-muted/50 bg-muted/20">
              <CardContent className="py-4 flex items-start gap-3">
                <ShieldCheck className="h-5 w-5 text-muted-foreground mt-0.5" />
                <div className="text-muted-foreground">
                  {t('marketplace.securityNote')}
                </div>
              </CardContent>
            </Card>
            <Card className="border-info/30 bg-info/5">
              <CardContent className="py-3 text-sm flex items-start gap-3 text-muted-foreground">
                <div className="flex items-start gap-2">
                  <Download className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{t('marketplace.manualInstallHint', { path: skillsDirPath })}</span>
                </div>
              </CardContent>
            </Card>
            <div className="flex gap-4">
              <form onSubmit={handleMarketplaceSearch} className="flex-1 flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={t('searchMarketplace')}
                    value={marketplaceQuery}
                    onChange={(e) => setMarketplaceQuery(e.target.value)}
                    className="pl-9 pr-9"
                  />
                  {marketplaceQuery && (
                    <button
                      type="button"
                      className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
                      onClick={() => setMarketplaceQuery('')}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <Button type="submit" disabled={searching} className="min-w-[100px] gap-2">
                  {searching && <RefreshCw className="h-4 w-4 animate-spin" />}
                  <span>{searching ? t('marketplace.searching') : t('searchButton')}</span>
                </Button>
              </form>
            </div>

            {searchError && (
              <Card className="border-destructive/50 bg-destructive/5">
                <CardContent className="py-3 text-sm text-destructive flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    {['searchTimeoutError', 'searchRateLimitError', 'timeoutError', 'rateLimitError'].includes(searchError.replace('Error: ', ''))
                      ? t(`toast.${searchError.replace('Error: ', '')}`, { path: skillsDirPath })
                      : t('marketplace.searchError')}
                  </span>
                </CardContent>
              </Card>
            )}

            {searchResults.length > 0 ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {searchResults.map((skill) => {
                  const isInstalled = safeSkills.some((s) => s.id === skill.slug || s.name === skill.name);
                  return (
                    <MarketplaceSkillCard
                      key={skill.slug}
                      skill={skill}
                      isInstalling={!!installing[skill.slug]}
                      isInstalled={isInstalled}
                      onOpenDetail={() => setSelectedMarketplaceSkill(skill)}
                      onInstall={() => handleInstall(skill.slug)}
                      onUninstall={() => handleUninstall(skill.slug)}
                    />
                  );
                })}
              </div>
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
          onInstall={() => { void handleInstall(selectedMarketplaceSkill.slug); }}
          onUninstall={() => { void handleUninstall(selectedMarketplaceSkill.slug); }}
          onClose={() => setSelectedMarketplaceSkill(null)}
        />
      )}
    </div>
  );
}

export default Skills;
