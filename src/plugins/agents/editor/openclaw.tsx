import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { resolveModelCatalogEntry, resolveModelRuntimeReference } from '@/plugins/providers/services/provider-models';
import { cn } from '@/lib/utils';
import { formatWorkspacePathForDisplay } from '@/plugins/files/types';
import { buildSubagentWorkspacePath } from '../domain/workspace';
import type { AgentEditorOwnerProps, AgentEditorUpdate } from '../extensions';
import type { AgentToolConfigOption } from '../stores/agent-tool-config';
import type { ModelCatalogEntry } from '@/types/subagent';
import { areStringSetsEqual, toggleStringKey } from './shared';

type SelectionMode = 'inherit' | 'explicit';
type ToolEffectiveState = 'enabledByProfile' | 'disabledByProfile' | 'allowedByOverride' | 'deniedByOverride' | 'deniedByGlobalPolicy';

const TOOL_PROFILE_OPTIONS = ['full', 'coding', 'minimal', 'messaging'] as const;

function formatToolProfileLabel(profileKey: string, displayName: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t(`form.toolProfiles.${profileKey}`, { defaultValue: displayName || profileKey });
}

function isEnabledByToolProfile(tool: AgentToolConfigOption, profileKey: string): boolean {
  return profileKey === 'full' || Boolean(tool.defaultProfiles?.includes(profileKey));
}

