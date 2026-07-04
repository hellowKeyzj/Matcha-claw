import { AgentAvatar } from '@/components/common/AgentAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AGENT_AVATAR_PICKER_OPTION_COUNT,
  buildAvatarPickerSeeds,
  DEFAULT_AGENT_AVATAR_STYLE,
  type AgentAvatarStyle,
} from '@/lib/agent-avatar';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  buildSubagentWorkspacePath,
  hasSubagentNameConflict,
} from '@/features/subagents/domain/workspace';
import type { ModelCatalogEntry, DraftByFile, PreviewDiffByFile, SubagentSummary, SubagentTargetFile } from '@/types/subagent';
import type { AgentSkillConfigView, SetAgentSkillConfigCommand } from '@/stores/agent-skill-config';
import type { AgentToolConfigOption, AgentToolConfigView, SetAgentToolConfigCommand } from '@/stores/agent-tool-config';
import { ChevronDown, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SubagentDiffPreview } from './SubagentDiffPreview';

type SubagentFormMode = 'create' | 'edit';
type SubagentFormTab = 'basic' | 'persona' | 'skills' | 'tools';
type SkillSelectionMode = 'inherit' | 'explicit';
type ToolSelectionMode = 'inherit' | 'explicit';

interface SubagentFormValues {
  name: string;
  description: string;
  workspace: string;
  model: string;
  avatarSeed: string;
  avatarStyle: AgentAvatarStyle;
  prompt: string;
  skillConfig?: {
    revision: string;
    selection: SetAgentSkillConfigCommand['selection'];
  };
  toolConfig?: {
    revision: string;
    selection: SetAgentToolConfigCommand['selection'];
  };
}

interface SubagentFormDialogProps {
  open: boolean;
  title: string;
  mode: SubagentFormMode;
  agentId?: string | null;
  initialTab?: SubagentFormTab;
  lockBasicInfo?: boolean;
  existingAgents: Pick<SubagentSummary, 'id' | 'workspace' | 'isDefault'>[];
  modelOptions: ModelCatalogEntry[];
  modelsLoading: boolean;
  initialValues?: Partial<SubagentFormValues>;
  skillConfigView?: AgentSkillConfigView | null;
  skillConfigLoading?: boolean;
  skillConfigError?: string | null;
  toolConfigView?: AgentToolConfigView | null;
  toolConfigLoading?: boolean;
  toolConfigError?: string | null;
  draftPrompt?: string;
  generatingDraft?: boolean;
  applyingDraft?: boolean;
  includeCurrentFiles?: boolean;
  hasAnyDraft?: boolean;
  hasApprovedDraft?: boolean;
  applySucceeded?: boolean;
  draftByFile?: DraftByFile;
  draftError?: string | null;
  draftRawOutput?: string;
  previewDiffByFile?: PreviewDiffByFile;
  persistedContentByFile?: Partial<Record<SubagentTargetFile, string>>;
  onDraftPromptChange?: (prompt: string) => void;
  onIncludeCurrentFilesChange?: (includeCurrentFiles: boolean) => void;
  onGenerateDraft?: () => Promise<void>;
  onGenerateDiffPreview?: (originalByFile: Partial<Record<SubagentTargetFile, string>>) => void;
  onApplyDraft?: () => Promise<void>;
  onSubmit: (values: SubagentFormValues) => Promise<void>;
  onClose: () => void;
}

const EMPTY_VALUES: SubagentFormValues = {
  name: '',
  description: '',
  workspace: '',
  model: '',
  avatarSeed: '',
  avatarStyle: DEFAULT_AGENT_AVATAR_STYLE,
  prompt: '',
};

const TOOL_PROFILE_OPTIONS = ['full', 'coding', 'minimal', 'messaging'] as const;
const CREATE_AGENT_AVATAR_PICKER_OPTION_COUNT = 15;

type ToolEffectiveState = 'enabledByProfile' | 'disabledByProfile' | 'allowedByOverride' | 'deniedByOverride';

function formatToolProfileLabel(profileKey: string, displayName: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t(`form.toolProfiles.${profileKey}`, { defaultValue: displayName || profileKey });
}

function isEnabledByToolProfile(tool: AgentToolConfigOption, profileKey: string): boolean {
  return profileKey === 'full' || Boolean(tool.defaultProfiles?.includes(profileKey));
}

function areStringSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((item, index) => item === normalizedRight[index]);
}

function toggleStringKey(keys: readonly string[], key: string, checked: boolean): string[] {
  if (checked) {
    return keys.includes(key) ? [...keys] : [...keys, key];
  }
  return keys.filter((item) => item !== key);
}

function readOriginalByDraftFile(
  draftByFile: DraftByFile,
  persistedContentByFile: Partial<Record<SubagentTargetFile, string>>,
): Partial<Record<SubagentTargetFile, string>> {
  return Object.keys(draftByFile).reduce<Partial<Record<SubagentTargetFile, string>>>((acc, fileName) => {
    acc[fileName as SubagentTargetFile] = persistedContentByFile[fileName as SubagentTargetFile] ?? '';
    return acc;
  }, {});
}

