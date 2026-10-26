import { createContext, memo, useCallback, useContext, useDeferredValue, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode,
  FolderOpen,
  Globe,
  Key,
  Lock,
  Plus,
  Puzzle,
  Save,
  Search,
  Settings,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AgentPageToolbar, AgentResourceCard, AgentResourceFooter, AgentResourceGrid, AgentResourceIcon, AgentResourcePill } from '@/components/common/AgentPage';
import { LoadingState } from '@/components/common/LoadingSpinner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { useIdleReady } from '@/lib/idle-ready';
import { createSessionTraceId, logSessionTrace, summarizeError, summarizeIdentifier } from '@/lib/session-trace';
import { requireSkillsScope, waitForSkillsMutation } from '@/lib/skills';
import { trackUiEvent } from '@/lib/telemetry';
import { cn } from '@/lib/utils';
import type { CapabilityTarget } from '@/types/desktop/capability-target';
import type { Skill, SkillMissingRequirements } from '@/types/skill';
import type { SkillOwnerProps, SkillToolbarProps, SkillViewProps } from '../extensions';
import {
  buildMarketplaceSkillUrl,
  normalizeSkillErrorCode,
  resolveSkillSourceLabel,
  SKILL_CARD_DESCRIPTION_CLASS_NAME,
  SKILL_CARD_ICON_CLASS_NAME,
  SkillDefaultHeaderActions,
  SkillRuntimeOwner,
  useSkillsDirectoryPath,
} from '../presentation';
import { useSkillsStore } from '../stores/skills';

type SkillAvailabilityKind = 'eligible' | 'missing' | 'disabled' | 'unselectable' | 'unknown';
type InstalledSkillSourceFilter = 'all' | 'built-in' | 'managed';
const SKILL_MANAGEMENT_CAPABILITY_ID = 'skill.management';
const FETCH_ERROR_CODES = new Set(['fetchTimeoutError', 'fetchRateLimitError', 'timeoutError', 'rateLimitError']);

async function skillManagementCapabilityExecute<TResult>(
  operationId: string,
  input: Record<string, unknown>,
  target: CapabilityTarget,
  traceId?: string | null,
): Promise<TResult> {
  const scope = requireSkillsScope();
  logSessionTrace('skill.open-path.scope', traceId, () => ({
    kind: ['app', 'runtime-instance', 'agent', 'session', 'workspace', 'team-run', 'provider-routing'].includes(scope.kind) ? scope.kind : 'unknown',
    isOpenClawLocal: scope.kind === 'runtime-instance' && scope.endpoint.kind === 'native-runtime'
      && scope.endpoint.runtimeAdapterId === 'openclaw' && scope.endpoint.runtimeInstanceId === 'local',
  }));
  logSessionTrace('skill.open-path.request', traceId, () => ({ capabilityId: SKILL_MANAGEMENT_CAPABILITY_ID, operationId: 'clawhub.openPath' }));
  return await hostApiFetch<TResult>('/api/capabilities/execute', {
    method: 'POST',
    traceId,
    body: JSON.stringify({
      id: SKILL_MANAGEMENT_CAPABILITY_ID,
      operationId,
      scope,
      target,
      input,
    }),
  });
}