export default function OpenClawAgentEditor({
  open,
  mode,
  agentId,
  name,
  activeTab,
  initialValues,
  initialSnapshot,
  existingAgents,
  modelOptions,
  modelsLoading,
  skillConfigView,
  skillConfigLoading = false,
  skillConfigError = null,
  toolConfigView,
  toolConfigLoading = false,
  toolConfigError = null,
  children,
}: AgentEditorOwnerProps) {
  const { t } = useTranslation('subagents');
  const [workspace, setWorkspace] = useState(() => mode === 'create'
    ? buildSubagentWorkspacePath({ name: initialSnapshot.initialValues?.name ?? '', agents: initialSnapshot.existingAgents }) ?? ''
    : (initialSnapshot.initialValues?.workspace ?? ''));
  const [model, setModel] = useState(() => {
    const initialModel = initialSnapshot.initialValues?.model ?? '';
    return resolveModelCatalogEntry(initialSnapshot.modelOptions, initialModel)?.id
      ?? (initialModel || (mode === 'create' ? (initialSnapshot.modelOptions[0]?.id ?? '') : ''));
  });
  const [skillSelectionMode, setSkillSelectionMode] = useState<SelectionMode>('inherit');
  const [selectedSkillKeys, setSelectedSkillKeys] = useState<string[]>([]);
  const [toolSelectionMode, setToolSelectionMode] = useState<SelectionMode>('inherit');
  const [toolProfile, setToolProfile] = useState('full');
  const [allowedToolKeys, setAllowedToolKeys] = useState<string[]>([]);
  const [deniedToolKeys, setDeniedToolKeys] = useState<string[]>([]);
  const [expandedToolGroupKeys, setExpandedToolGroupKeys] = useState<string[]>([]);
  const basicInfoLocked = mode === 'edit' && Boolean(initialValues?.isDefault);
  const resolvedModelOptions = useMemo(() => {
    const byId = new Map<string, ModelCatalogEntry>();
    for (const option of modelOptions) {
      if (option?.id) {
        byId.set(option.id, option);
      }
    }
    return Array.from(byId.values());
  }, [modelOptions]);
  const buildWorkspaceValue = useCallback(
    (agentName: string) => buildSubagentWorkspacePath({
      name: agentName,
      agents: existingAgents,
    }) ?? '',
    [existingAgents],
  );

  const [skillSource, setSkillSource] = useState<Pick<AgentEditorOwnerProps, 'agentId' | 'mode' | 'open' | 'skillConfigView'> | null>(null);
  if (!skillSource || skillSource.agentId !== agentId || skillSource.mode !== mode || skillSource.open !== open || skillSource.skillConfigView !== skillConfigView) {
    setSkillSource({ agentId, mode, open, skillConfigView });
    if (open && mode === 'edit' && skillConfigView && skillConfigView.agentId === agentId) {
      const usesExplicitSkills = skillConfigView.selectionMode === 'usesExplicitSkillAllowlist';
      setSkillSelectionMode(usesExplicitSkills ? 'explicit' : 'inherit');
      setSelectedSkillKeys(usesExplicitSkills ? [...skillConfigView.explicitSkillKeys] : [...skillConfigView.effectiveSkillKeys]);
    }
  }

  const [toolSource, setToolSource] = useState<Pick<AgentEditorOwnerProps, 'agentId' | 'mode' | 'open' | 'toolConfigView'> | null>(null);
  if (!toolSource || toolSource.agentId !== agentId || toolSource.mode !== mode || toolSource.open !== open || toolSource.toolConfigView !== toolConfigView) {
    setToolSource({ agentId, mode, open, toolConfigView });
    if (open && mode === 'edit' && toolConfigView && toolConfigView.agentId === agentId) {
      const usesAgentPolicy = toolConfigView.selectionMode === 'usesAgentToolPolicy' && toolConfigView.toolPolicy;
      setToolSelectionMode(usesAgentPolicy ? 'explicit' : 'inherit');
      setToolProfile(usesAgentPolicy ? toolConfigView.toolPolicy?.profile ?? 'full' : 'full');
      setAllowedToolKeys(usesAgentPolicy ? [...(toolConfigView.toolPolicy?.allow ?? [])] : []);
      setDeniedToolKeys(usesAgentPolicy ? [...(toolConfigView.toolPolicy?.deny ?? [])] : []);
    }
  }

  const [workspaceSource, setWorkspaceSource] = useState<Pick<AgentEditorOwnerProps, 'existingAgents' | 'mode' | 'open'> | null>(null);
  if (!workspaceSource || workspaceSource.existingAgents !== existingAgents || workspaceSource.mode !== mode || workspaceSource.open !== open) {
    setWorkspaceSource({ existingAgents, mode, open });
    if (open && mode === 'create') {
      const nextWorkspace = buildWorkspaceValue(name);
      if (nextWorkspace !== workspace) setWorkspace(nextWorkspace);
    }
  }

  const [modelSource, setModelSource] = useState<(Pick<AgentEditorOwnerProps, 'mode' | 'open' | 'modelOptions'> & { model: string }) | null>(null);
  if (!modelSource || modelSource.mode !== mode || modelSource.open !== open || modelSource.modelOptions !== modelOptions || modelSource.model !== model) {
    setModelSource({ mode, open, modelOptions, model });
    if (open) {
      if (mode === 'create' && !model && modelOptions.length === 1) {
        setModel(modelOptions[0].id);
      } else {
        const current = model.trim();
        if (current) {
          const resolvedModel = resolveModelCatalogEntry(resolvedModelOptions, current);
          if (resolvedModel?.id && resolvedModel.id !== current) {
            setModel(resolvedModel.id);
          } else if (!resolvedModel && mode === 'create') {
            setModel(modelOptions.length === 1 ? modelOptions[0].id : '');
          }
        }
      }
    }
  }

  const toolProfileOptions = useMemo(() => {
    const catalogProfiles = toolConfigView?.toolProfiles ?? [];
    const profiles = catalogProfiles.length > 0
      ? catalogProfiles
      : TOOL_PROFILE_OPTIONS.map((profile) => ({ profileKey: profile, displayName: profile }));
    return toolProfile && !profiles.some((profile) => profile.profileKey === toolProfile)
      ? [{ profileKey: toolProfile, displayName: toolProfile }, ...profiles]
      : profiles;
  }, [toolConfigView?.toolProfiles, toolProfile]);

  const toolGroups = toolConfigView?.toolGroups;
  const [toolGroupSource, setToolGroupSource] = useState<(Pick<AgentEditorOwnerProps, 'activeTab' | 'mode' | 'open'> & { toolGroups: typeof toolGroups }) | null>(null);
  if (!toolGroupSource || toolGroupSource.activeTab !== activeTab || toolGroupSource.mode !== mode || toolGroupSource.open !== open || toolGroupSource.toolGroups !== toolGroups) {
    setToolGroupSource({ activeTab, mode, open, toolGroups });
    if (open && mode === 'edit' && activeTab === 'tools') {
      const groupKeys = toolGroups?.map((group) => group.groupKey) ?? [];
      const retainedKeys = expandedToolGroupKeys.filter((groupKey) => groupKeys.includes(groupKey));
      if (retainedKeys.length > 0 || groupKeys.length === 0) {
        if (retainedKeys.length !== expandedToolGroupKeys.length) setExpandedToolGroupKeys(retainedKeys);
      } else {
        setExpandedToolGroupKeys([groupKeys[0]]);
      }
    }
  }

  const missingModel = mode === 'create' && !model.trim();
  const hasModelOptions = resolvedModelOptions.length > 0;
  const currentModel = model.trim();
  const showCurrentModelOption = mode === 'edit'
    && Boolean(currentModel)
    && !resolveModelCatalogEntry(resolvedModelOptions, currentModel);
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

  const basicFields = (
    <>
      <div className="space-y-1">
        <Label htmlFor="subagent-workspace">{t('form.workspace')}</Label>
        <Input id="subagent-workspace" value={formatWorkspacePathForDisplay(workspace)} readOnly className="text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="subagent-model">{t('form.model')}</Label>
        <Select
          id="subagent-model"
          value={model}
          disabled={modelsLoading || (mode === 'create' && !hasModelOptions)}
          onChange={(event) => setModel(event.target.value)}
        >
          {mode === 'edit' ? (
            <option value="">{t('form.useDefaultModel')}</option>
          ) : (
            <option value="">{modelsLoading ? t('form.modelsLoading') : t('form.selectModel')}</option>
          )}
          {showCurrentModelOption ? <option value={currentModel}>{currentModel}</option> : null}
          {resolvedModelOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.displayLabel}</option>
          ))}
        </Select>
        {!modelsLoading && !hasModelOptions && <p className="text-xs text-destructive">{t('form.modelUnavailable')}</p>}
      </div>
    </>
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
              disabled={!skillConfigView || skillConfigLoading || Boolean(unsupportedReason)}
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
                      onCheckedChange={(nextChecked) => setSelectedSkillKeys((previous) => toggleStringKey(previous, skill.skillKey, nextChecked))}
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
      setAllowedToolKeys((previous) => nextSetting === 'allow' ? toggleStringKey(previous, toolKey, true) : toggleStringKey(previous, toolKey, false));
      setDeniedToolKeys((previous) => nextSetting === 'deny' ? toggleStringKey(previous, toolKey, true) : toggleStringKey(previous, toolKey, false));
    };
    const readToolEffectiveState = (tool: AgentToolConfigOption, groupPolicyOption?: AgentToolConfigOption): ToolEffectiveState => {
      if (tool.deniedByGlobalPolicy || groupPolicyOption?.deniedByGlobalPolicy) {
        return 'deniedByGlobalPolicy';
      }
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
    const globalDenyCount = allTools.filter((tool) => tool.deniedByGlobalPolicy).length;
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
        state === 'deniedByGlobalPolicy' && 'bg-amber-500/10 text-amber-700',
        state === 'disabledByProfile' && 'bg-muted text-muted-foreground',
      )}>
        {t(`form.capabilities.toolStates.${state}`)}
      </span>
    );
    const renderPolicyControl = (tool: AgentToolConfigOption, forceDisabled = false) => {
      const currentSetting = readToolPolicySetting(tool.toolKey);
      const policyControlsDisabled = controlsDisabled || forceDisabled || tool.deniedByGlobalPolicy;
      const policyButtonClass = (setting: 'default' | 'allow' | 'deny') => cn(
        'h-6 rounded-full px-2 text-[11px] shadow-none',
        currentSetting === setting
          ? 'bg-card text-foreground shadow-sm hover:bg-card'
          : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
      );
      return (
        <div className="inline-flex items-center rounded-full border bg-muted/40 p-0.5">
          <Button type="button" variant="ghost" disabled={policyControlsDisabled} className={policyButtonClass('default')} onClick={() => setToolPolicySetting(tool.toolKey, 'default')}>
            {t('form.capabilities.policyDefault')}
          </Button>
          <Button type="button" variant="ghost" disabled={policyControlsDisabled} className={policyButtonClass('allow')} onClick={() => setToolPolicySetting(tool.toolKey, 'allow')}>
            {t('form.capabilities.allow')}
          </Button>
          <Button type="button" variant="ghost" disabled={policyControlsDisabled} className={policyButtonClass('deny')} onClick={() => setToolPolicySetting(tool.toolKey, 'deny')}>
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
                  globalDeny: globalDenyCount,
                  overrides: explicitRuleCount,
                })}
              </p>
            ) : null}
          </div>
          <label className="inline-flex shrink-0 items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground">
            <Switch
              aria-label={t('form.useAllTools')}
              checked={toolSelectionMode === 'inherit'}
              disabled={!toolConfigView || toolConfigLoading || Boolean(unsupportedReason)}
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
                <Select id="subagent-tool-profile" value={toolProfile} disabled={controlsDisabled} onChange={(event) => setToolProfile(event.target.value)}>
                  {toolProfileOptions.map((profile) => (
                    <option key={profile.profileKey} value={profile.profileKey}>{formatToolProfileLabel(profile.profileKey, profile.displayName, t)}</option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                <div className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">{t('form.capabilities.configPreview')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{effectiveEnabledCount}/{allTools.length}</p>
                </div>
                <div className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">{t('form.capabilities.profileDefault')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{profileEnabledCount}/{allTools.length}</p>
                </div>
                <div className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">{t('form.capabilities.globalDeny')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{globalDenyCount}</p>
                </div>
                <div className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[11px] text-muted-foreground">{t('form.capabilities.explicitRules')}</p>
                  <p className="mt-1 text-sm font-medium text-foreground">{explicitRuleCount}</p>
                </div>
              </div>
              {controlsDisabled ? <p className="text-xs text-muted-foreground md:col-span-2">{t('form.capabilities.inheritToolsHint')}</p> : null}
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {toolGroups.map((group) => {
                const groupPolicyOption = findGroupPolicyOption(group.groupKey);
                const expanded = expandedToolGroupKeys.includes(group.groupKey);
                const groupGloballyDenied = Boolean(groupPolicyOption?.deniedByGlobalPolicy) || (group.toolOptions.length > 0 && group.toolOptions.every((tool) => tool.deniedByGlobalPolicy));
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
                        onClick={() => setExpandedToolGroupKeys((previous) => toggleStringKey(previous, group.groupKey, !expanded))}
                      >
                        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded ? 'rotate-0' : '-rotate-90')} />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">{group.displayName}</span>
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                              {group.source === 'plugin' ? t('form.capabilities.pluginBadge') : t('form.capabilities.coreBadge')}
                            </span>
                            {group.pluginId ? <span className="text-[11px] text-muted-foreground">{group.pluginId}</span> : null}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {t('form.capabilities.groupSummary', { enabled: enabledInGroupCount, total: group.toolOptions.length, rules: groupRuleCount })}
                          </span>
                        </span>
                      </button>
                      {groupPolicyOption ? renderPolicyControl(groupPolicyOption, groupGloballyDenied) : null}
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
                                {tool.source === 'plugin' && tool.pluginId ? <p className="mt-1 text-[11px] text-muted-foreground">{tool.pluginId}</p> : null}
                              </div>
                              <div className="flex justify-start md:justify-end">{renderPolicyControl(tool)}</div>
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

  return children({
    basicInfoLocked,
    valid: (basicInfoLocked || Boolean(workspace.trim()))
      && !missingModel
      && (mode === 'edit' || hasModelOptions)
      && !modelsLoading,
    fields: {
      basic: basicFields,
      skills: mode === 'edit' ? renderSkillConfig() : null,
      tools: mode === 'edit' ? renderToolConfig() : null,
    },
    reconcileName: (nextName) => {
      if (mode === 'create') {
        setWorkspace(buildWorkspaceValue(nextName));
      }
    },
    prepareCreate: (values) => ({
      name: values.name.trim(),
      description: values.description.trim(),
      workspace: workspace.trim(),
      model: resolveModelRuntimeReference(modelOptions, model.trim()),
      avatarSeed: values.avatarSeed.trim(),
      avatarStyle: values.avatarStyle,
    }),
    prepareUpdate: (values, targetAgentId) => {
      const update: AgentEditorUpdate = {
        input: {
          agentId: targetAgentId,
          name: basicInfoLocked ? (initialValues?.name ?? values.name.trim()) : values.name.trim(),
          description: values.description.trim(),
          workspace: basicInfoLocked ? (initialValues?.workspace ?? workspace.trim()) : workspace.trim(),
          model: resolveModelRuntimeReference(modelOptions, model.trim()),
          avatarSeed: values.avatarSeed.trim(),
          avatarStyle: values.avatarStyle,
        },
      };
      if (skillConfigChanged && skillConfigView) {
        update.skillConfig = {
          agentId: targetAgentId,
          revision: skillConfigView.revision,
          selection: skillSelectionMode === 'inherit'
            ? { selectionType: 'inheritDefaultSkills' }
            : { selectionType: 'setExplicitSkillAllowlist', skillKeys: selectedSkillKeys },
        };
      }
      if (toolConfigChanged && toolConfigView) {
        update.toolConfig = {
          agentId: targetAgentId,
          revision: toolConfigView.revision,
          selection: toolSelectionMode === 'inherit'
            ? { selectionType: 'inheritDefaultTools' }
            : { selectionType: 'setAgentToolPolicy', profile: toolProfile, allow: allowedToolKeys, deny: deniedToolKeys },
        };
      }
      return update;
    },
  });
}