export function SubagentFormDialog({
  open,
  title,
  mode,
  agentId,
  initialTab = 'basic',
  lockBasicInfo = false,
  existingAgents,
  modelOptions,
  modelsLoading,
  initialValues,
  skillConfigView,
  skillConfigLoading = false,
  skillConfigError = null,
  toolConfigView,
  toolConfigLoading = false,
  toolConfigError = null,
  draftPrompt = '',
  generatingDraft = false,
  applyingDraft = false,
  includeCurrentFiles = false,
  hasAnyDraft = false,
  hasApprovedDraft = false,
  applySucceeded = false,
  draftByFile = {},
  draftError = null,
  draftRawOutput = '',
  previewDiffByFile = {},
  persistedContentByFile = {},
  onDraftPromptChange,
  onIncludeCurrentFilesChange,
  onGenerateDraft,
  onGenerateDiffPreview,
  onApplyDraft,
  onSubmit,
  onClose,
}: SubagentFormDialogProps) {
  const { t } = useTranslation('subagents');
  const [values, setValues] = useState<SubagentFormValues>(EMPTY_VALUES);
  const [submitting, setSubmitting] = useState(false);
  const [avatarPickerPage, setAvatarPickerPage] = useState(0);
  const [activeTab, setActiveTab] = useState<SubagentFormTab>('basic');
  const [skillSelectionMode, setSkillSelectionMode] = useState<SkillSelectionMode>('inherit');
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([]);
  const [toolSelectionMode, setToolSelectionMode] = useState<ToolSelectionMode>('inherit');
  const [toolProfile, setToolProfile] = useState('full');
  const [allowedToolKeys, setAllowedToolKeys] = useState<string[]>([]);
  const [deniedToolKeys, setDeniedToolKeys] = useState<string[]>([]);
  const [expandedToolGroupKeys, setExpandedToolGroupKeys] = useState<string[]>([]);
  const basicInfoLocked = mode === 'edit' && lockBasicInfo;
  const resolvedModelOptions = useMemo(() => {
    const byId = new Map<string, ModelCatalogEntry>();
    for (const model of modelOptions) {
      if (model?.id) {
        byId.set(model.id, model);
      }
    }
    return Array.from(byId.values());
  }, [modelOptions]);
  const buildWorkspaceValue = useCallback(
    (name: string) => buildSubagentWorkspacePath({
      name,
      agents: existingAgents,
    }) ?? '',
    [existingAgents],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const initialName = initialValues?.name ?? '';
    const initialWorkspace = mode === 'create'
      ? buildWorkspaceValue(initialName)
      : (initialValues?.workspace ?? '');
    const initialAvatarSeed = mode === 'create'
      ? (initialValues?.avatarSeed ?? buildAvatarPickerSeeds({ agentName: initialName, page: 0, count: 1 })[0] ?? '')
      : (initialValues?.avatarSeed ?? '');
    const initialAvatarStyle = initialValues?.avatarStyle ?? DEFAULT_AGENT_AVATAR_STYLE;
    setValues({
      name: initialName,
      description: initialValues?.description ?? '',
      workspace: initialWorkspace,
      model: initialValues?.model ?? (mode === 'create' ? (modelOptions[0]?.id ?? '') : ''),
      avatarSeed: initialAvatarSeed,
      avatarStyle: initialAvatarStyle,
      prompt: initialValues?.prompt ?? '',
    });
    setActiveTab(mode === 'edit' ? initialTab : 'basic');
    setAvatarPickerPage(0);
    setSubmitting(false);
  }, [
    buildWorkspaceValue,
    initialTab,
    initialValues,
    mode,
    modelOptions,
    open,
  ]);

  useEffect(() => {
    if (!open || mode !== 'edit' || !skillConfigView || skillConfigView.agentId !== agentId) {
      return;
    }
    const usesExplicitSkills = skillConfigView.selectionMode === 'usesExplicitSkillAllowlist';
    setSkillSelectionMode(usesExplicitSkills ? 'explicit' : 'inherit');
    setSelectedSkillKeys(usesExplicitSkills ? [...skillConfigView.explicitSkillKeys] : [...skillConfigView.effectiveSkillKeys]);
  }, [agentId, mode, open, skillConfigView]);

  useEffect(() => {
    if (!open || mode !== 'edit' || !toolConfigView || toolConfigView.agentId !== agentId) {
      return;
    }
    const usesAgentPolicy = toolConfigView.selectionMode === 'usesAgentToolPolicy' && toolConfigView.toolPolicy;
    setToolSelectionMode(usesAgentPolicy ? 'explicit' : 'inherit');
    setToolProfile(usesAgentPolicy ? toolConfigView.toolPolicy?.profile ?? 'full' : 'full');
    setAllowedToolKeys(usesAgentPolicy ? [...(toolConfigView.toolPolicy?.allow ?? [])] : []);
    setDeniedToolKeys(usesAgentPolicy ? [...(toolConfigView.toolPolicy?.deny ?? [])] : []);
  }, [agentId, mode, open, toolConfigView]);

  const avatarPickerSeeds = useMemo(() => (
    buildAvatarPickerSeeds({
      agentName: values.name,
      page: avatarPickerPage,
      count: mode === 'create' ? CREATE_AGENT_AVATAR_PICKER_OPTION_COUNT : AGENT_AVATAR_PICKER_OPTION_COUNT,
    })
  ), [avatarPickerPage, mode, values.name]);

  useEffect(() => {
    if (!open || mode !== 'create') {
      return;
    }
    if (avatarPickerSeeds.includes(values.avatarSeed)) {
      return;
    }
    const nextAvatarSeed = avatarPickerSeeds[0] ?? '';
    setValues((prev) => {
      if (prev.avatarSeed === nextAvatarSeed) {
        return prev;
      }
      return {
        ...prev,
        avatarSeed: nextAvatarSeed,
      };
    });
  }, [avatarPickerSeeds, mode, open, values.avatarSeed]);

  useEffect(() => {
    if (!open || mode !== 'create') {
      return;
    }
    setValues((prev) => {
      const nextWorkspace = buildWorkspaceValue(prev.name);
      if (nextWorkspace === prev.workspace) {
        return prev;
      }
      return {
        ...prev,
        workspace: nextWorkspace,
      };
    });
  }, [buildWorkspaceValue, mode, open]);

  useEffect(() => {
    if (!open || mode !== 'create' || values.model || modelOptions.length !== 1) {
      return;
    }
    setValues((prev) => ({ ...prev, model: modelOptions[0].id }));
  }, [mode, modelOptions, open, values.model]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const current = values.model.trim();
    if (!current) {
      return;
    }
    const exists = resolvedModelOptions.some((entry) => entry.id === current);
    if (!exists) {
      setValues((prev) => ({ ...prev, model: modelOptions.length === 1 ? modelOptions[0].id : '' }));
    }
  }, [modelOptions, open, resolvedModelOptions, values.model]);

  const toolProfileOptions = useMemo(() => {
    const catalogProfiles = toolConfigView?.toolProfiles ?? [];
    const profiles = catalogProfiles.length > 0
      ? catalogProfiles
      : TOOL_PROFILE_OPTIONS.map((profile) => ({ profileKey: profile, displayName: profile }));
    return toolProfile && !profiles.some((profile) => profile.profileKey === toolProfile)
      ? [{ profileKey: toolProfile, displayName: toolProfile }, ...profiles]
      : profiles;
  }, [toolConfigView?.toolProfiles, toolProfile]);

  useEffect(() => {
    if (!open || mode !== 'edit' || activeTab !== 'tools') {
      return;
    }
    const groupKeys = toolConfigView?.toolGroups.map((group) => group.groupKey) ?? [];
    setExpandedToolGroupKeys((prev) => {
      const retainedKeys = prev.filter((groupKey) => groupKeys.includes(groupKey));
      if (retainedKeys.length > 0 || groupKeys.length === 0) {
        return retainedKeys.length === prev.length ? prev : retainedKeys;
      }
      return [groupKeys[0]];
    });
  }, [activeTab, mode, open, toolConfigView?.toolGroups]);

  if (!open) {
    return null;
  }

  const avatarStyleOptions: Array<{ value: AgentAvatarStyle; label: string }> = [
    { value: 'pixelArt', label: t('form.avatarStyles.pixelArt') },
    { value: 'bottts', label: t('form.avatarStyles.bottts') },
    { value: 'botttsNeutral', label: t('form.avatarStyles.botttsNeutral') },
  ];
  const submitLabel = mode === 'create' ? t('form.create') : t('form.save');
  const duplicateName = mode === 'create'
    ? hasSubagentNameConflict(values.name, existingAgents)
    : false;
  const missingModel = mode === 'create' && !values.model.trim();
  const hasModelOptions = resolvedModelOptions.length > 0;
  const skillConfigChanged = mode === 'edit'
    && Boolean(skillConfigView)
    && skillConfigView?.support.supportType === 'supported'
    && (
      (skillSelectionMode === 'inherit') !== (skillConfigView.selectionMode === 'inheritsDefaultSkills')
      || (skillSelectionMode === 'explicit' && !areStringSetsEqual(selectedSkillKeys, skillConfigView.explicitSkillKeys))
    );
  const toolConfigChanged = mode === 'edit'
    && Boolean(toolConfigView)
    && toolConfigView?.support.supportType === 'supported'
    && (
      (toolSelectionMode === 'inherit') !== (toolConfigView.selectionMode === 'inheritsDefaultTools')
      || (toolSelectionMode === 'explicit' && (
        toolProfile !== (toolConfigView.toolPolicy?.profile ?? 'full')
        || !areStringSetsEqual(allowedToolKeys, toolConfigView.toolPolicy?.allow ?? [])
        || !areStringSetsEqual(deniedToolKeys, toolConfigView.toolPolicy?.deny ?? [])
      ))
    );
  const canSubmit = !submitting
    && !!values.name.trim()
    && (basicInfoLocked || !!values.workspace.trim())
    && !duplicateName
    && !missingModel
    && (mode === 'edit' || hasModelOptions)
    && !modelsLoading;

  const buildSkillConfigValue = (): SubagentFormValues['skillConfig'] => {
    if (!skillConfigChanged || !skillConfigView) {
      return undefined;
    }
    return {
      revision: skillConfigView.revision,
      selection: skillSelectionMode === 'inherit'
        ? { selectionType: 'inheritDefaultSkills' }
        : { selectionType: 'setExplicitSkillAllowlist', skillKeys: selectedSkillKeys },
    };
  };

  const buildToolConfigValue = (): SubagentFormValues['toolConfig'] => {
    if (!toolConfigChanged || !toolConfigView) {
      return undefined;
    }
    return {
      revision: toolConfigView.revision,
      selection: toolSelectionMode === 'inherit'
        ? { selectionType: 'inheritDefaultTools' }
        : {
          selectionType: 'setAgentToolPolicy',
          profile: toolProfile,
          allow: allowedToolKeys,
          deny: deniedToolKeys,
        },
    };
  };

  const renderModelAndWorkspaceFields = () => (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{t('form.aiConfig')}</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="subagent-workspace">{t('form.workspace')}</Label>
          <Input
            id="subagent-workspace"
            value={values.workspace}
            readOnly
            className="text-muted-foreground"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="subagent-model">{t('form.model')}</Label>
          <Select
            id="subagent-model"
            value={values.model}
            disabled={modelsLoading || (mode === 'create' && !hasModelOptions)}
            onChange={(event) => setValues((prev) => ({ ...prev, model: event.target.value }))}
          >
            {mode === 'edit' ? (
              <option value="">{t('form.useDefaultModel')}</option>
            ) : (
              <option value="">
                {modelsLoading
                  ? t('form.modelsLoading')
                  : t('form.selectModel')}
              </option>
            )}
            {resolvedModelOptions.map((model) => (
              <option key={model.id} value={model.id}>
                {model.displayLabel}
              </option>
            ))}
          </Select>
          {!modelsLoading && !hasModelOptions && (
            <p className="text-xs text-destructive">{t('form.modelUnavailable')}</p>
          )}
        </div>
      </div>
    </section>
  );

  const renderBasicInfo = () => (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">{t('form.basicInfo')}</h3>
        <div className={cn('grid gap-4 md:grid-cols-1')}>
          {mode === 'create' ? (
            <div className="grid gap-4 xl:grid-cols-[320px,minmax(0,1fr)] xl:items-start">
              <div className="space-y-2">
                <Label>{t('form.avatar')}</Label>
                <div className="rounded-lg border bg-muted/20 p-2.5">
                  <div className="grid grid-cols-[minmax(0,1fr),auto] items-center gap-2">
                    <div className="grid min-w-0 grid-cols-3 gap-1 rounded-full border border-border/70 bg-background/70 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]">
                      {avatarStyleOptions.map((option) => (
                        <Button
                          key={option.value}
                          type="button"
                          variant="ghost"
                          aria-label={`avatar-style-${option.value}`}
                          className={cn(
                            'h-8 min-w-0 rounded-full px-2 text-[10px] leading-none shadow-none',
                            values.avatarStyle === option.value
                              ? 'border border-border bg-card text-foreground shadow-sm hover:bg-card'
                              : 'border border-transparent bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                          )}
                          onClick={() => setValues((prev) => ({ ...prev, avatarStyle: option.value }))}
                        >
                          <span className="whitespace-nowrap">{option.label}</span>
                        </Button>
                      ))}
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      aria-label={t('form.avatarRefresh')}
                      title={t('form.avatarRefresh')}
                      className="h-8 w-8 rounded-full border-border/70 bg-background/70 shadow-none hover:bg-muted/70"
                      onClick={() => setAvatarPickerPage((prev) => prev + 1)}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-2">
                    {avatarPickerSeeds.map((seed) => {
                      const selected = values.avatarSeed === seed;
                      return (
                        <button
                          key={seed}
                          type="button"
                          aria-label={`pick-avatar-${seed}`}
                          onClick={() => setValues((prev) => ({ ...prev, avatarSeed: seed }))}
                          className={cn(
                            'flex h-14 items-center justify-center rounded-xl border bg-background p-2 transition-colors',
                            selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
                          )}
                        >
                          <AgentAvatar
                            avatarSeed={seed}
                            avatarStyle={values.avatarStyle}
                            agentName={values.name || 'Agent'}
                            className="h-10 w-10"
                            alt={`Avatar option ${seed}`}
                          />
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="subagent-name">{t('form.name')}</Label>
                  <Input
                    id="subagent-name"
                    value={values.name}
                    readOnly={basicInfoLocked}
                    className={basicInfoLocked ? 'text-muted-foreground' : undefined}
                    onChange={(event) => {
                      if (basicInfoLocked) {
                        return;
                      }
                      const nextName = event.target.value;
                      setValues((prev) => ({
                        ...prev,
                        name: nextName,
                        workspace: buildWorkspaceValue(nextName),
                      }));
                    }}
                  />
                  {duplicateName && (
                    <p className="text-xs text-destructive">{t('form.nameDuplicate')}</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="subagent-description">{t('form.description')}</Label>
                  <Textarea
                    id="subagent-description"
                    rows={2}
                    className="resize-none"
                    value={values.description}
                    placeholder={t('form.descriptionPlaceholder')}
                    onChange={(event) => setValues((prev) => ({ ...prev, description: event.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="subagent-initial-prompt">{t('form.initialPrompt')}</Label>
                  <Textarea
                    id="subagent-initial-prompt"
                    rows={6}
                    className="min-h-[180px] resize-none"
                    value={values.prompt}
                    placeholder={t('form.initialPromptPlaceholder')}
                    onChange={(event) => setValues((prev) => ({ ...prev, prompt: event.target.value }))}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[320px,minmax(0,1fr)]">
              <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
                <div className="flex items-center justify-between gap-3">
                  <Label>{t('form.avatar')}</Label>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    aria-label={t('form.avatarRefresh')}
                    title={t('form.avatarRefresh')}
                    disabled={basicInfoLocked}
                    className="h-8 w-8 rounded-full border-border/70 bg-background/70 shadow-none hover:bg-muted/70"
                    onClick={() => setAvatarPickerPage((prev) => prev + 1)}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex justify-center py-2">
                  <AgentAvatar
                    avatarSeed={values.avatarSeed}
                    avatarStyle={values.avatarStyle}
                    agentId={agentId ?? undefined}
                    agentName={values.name || agentId || 'Agent'}
                    className="h-24 w-24 border border-border/70 bg-background shadow-sm"
                    alt={`${values.name || agentId || 'Agent'} avatar`}
                  />
                </div>
                <div className="grid min-w-0 grid-cols-3 gap-1 rounded-full border border-border/70 bg-background/70 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]">
                  {avatarStyleOptions.map((option) => (
                    <Button
                      key={option.value}
                      type="button"
                      variant="ghost"
                      aria-label={`avatar-style-${option.value}`}
                      disabled={basicInfoLocked}
                      className={cn(
                        'h-8 min-w-0 rounded-full px-2 text-[10px] leading-none shadow-none',
                        values.avatarStyle === option.value
                          ? 'border border-border bg-card text-foreground shadow-sm hover:bg-card'
                          : 'border border-transparent bg-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground',
                      )}
                      onClick={() => setValues((prev) => ({ ...prev, avatarStyle: option.value }))}
                    >
                      <span className="whitespace-nowrap">{option.label}</span>
                    </Button>
                  ))}
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {avatarPickerSeeds.map((seed) => {
                    const selected = values.avatarSeed === seed;
                    return (
                      <button
                        key={seed}
                        type="button"
                        aria-label={`pick-avatar-${seed}`}
                        disabled={basicInfoLocked}
                        onClick={() => setValues((prev) => ({ ...prev, avatarSeed: seed }))}
                        className={cn(
                          'flex h-14 items-center justify-center rounded-xl border bg-background p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                          selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
                        )}
                      >
                        <AgentAvatar
                          avatarSeed={seed}
                          avatarStyle={values.avatarStyle}
                          agentName={values.name || agentId || 'Agent'}
                          className="h-10 w-10"
                          alt={`Avatar option ${seed}`}
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-6">
                <div className="space-y-1">
                  <Label htmlFor="subagent-name">{t('form.name')}</Label>
                  <Input
                    id="subagent-name"
                    value={values.name}
                    readOnly={basicInfoLocked}
                    className={basicInfoLocked ? 'text-muted-foreground' : undefined}
                    onChange={(event) => {
                      if (basicInfoLocked) {
                        return;
                      }
                      const nextName = event.target.value;
                      setValues((prev) => ({
                        ...prev,
                        name: nextName,
                      }));
                    }}
                  />
                  {duplicateName && (
                    <p className="text-xs text-destructive">{t('form.nameDuplicate')}</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="subagent-description">{t('form.description')}</Label>
                  <Textarea
                    id="subagent-description"
                    rows={3}
                    value={values.description}
                    readOnly={basicInfoLocked}
                    className={cn('resize-none', basicInfoLocked && 'text-muted-foreground')}
                    placeholder={t('form.descriptionPlaceholder')}
                    onChange={(event) => setValues((prev) => ({ ...prev, description: event.target.value }))}
                  />
                </div>
                {renderModelAndWorkspaceFields()}
              </div>
            </div>
          )}
        </div>
      </section>
      {mode === 'create' ? renderModelAndWorkspaceFields() : null}
    </div>
  );

  const renderPersonaConfig = () => (
    <div className="flex min-h-[420px] flex-col gap-3">
      {!agentId ? (
        <p className="text-sm text-muted-foreground">{t('manage.noAgentSelected')}</p>
      ) : (
        <>
          <div className="space-y-1">
            <Label htmlFor="subagent-draft-prompt">{t('manage.promptLabel')}</Label>
            <Textarea
              id="subagent-draft-prompt"
              value={draftPrompt}
              rows={5}
              placeholder={t('manage.promptPlaceholder')}
              onChange={(event) => onDraftPromptChange?.(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!onGenerateDraft || !draftPrompt.trim() || generatingDraft || applyingDraft}
              onClick={() => {
                void onGenerateDraft?.();
              }}
            >
              {generatingDraft ? t('manage.generatingDraft') : t('manage.generateDraft')}
            </Button>
            <label className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs text-muted-foreground">
              <Switch
                checked={includeCurrentFiles}
                disabled={generatingDraft || applyingDraft}
                onCheckedChange={(nextIncludeCurrentFiles) => onIncludeCurrentFilesChange?.(nextIncludeCurrentFiles)}
              />
              <span>{t('manage.includeCurrentFilesLabel')}</span>
            </label>
            {hasAnyDraft && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onGenerateDiffPreview?.(readOriginalByDraftFile(draftByFile, persistedContentByFile))}
              >
                {t('manage.generateDiffPreview')}
              </Button>
            )}
            {hasApprovedDraft && (
              <Button
                type="button"
                size="sm"
                disabled={applyingDraft}
                onClick={() => {
                  void onApplyDraft?.();
                }}
              >
                {applyingDraft ? t('manage.applyingDraft') : t('manage.confirmApplyDraft')}
              </Button>
            )}
          </div>

          {applySucceeded && !draftError && (
            <p className="text-xs text-green-600">{t('manage.applyDraftSuccess')}</p>
          )}
          {draftError && (
            <p className="text-xs text-destructive">{draftError}</p>
          )}
          {draftError && draftRawOutput.trim() && (
            <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2">
              <p className="text-[11px] font-medium text-destructive">{t('manage.rawOutputTitle')}</p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                {draftRawOutput}
              </pre>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-muted/15 p-3">
            <SubagentDiffPreview
              previewDiffByFile={previewDiffByFile}
              persistedContentByFile={persistedContentByFile}
            />
          </div>
        </>
      )}
    </div>
  );

  const renderSkillConfig = () => {
    const skillOptions = skillConfigView?.options ?? [];
    const unsupportedReason = skillConfigView?.support.supportType === 'unsupported'
      ? skillConfigView.support.reason
      : null;
    return (
      <section className="space-y-3 rounded-xl border bg-background p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-foreground">{t('form.skillConfig')}</h3>
          <label className="inline-flex shrink-0 items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground">
            <Switch
              aria-label={t('form.useAllSkills')}
              checked={skillSelectionMode === 'inherit'}
              disabled={skillConfigLoading || Boolean(unsupportedReason)}
              onCheckedChange={(checked) => setSkillSelectionMode(checked ? 'inherit' : 'explicit')}
            />
            <span>{t('form.useAllSkills')}</span>
          </label>
        </div>
        {skillConfigLoading ? (
          <p className="text-sm text-muted-foreground">{t('form.skillsLoading')}</p>
        ) : skillConfigError ? (
          <p className="text-sm text-destructive">{skillConfigError}</p>
        ) : unsupportedReason ? (
          <p className="text-sm text-muted-foreground">{t(`form.capabilities.unsupported.${unsupportedReason}`)}</p>
        ) : skillOptions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('form.noSkillOptions')}</p>
        ) : (
          <div className={cn('grid gap-2 md:grid-cols-2', skillSelectionMode === 'inherit' && 'opacity-60')}>
            {skillOptions.map((skill) => {
              const checked = selectedSkillKeys.includes(skill.skillKey);
              const disabled = skillSelectionMode === 'inherit' || (skill.selectable === false && !checked);
              return (
                <div key={skill.skillKey} className={cn('rounded-xl border bg-card p-3', checked && 'border-emerald-500/40 bg-emerald-500/8')}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{skill.displayName}</p>
                      {skill.description ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{skill.description}</p> : null}
                    </div>
                    <Switch
                      aria-label={`${t('form.capabilities.toggleSkill')} ${skill.displayName}`}
                      checked={checked}
                      disabled={disabled}
                      onCheckedChange={(nextChecked) => setSelectedSkillKeys((prev) => toggleStringKey(prev, skill.skillKey, nextChecked))}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  };

  const renderToolConfig = () => {
    const toolGroups = toolConfigView?.toolGroups ?? [];
    const toolOptions = toolConfigView?.toolOptions ?? [];
    const allTools = toolGroups.flatMap((group) => group.toolOptions);
    const unsupportedReason = toolConfigView?.support.supportType === 'unsupported'
      ? toolConfigView.support.reason
      : null;
    const controlsDisabled = toolSelectionMode === 'inherit';
    const findGroupPolicyOption = (groupKey: string) => toolOptions.find((option) => option.optionType === 'group' && option.groupKey === groupKey);
    const readToolPolicySetting = (toolKey: string): 'default' | 'allow' | 'deny' => {
      if (deniedToolKeys.includes(toolKey)) {
        return 'deny';
      }
      return allowedToolKeys.includes(toolKey) ? 'allow' : 'default';
    };
    const setToolPolicySetting = (toolKey: string, nextSetting: 'default' | 'allow' | 'deny') => {
      setAllowedToolKeys((prev) => nextSetting === 'allow' ? toggleStringKey(prev, toolKey, true) : toggleStringKey(prev, toolKey, false));
      setDeniedToolKeys((prev) => nextSetting === 'deny' ? toggleStringKey(prev, toolKey, true) : toggleStringKey(prev, toolKey, false));
    };
    const readToolEffectiveState = (tool: AgentToolConfigOption, groupPolicyOption?: AgentToolConfigOption): ToolEffectiveState => {
      const toolPolicySetting = readToolPolicySetting(tool.toolKey);
      if (toolPolicySetting === 'deny') {
        return 'deniedByOverride';
      }
      if (toolPolicySetting === 'allow') {
        return 'allowedByOverride';
      }
      if (groupPolicyOption) {
        const groupPolicySetting = readToolPolicySetting(groupPolicyOption.toolKey);
        if (groupPolicySetting === 'deny') {
          return 'deniedByOverride';
        }
        if (groupPolicySetting === 'allow') {
          return 'allowedByOverride';
        }
      }
      return isEnabledByToolProfile(tool, toolProfile) ? 'enabledByProfile' : 'disabledByProfile';
    };
    const isToolEffectivelyEnabled = (state: ToolEffectiveState) => state === 'enabledByProfile' || state === 'allowedByOverride';
    const effectiveEnabledCount = toolGroups.reduce((count, group) => {
      const groupPolicyOption = findGroupPolicyOption(group.groupKey);
      return count + group.toolOptions.filter((tool) => isToolEffectivelyEnabled(readToolEffectiveState(tool, groupPolicyOption))).length;
    }, 0);
    const profileEnabledCount = allTools.filter((tool) => isEnabledByToolProfile(tool, toolProfile)).length;
    const explicitRuleCount = allowedToolKeys.length + deniedToolKeys.length;
    const selectedProfileLabel = toolProfileOptions.find((profile) => profile.profileKey === toolProfile)?.displayName ?? toolProfile;
    const shouldShowToolSummary = toolGroups.length > 0 && !toolConfigLoading && !toolConfigError && !unsupportedReason;
    const renderToolStateBadge = (state: ToolEffectiveState) => (
      <span className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        state === 'enabledByProfile' && 'bg-emerald-500/10 text-emerald-700',
        state === 'allowedByOverride' && 'bg-blue-500/10 text-blue-700',
        state === 'deniedByOverride' && 'bg-rose-500/10 text-rose-700',
        state === 'disabledByProfile' && 'bg-muted text-muted-foreground',
      )}
      >
        {t(`form.capabilities.toolStates.${state}`)}
      </span>
    );
    const renderPolicyControl = (tool: AgentToolConfigOption) => {
      const currentSetting = readToolPolicySetting(tool.toolKey);
      const policyButtonClass = (setting: 'default' | 'allow' | 'deny') => cn(
        'h-6 rounded-full px-2 text-[11px] shadow-none',
        currentSetting === setting
          ? 'bg-card text-foreground shadow-sm hover:bg-card'
          : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
      );
      return (
        <div className="inline-flex items-center rounded-full border bg-muted/40 p-0.5">
          <Button
            type="button"
            variant="ghost"
            disabled={controlsDisabled}
            className={policyButtonClass('default')}
            onClick={() => setToolPolicySetting(tool.toolKey, 'default')}
          >
            {t('form.capabilities.policyDefault')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={controlsDisabled}
            className={policyButtonClass('allow')}
            onClick={() => setToolPolicySetting(tool.toolKey, 'allow')}
          >
            {t('form.capabilities.allow')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={controlsDisabled}
            className={policyButtonClass('deny')}
            onClick={() => setToolPolicySetting(tool.toolKey, 'deny')}
          >
            {t('form.capabilities.deny')}
          </Button>
        </div>
      );
    };
    return (
      <section className="flex h-full min-h-0 flex-col rounded-xl border bg-background p-3">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{t('form.toolConfig')}</h3>
            {shouldShowToolSummary ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('form.capabilities.toolProfileSummary', {
                  profile: formatToolProfileLabel(toolProfile, selectedProfileLabel, t),
                  enabled: effectiveEnabledCount,
                  total: allTools.length,
                  defaultEnabled: profileEnabledCount,
                  overrides: explicitRuleCount,
                })}
              </p>
            ) : null}
          </div>
          <label className="inline-flex shrink-0 items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground">
            <Switch
              aria-label={t('form.useAllTools')}
              checked={toolSelectionMode === 'inherit'}
              disabled={toolConfigLoading || Boolean(unsupportedReason)}
              onCheckedChange={(checked) => setToolSelectionMode(checked ? 'inherit' : 'explicit')}
            />
            <span>{t('form.useAllTools')}</span>
          </label>
        </div>
        {toolConfigLoading ? (
          <p className="text-sm text-muted-foreground">{t('form.toolsLoading')}</p>
        ) : toolConfigError ? (
          <p className="text-sm text-destructive">{toolConfigError}</p>
        ) : unsupportedReason ? (
          <p className="text-sm text-muted-foreground">{t(`form.capabilities.unsupported.${unsupportedReason}`)}</p>
        ) : toolGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('form.noToolOptions')}</p>
        ) : (
          <div className={cn('mt-3 flex min-h-0 flex-1 flex-col gap-3', controlsDisabled && 'opacity-65')}>
            <div className="grid shrink-0 gap-3 rounded-xl border bg-muted/20 p-3 md:grid-cols-[minmax(220px,320px),minmax(0,1fr)] md:items-end">
              <div className="space-y-1">
                <Label htmlFor="subagent-tool-profile">{t('form.toolProfile')}</Label>
                <Select
                  id="subagent-tool-profile"
                  value={toolProfile}
                  disabled={controlsDisabled}
                  onChange={(event) => setToolProfile(event.target.value)}
                >
                  {toolProfileOptions.map((profile) => (
                    <option key={profile.profileKey} value={profile.profileKey}>
                      {formatToolProfileLabel(profile.profileKey, profile.displayName, t)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">{t('form.capabilities.profileDefault')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{profileEnabledCount}/{allTools.length}</p>
                </div>
                <div className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">{t('form.capabilities.effectiveTools')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{effectiveEnabledCount}/{allTools.length}</p>
                </div>
                <div className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">{t('form.capabilities.explicitRules')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{explicitRuleCount}</p>
                </div>
              </div>
              {controlsDisabled ? (
                <p className="text-xs text-muted-foreground md:col-span-2">{t('form.capabilities.inheritToolsHint')}</p>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {toolGroups.map((group) => {
                const groupPolicyOption = findGroupPolicyOption(group.groupKey);
                const expanded = expandedToolGroupKeys.includes(group.groupKey);
                const enabledInGroupCount = group.toolOptions.filter((tool) => isToolEffectivelyEnabled(readToolEffectiveState(tool, groupPolicyOption))).length;
                const groupRuleCount = [
                  groupPolicyOption && readToolPolicySetting(groupPolicyOption.toolKey) !== 'default',
                  ...group.toolOptions.map((tool) => readToolPolicySetting(tool.toolKey) !== 'default'),
                ].filter(Boolean).length;
                return (
                  <div key={group.groupKey} className="overflow-hidden rounded-xl border bg-card">
                    <div className="grid grid-cols-[minmax(0,1fr),auto] items-center gap-3 px-3 py-2">
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-3 text-left"
                        aria-expanded={expanded}
                        onClick={() => setExpandedToolGroupKeys((prev) => toggleStringKey(prev, group.groupKey, !expanded))}
                      >
                        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded ? 'rotate-0' : '-rotate-90')} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">{group.displayName}</span>
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                              {group.source === 'plugin'
                                ? t('form.capabilities.pluginBadge')
                                : t('form.capabilities.coreBadge')}
                            </span>
                            {group.pluginId ? <span className="text-[11px] text-muted-foreground">{group.pluginId}</span> : null}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {t('form.capabilities.groupSummary', {
                              enabled: enabledInGroupCount,
                              total: group.toolOptions.length,
                              rules: groupRuleCount,
                            })}
                          </span>
                        </span>
                      </button>
                      {groupPolicyOption ? renderPolicyControl(groupPolicyOption) : null}
                    </div>
                    {expanded ? (
                      <div className="divide-y border-t bg-background/60">
                        {group.toolOptions.map((tool) => {
                          const effectiveState = readToolEffectiveState(tool, groupPolicyOption);
                          return (
                            <div key={tool.toolKey} className="grid gap-3 px-3 py-2.5 md:grid-cols-[minmax(0,1fr),auto] md:items-center">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  {renderToolStateBadge(effectiveState)}
                                  <p className="truncate text-sm font-medium text-foreground">{tool.displayName}</p>
                                  <span className="truncate text-xs text-muted-foreground">{tool.toolKey}</span>
                                </div>
                                {tool.description ? <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{tool.description}</p> : null}
                                {tool.source === 'plugin' && tool.pluginId ? (
                                  <p className="mt-1 text-[11px] text-muted-foreground">{tool.pluginId}</p>
                                ) : null}
                              </div>
                              <div className="flex justify-start md:justify-end">
                                {renderPolicyControl(tool)}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    );
  };

  const formContent = mode === 'edit' ? (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as SubagentFormTab)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList className="w-full shrink-0 justify-start">
        <TabsTrigger value="basic" onClick={() => setActiveTab('basic')}>{t('form.tabs.basic')}</TabsTrigger>
        <TabsTrigger value="persona" onClick={() => setActiveTab('persona')}>{t('form.tabs.persona')}</TabsTrigger>
        <TabsTrigger value="skills" onClick={() => setActiveTab('skills')}>{t('form.tabs.skills')}</TabsTrigger>
        <TabsTrigger value="tools" onClick={() => setActiveTab('tools')}>{t('form.tabs.tools')}</TabsTrigger>
      </TabsList>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <TabsContent value="basic" className="min-h-0 flex-1 overflow-y-auto pr-1">{renderBasicInfo()}</TabsContent>
        <TabsContent value="persona" className="min-h-0 flex-1 overflow-y-auto pr-1">{renderPersonaConfig()}</TabsContent>
        <TabsContent value="skills" className="min-h-0 flex-1 overflow-y-auto pr-1">{renderSkillConfig()}</TabsContent>
        <TabsContent value="tools" className="min-h-0 flex-1 overflow-hidden">{renderToolConfig()}</TabsContent>
      </div>
    </Tabs>
  ) : (
    <div className="min-h-0 flex-1 overflow-y-auto pr-1">
      {renderBasicInfo()}
    </div>
  );

  const submitForm = async () => {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    try {
      const skillConfig = buildSkillConfigValue();
      const toolConfig = buildToolConfigValue();
      await onSubmit({
        name: values.name.trim(),
        description: values.description.trim(),
        workspace: values.workspace.trim(),
        model: values.model.trim(),
        avatarSeed: values.avatarSeed.trim(),
        avatarStyle: values.avatarStyle,
        prompt: values.prompt.trim(),
        ...(skillConfig ? { skillConfig } : {}),
        ...(toolConfig ? { toolConfig } : {}),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <section
        role="dialog"
        aria-label={title}
        className={cn(
          'flex min-h-0 w-full max-w-5xl flex-col overflow-hidden rounded-xl border bg-background p-6 shadow-xl',
          mode === 'edit' ? 'h-[94vh]' : 'max-h-[94vh]',
        )}
      >
        <header className="flex shrink-0 items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button variant="ghost" size="icon" aria-label={t('close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="mt-5 flex min-h-0 flex-1 flex-col gap-6">
          {formContent}

          <div className="flex shrink-0 justify-end gap-2 border-t pt-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              {t('form.cancel')}
            </Button>
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={() => {
                void submitForm();
              }}
            >
              {submitLabel}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}

export default SubagentFormDialog;