function getSkillAvailabilityKind(skill: Skill): SkillAvailabilityKind {
  if (skill.source === 'native-agent-candidate') return 'unknown';
  if (!skill.enabled || skill.unavailableReason === 'disabled') return 'disabled';
  if (skill.unavailableReason === 'missingRequirements' || formatMissingSummary(skill.missing) || (skill.missingCategories?.length ?? 0) > 0) return 'missing';
  if (skill.eligible === true) return 'eligible';
  if (skill.selectable === false || skill.unavailableReason === 'ineligible') return 'unselectable';
  return 'unknown';
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

interface SkillDetailDialogProps {
  skill: Skill;
  onClose: () => void;
  onToggle: (enabled: boolean) => void;
  selectionCurrent: () => boolean;
  onOpenFolder?: (skill: Skill) => Promise<void> | void;
}

function SkillDetailDialog({ skill, onClose, onToggle, selectionCurrent, onOpenFolder }: SkillDetailDialogProps) {
  const { t } = useTranslation('skills');
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);
  const nativeAgent = skill.runtimeId === 'matcha-agent';
  const [readme, setReadme] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('info');
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(() => skill.config?.env
    ? Object.entries(skill.config.env).map(([key, value]) => ({ key, value: String(value) }))
    : []);
  const [apiKey, setApiKey] = useState(() => skill.config?.apiKey ? String(skill.config.apiKey) : '');
  const [previousConfig, setPreviousConfig] = useState(skill.config);
  if (previousConfig !== skill.config) {
    setPreviousConfig(skill.config);
    setApiKey(skill.config?.apiKey ? String(skill.config.apiKey) : '');
    setEnvVars(skill.config?.env
      ? Object.entries(skill.config.env).map(([key, value]) => ({ key, value: String(value) }))
      : []);
  }
  const [isEnvExpanded, setIsEnvExpanded] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const availabilityKind = getSkillAvailabilityKind(skill);
  const missingSummary = formatSkillMissingSummary(skill);
  const availabilityLabel = resolveAvailabilityLabel(availabilityKind, t);

  const handleOpenClawhub = async () => {
    if (skill.slug) {
      await invokeIpc('shell:openExternal', buildMarketplaceSkillUrl(skill.slug));
    }
  };

  const handleOpenEditor = async () => {
    if (!skill?.id) return;
    try {
      if (nativeAgent) {
        const scope = requireSkillsScope();
        const result = await hostApiFetch<{ success: boolean; content?: string }>('/api/skills/readme', {
          method: 'POST', body: JSON.stringify({ skillKey: skill.id, scope }),
        });
        if (!selectionCurrent()) return;
        if (!result.success || typeof result.content !== 'string') throw new Error('Skill manifest unavailable');
        setReadme(result.content);
        return;
      }
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
    if (isSaving || nativeAgent) return;
    const scope = requireSkillsScope();
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

      const receipt = await skillManagementCapabilityExecute<unknown>(
        'skills.updateConfig',
        {
          skillKey: skill.id,
          apiKey: apiKey || '',
          env: envObj,
        },
        { kind: 'skill', skillId: skill.id, slug: skill.slug },
      );

      const result = await waitForSkillsMutation(receipt, 'skills.updateConfig', { skillKey: skill.id, scope });
      if (!selectionCurrent()) return;
      if (result.outcome !== 'accepted') {
        await fetchSkills({ force: true, fresh: true, scope });
        throw new Error(`Skill config ${result.outcome}${result.invalidKeys?.length ? ': ' + result.invalidKeys.join(', ') : ''}`);
      }

      await fetchSkills({ force: true, fresh: true, scope });
      if (!selectionCurrent()) return;

      toast.success(t('detail.configSaved'));
    } catch (err) {
      if (selectionCurrent()) {
        toast.error(t('toast.failedSave') + ': ' + String(err));
      }
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
              {!nativeAgent && <TabsTrigger value="config" disabled={skill.isCore}>{t('detail.config')}</TabsTrigger>}
            </TabsList>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="p-6">
              <TabsContent value="info" className="mt-0 space-y-4">
                {readme !== null && <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-sm">{readme}</pre>}
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
              {nativeAgent ? <span>{t('nativeCandidateShort', { defaultValue: '候选 · 新会话生效' })}</span> : skill.enabled ? (
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
              {!nativeAgent && <Switch
                checked={skill.enabled}
                onCheckedChange={() => onToggle(!skill.enabled)}
                disabled={skill.isCore}
              />}
            </div>
          </div>
        </Tabs>
      </Card>
    </div>
  );
}

interface SkillGridCardViewModel {
  skillId: string;
  skillName: string;
  skillDescription: string;
  skillIcon: string;
  nativeAgent: boolean;
  sourceLabel: string;
  isCore: boolean;
  uninstallable: boolean;
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
  onUninstallSkill: (skillId: string, slug?: string) => void;
}

const SkillGridCard = memo(function SkillGridCard({
  skillId,
  skillName,
  skillDescription,
  skillIcon,
  nativeAgent,
  sourceLabel,
  isCore,
  uninstallable,
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
          {slug && slug !== skillName && <p className="mt-1 truncate text-xs text-muted-foreground">{slug}</p>}
        </div>
        {uninstallable && (
          <Button
            variant="ghost"
            size="icon"
            className="relative z-10 size-8 shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`${t('actions.uninstall')} ${skillName}`}
            onClick={() => onUninstallSkill(skillId, slug)}
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
          <span className="truncate">{nativeAgent ? t('nativeCandidateShort', { defaultValue: '候选 · 新会话生效' }) : availabilityLabel}</span>
        </span>
        {!nativeAgent && <Switch
          className="relative z-10 shrink-0"
          checked={enabled}
          onCheckedChange={(checked) => onToggleSkill(skillId, checked)}
          disabled={isCore || mutationLocked}
          aria-label={`${enabled ? t('detail.enabled') : t('detail.disabled')}: ${skillName}`}
        />}
      </AgentResourceFooter>
    </AgentResourceCard>
  );
});

interface InstalledUiIntent {
  skillsView: ReturnType<typeof useInstalledSkillsView>;
  onOpenDetail: (skillId: string) => void;
  onToggleSkill: (skillId: string, enabled: boolean) => void;
  onUninstallSkill: (skillId: string, slug?: string) => void;
}

const InstalledUiContext = createContext<InstalledUiIntent | null>(null);

export function InstalledOwner(props: SkillOwnerProps) {
  const { scopeKey, openClaw, selectionCurrent, children } = props;
  const skillsView = useInstalledSkillsView({ ...props, active: props.activeViewId === 'all' });
  const { t } = useTranslation('skills');
  const enableSkill = useSkillsStore((state) => state.enableSkill);
  const disableSkill = useSkillsStore((state) => state.disableSkill);
  const uninstallSkill = useSkillsStore((state) => state.uninstallSkill);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [detailScopeKey, setDetailScopeKey] = useState(scopeKey);

  if (detailScopeKey !== scopeKey) {
    setDetailScopeKey(scopeKey);
    setSelectedSkill(null);
  }

  const handleToggle = useCallback(async (skillId: string, enable: boolean) => {
    try {
      if (enable) {
        await enableSkill(skillId);
        if (!selectionCurrent()) return;
        toast.success(t('toast.enabled'));
      } else {
        await disableSkill(skillId);
        if (!selectionCurrent()) return;
        toast.success(t('toast.disabled'));
      }
      setSelectedSkill((skill) => skill?.id === skillId ? { ...skill, enabled: enable } : skill);
    } catch (err) {
      if (selectionCurrent()) toast.error(String(err));
    }
  }, [enableSkill, disableSkill, selectionCurrent, t]);

  const handleOpenSkillDetail = useCallback((skillId: string) => {
    const state = useSkillsStore.getState();
    if (state.scopeKey !== scopeKey || !selectionCurrent()) return;
    const nextSkill = state.skills.find((skill) => skill.id === skillId);
    if (nextSkill) setSelectedSkill(nextSkill);
  }, [scopeKey, selectionCurrent]);

  const handleOpenSkillFolder = useCallback(async (skill: Skill) => {
    if (!openClaw) return;
    const traceId = createSessionTraceId('skill.open-path');
    logSessionTrace('skill.open-path.click', traceId, () => {
      const source = (skill.source || '').trim().toLowerCase();
      return {
        skillHash: summarizeIdentifier(skill.id).hash,
        slugHash: summarizeIdentifier(skill.slug).hash,
        hasBaseDir: Boolean(skill.baseDir),
        hasFilePath: Boolean(skill.filePath),
        source: ['bundled', 'managed', 'openclaw-bundled', 'openclaw-managed', 'openclaw-workspace', 'openclaw-extra', 'openclaw-custodian', 'agents-skills-personal', 'agents-skills-project', 'matcha-sealed'].includes(source) ? source : 'unknown',
      };
    });
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
        traceId,
      );
      logSessionTrace('skill.open-path.result', traceId, () => ({ success: result.success }));
      if (!result.success) {
        throw new Error(result.error || t('toast.failedOpenActualFolder'));
      }
    } catch (err) {
      logSessionTrace('skill.open-path.failed', traceId, () => summarizeError(err));
      toast.error(t('toast.failedOpenActualFolder') + ': ' + String(err));
    }
  }, [openClaw, t]);

  const handleToggleSkillQuick = useCallback((skillId: string, enable: boolean) => {
    void handleToggle(skillId, enable);
  }, [handleToggle]);

  const handleUninstall = useCallback(async (skillKey: string, slug?: string) => {
    try {
      await uninstallSkill(skillKey, slug);
      if (!selectionCurrent()) return;
      toast.success(t('toast.uninstalled'));
    } catch (err) {
      if (selectionCurrent()) {
        toast.error(t('toast.failedUninstall') + ': ' + String(err));
      }
    }
  }, [uninstallSkill, selectionCurrent, t]);

  const handleUninstallSkillQuick = useCallback((skillKey: string, slug?: string) => {
    void handleUninstall(skillKey, slug);
  }, [handleUninstall]);

  const intent = useMemo<InstalledUiIntent>(() => ({
    skillsView,
    onOpenDetail: handleOpenSkillDetail,
    onToggleSkill: handleToggleSkillQuick,
    onUninstallSkill: handleUninstallSkillQuick,
  }), [skillsView, handleOpenSkillDetail, handleToggleSkillQuick, handleUninstallSkillQuick]);

  return (
    <SkillRuntimeOwner {...props}>
      <InstalledUiContext.Provider value={intent}>
        {children}
        {selectedSkill && (
          <SkillDetailDialog
            skill={selectedSkill}
            selectionCurrent={selectionCurrent}
            onClose={() => setSelectedSkill(null)}
            onToggle={(enabled) => {
              void handleToggle(selectedSkill.id, enabled);
            }}
            onOpenFolder={openClaw ? handleOpenSkillFolder : undefined}
          />
        )}
      </InstalledUiContext.Provider>
    </SkillRuntimeOwner>
  );
}

function useInstalledSkillsView({ scope, scopeKey, openClaw, active }: SkillViewProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const storeScopeKey = useSkillsStore((state) => state.scopeKey);
  const storedSkills = useSkillsStore((state) => state.skills);
  const snapshotReady = useSkillsStore((state) => state.snapshotReady);
  const storeError = useSkillsStore((state) => state.error);
  const skills = useMemo(() => storeScopeKey === scopeKey && Array.isArray(storedSkills) ? storedSkills : [], [storeScopeKey, scopeKey, storedSkills]);
  const error = storeScopeKey === scopeKey ? storeError : null;
  const skillsSnapshotReady = storeScopeKey === scopeKey && snapshotReady;
  const skillsContentReady = useIdleReady(skillsSnapshotReady);
  const searchQuery = searchParams.get('search') || '';
  const sourceParam = searchParams.get('source');
  const selectedSource: InstalledSkillSourceFilter = sourceParam === 'built-in' || sourceParam === 'managed' ? sourceParam : 'all';
  const statusParam = searchParams.get('status') || 'all';
  const selectedStatus = openClaw && ['enabled', 'disabled', 'eligible', 'missing', 'unselectable', 'unknown'].includes(statusParam) ? statusParam : 'all';
  const deferredSkills = useDeferredValue(skills);
  const deferredSearchQuery = useDeferredValue(active ? searchQuery : '');
  const deferredSelectedSource = useDeferredValue(active ? selectedSource : 'all');
  const skillsForView = useMemo(() => active && skillsContentReady ? deferredSkills : [], [active, skillsContentReady, deferredSkills]);
  const filteredSkills = useMemo(() => {
    if (!active) return [];
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
  }, [active, deferredSearchQuery, deferredSelectedSource, selectedStatus, skillsForView]);
  const updateQuery = (key: string, value: string) => {
    setSearchParams((params) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  };

  return {
    skills,
    error,
    skillsSnapshotReady,
    skillsContentReady,
    showInitialLoading: Boolean(scope) && !skillsSnapshotReady && (storeScopeKey !== scopeKey || !error),
    searchQuery,
    selectedSource,
    selectedStatus,
    filteredSkills,
    updateQuery,
  };
}

export function InstalledToolbar(props: SkillToolbarProps) {
  const { active, openClaw, selectionCurrent, navigation, entries, viewControls } = props;
  const { t } = useTranslation('skills');
  const intent = useContext(InstalledUiContext);
  if (!intent) throw new Error('InstalledToolbar requires InstalledOwner');
  const { skills, skillsSnapshotReady, skillsContentReady, searchQuery, selectedSource, selectedStatus, filteredSkills, updateQuery } = intent.skillsView;
  const batchSetSkillsEnabled = useSkillsStore((state) => state.batchSetSkillsEnabled);
  const sourceStats = useMemo(() => {
    if (!active) return { all: 0, builtIn: 0, managed: 0 };
    return {
      all: skills.length,
      builtIn: skills.filter((skill) => skill.isBundled).length,
      managed: skills.filter((skill) => !skill.isBundled).length,
    };
  }, [active, skills]);
  const bulkToggleVisible = useCallback(async (enable: boolean) => {
    const candidates = filteredSkills.filter((skill) => !skill.isCore && skill.enabled !== enable);
    if (candidates.length === 0) {
      toast.info(enable ? t('toast.noBatchEnableTargets') : t('toast.noBatchDisableTargets'));
      return;
    }

    try {
      const result = await batchSetSkillsEnabled(candidates.map((skill) => skill.id), enable);
      if (!selectionCurrent()) return;
      const succeeded = result.updated.length;
      trackUiEvent('skills.batch_toggle', { enable, total: candidates.length, succeeded });
      if (result.success) toast.success(enable ? t('toast.batchEnabled', { count: succeeded }) : t('toast.batchDisabled', { count: succeeded }));
      else toast.warning(t('toast.batchPartial', { success: succeeded, total: candidates.length }));
    } catch (error) {
      if (selectionCurrent()) toast.error(String(error));
    }
  }, [batchSetSkillsEnabled, filteredSkills, selectionCurrent, t]);

  if (!active) return null;
  return (
    <AgentPageToolbar className="w-full max-w-full flex-nowrap overflow-x-auto">
      {navigation}
      <div className="relative min-w-40 max-w-72 flex-1">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <Input aria-label={t('search')} placeholder={t('search')} value={searchQuery} onChange={(e) => updateQuery('search', e.target.value)} className="h-9 pl-9 text-sm" />
      </div>
      <Select aria-label={t('filter.source')} value={selectedSource} onChange={(e) => updateQuery('source', e.target.value)} className="h-9 w-auto max-w-full shrink-0 text-xs">
        {skillsSnapshotReady ? <>
          <option value="all">{t('filter.all', { count: sourceStats.all })}</option>
          <option value="built-in">{t('filter.builtIn', { count: sourceStats.builtIn })}</option>
          <option value="managed">{t('filter.managed', { count: sourceStats.managed })}</option>
        </> : <option value={selectedSource}>{t('filter.source')}</option>}
      </Select>
      {openClaw && <Select aria-label={t('filter.status')} value={selectedStatus} onChange={(e) => updateQuery('status', e.target.value)} className="h-9 w-auto max-w-full shrink-0 text-xs">
        <option value="all">{t('filter.allStatuses')}</option>
        <option value="enabled">{t('filter.enabled')}</option>
        <option value="disabled">{t('filter.disabled')}</option>
        {(['eligible', 'missing', 'unselectable', 'unknown'] as const).map((kind) => <option key={kind} value={kind}>{resolveAvailabilityLabel(kind, t)}</option>)}
      </Select>}
      {openClaw && <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => { void bulkToggleVisible(true); }}>{t('actions.enableVisible')}</Button>
        <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => { void bulkToggleVisible(false); }}>{t('actions.disableVisible')}</Button>
      </div>}
      <div className="ml-auto flex shrink-0 items-center gap-3 whitespace-nowrap">
        {skillsSnapshotReady && skillsContentReady && <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">{t('count', { count: filteredSkills.length })}</span>}
        {entries}
        {viewControls}
      </div>
    </AgentPageToolbar>
  );
}

export function InstalledSkillsView(props: SkillViewProps) {
  const { active, scope, view } = props;
  const { t } = useTranslation('skills');
  const intent = useContext(InstalledUiContext);
  if (!intent) throw new Error('InstalledSkillsView requires InstalledOwner');
  const { error, skillsSnapshotReady, skillsContentReady, showInitialLoading, searchQuery, filteredSkills } = intent.skillsView;
  const skillsDirPath = useSkillsDirectoryPath();
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
        nativeAgent: skill.runtimeId === 'matcha-agent',
        sourceLabel: resolveSkillSourceLabel(skill, t),
        isCore: Boolean(skill.isCore),
        uninstallable: skill.uninstallable === true,
        slug: skill.slug,
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

  if (!active) return null;
  return (
    <div className="space-y-6">
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

      {showInitialLoading || (skillsSnapshotReady && !skillsContentReady) ? (
        <LoadingState label={t('common:status.loading')} />
      ) : !skillsSnapshotReady ? null : filteredSkillCards.length === 0 ? (
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
        <AgentResourceGrid className={view === 'list' ? 'md:grid-cols-1 xl:grid-cols-1' : undefined}>
          {filteredSkillCards.map((skill) => (
            <SkillGridCard
              key={skill.skillId}
              {...skill}
              mutationLocked={!scope}
              onOpenDetail={intent.onOpenDetail}
              onToggleSkill={intent.onToggleSkill}
              onUninstallSkill={intent.onUninstallSkill}
            />
          ))}
        </AgentResourceGrid>
      )}
    </div>
  );
}

export function InstalledHeaderActions(props: SkillViewProps) {
  return <SkillDefaultHeaderActions {...props} />;
}

export function InstalledBadge({ scopeKey }: SkillViewProps) {
  const skillsSnapshotReady = useSkillsStore((state) => state.scopeKey === scopeKey && state.snapshotReady);
  const count = useSkillsStore((state) => state.scopeKey === scopeKey ? state.skills.length : 0);
  return skillsSnapshotReady ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">{count}</span> : null;
}
