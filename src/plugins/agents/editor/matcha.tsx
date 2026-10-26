import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import type { AgentEditorController, AgentEditorOwnerProps, AgentEditorUpdate } from '@/plugins/agents/extensions';
import { NativePolicySection } from '@/plugins/agents/pages/components/NativePolicySection';
import { formatWorkspacePathForDisplay } from '@/plugins/files/types';
import { areStringSetsEqual, toggleStringKey } from './shared';

export default function MatchaAgentEditorOwner(props: AgentEditorOwnerProps) {
  const { t } = useTranslation('subagents');
  const [workspace] = useState(() => props.initialSnapshot.initialValues?.workspace ?? '');
  const [model, setModel] = useState(() => props.initialSnapshot.initialValues?.model ?? '');
  const {
    open,
    mode,
    agentId,
    scope,
    toolConfigView,
    toolConfigLoading = false,
    toolConfigError = null,
  } = props;

  const [toolDraft, setToolDraft] = useState<{
    source: Pick<AgentEditorOwnerProps, 'open' | 'mode' | 'agentId' | 'toolConfigView'> | null;
    toolSelectionMode: 'inherit' | 'explicit';
    toolProfile: string;
    allowedToolKeys: string[];
    deniedToolKeys: string[];
  }>({
    source: null,
    toolSelectionMode: 'inherit',
    toolProfile: 'default',
    allowedToolKeys: [],
    deniedToolKeys: [],
  });
  const { source, toolSelectionMode, toolProfile, allowedToolKeys, deniedToolKeys } = toolDraft;
  if (!source || source.open !== open || source.mode !== mode || source.agentId !== agentId || source.toolConfigView !== toolConfigView) {
    const nextSource = { open, mode, agentId, toolConfigView };
    if (open && mode === 'edit' && toolConfigView && toolConfigView.agentId === agentId) {
      const usesAgentPolicy = toolConfigView.selectionMode === 'usesAgentToolPolicy' && toolConfigView.toolPolicy;
      setToolDraft({
        source: nextSource,
        toolSelectionMode: usesAgentPolicy ? 'explicit' : 'inherit',
        toolProfile: usesAgentPolicy ? toolConfigView.toolPolicy?.profile ?? 'default' : 'default',
        allowedToolKeys: usesAgentPolicy ? [...(toolConfigView.toolPolicy?.allow ?? [])] : [],
        deniedToolKeys: usesAgentPolicy ? [...(toolConfigView.toolPolicy?.deny ?? [])] : [],
      });
    } else {
      setToolDraft({ ...toolDraft, source: nextSource });
    }
  }

  const toolConfigChanged = mode === 'edit'
    && toolConfigView?.support.supportType === 'supported'
    && (
      (toolSelectionMode === 'inherit') !== (toolConfigView.selectionMode === 'inheritsDefaultTools')
      || (toolSelectionMode === 'explicit' && (
        toolProfile !== (toolConfigView.toolPolicy?.profile ?? 'full')
        || !areStringSetsEqual(allowedToolKeys, toolConfigView.toolPolicy?.allow ?? [])
        || !areStringSetsEqual(deniedToolKeys, toolConfigView.toolPolicy?.deny ?? [])
      ))
    );
  const unsupportedReason = toolConfigView?.support.supportType === 'unsupported'
    ? toolConfigView.support.reason
    : null;
  const toolsDisabled = !toolConfigView || toolConfigLoading || Boolean(toolConfigError) || Boolean(unsupportedReason);
  const readToolPolicySetting = (toolKey: string): 'default' | 'allow' | 'deny' => {
    if (deniedToolKeys.includes(toolKey)) {
      return 'deny';
    }
    return allowedToolKeys.includes(toolKey) ? 'allow' : 'default';
  };
  const setToolPolicySetting = (toolKey: string, setting: 'default' | 'allow' | 'deny') => {
    setToolDraft((prev) => ({
      ...prev,
      allowedToolKeys: toggleStringKey(prev.allowedToolKeys, toolKey, setting === 'allow'),
      deniedToolKeys: toggleStringKey(prev.deniedToolKeys, toolKey, setting === 'deny'),
    }));
  };
  const prepareCreate: AgentEditorController['prepareCreate'] = (values) => ({
    name: values.name.trim(),
    description: values.description.trim(),
    model: model.trim() || undefined,
    avatarSeed: values.avatarSeed.trim(),
    avatarStyle: values.avatarStyle,
  });
  const prepareUpdate: AgentEditorController['prepareUpdate'] = (values, targetAgentId) => {
    const update: AgentEditorUpdate = {
      input: { agentId: targetAgentId, ...prepareCreate(values) },
    };
    if (toolConfigChanged && toolConfigView) {
      update.toolConfig = {
        agentId: targetAgentId,
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
    }
    return update;
  };

  return props.children({
    basicInfoLocked: false,
    valid: true,
    reconcileName: () => {},
    prepareCreate,
    prepareUpdate,
    fields: {
      basic: <>
        <div className="space-y-1">
          <Label htmlFor="subagent-workspace">{t('form.workspace')}</Label>
          <Input
            id="subagent-workspace"
            value={workspace ? formatWorkspacePathForDisplay(workspace) : t('form.managedWorkspace', { defaultValue: '由运行时管理的私有工作区' })}
            readOnly
            className="text-muted-foreground"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="subagent-model">{t('form.model')}</Label>
          <Input
            id="subagent-model"
            value={model}
            placeholder={t('form.nativeModel', { defaultValue: '留空使用原生默认模型' })}
            onChange={(event) => setModel(event.target.value)}
          />
        </div>
      </>,
      skills: mode === 'edit' ? <p className="rounded-xl border p-4 text-sm text-muted-foreground">{t('form.nativeSkillsUnsupported', { defaultValue: '此运行时不提供逐 Agent 技能开关；技能由原生 CLI 发现和授权。' })}</p> : null,
      tools: mode === 'edit' ? <>
        <section className="flex min-h-0 flex-col gap-3 rounded-xl border p-4">
          <h3 className="text-sm font-semibold">{t('form.toolConfig')}</h3>
          <p className="text-xs text-muted-foreground">{t('form.nativeToolsHint', { defaultValue: '以下是原生 CLI 可配置工具子集，不代表当前可用工具。更改仅作用于后续 CLI 实例；执行仍受原生权限与组织策略约束，不会自动授权。' })}</p>
          {toolConfigError ? <p role="alert" className="text-sm text-destructive">{toolConfigError}</p> : null}
          {unsupportedReason ? <p className="text-sm text-muted-foreground">{t(`form.capabilities.unsupported.${unsupportedReason}`)}</p> : null}
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={toolSelectionMode === 'inherit'}
              disabled={toolsDisabled}
              onCheckedChange={(checked) => setToolDraft((prev) => ({ ...prev, toolSelectionMode: checked ? 'inherit' : 'explicit' }))}
            />
            {t('form.nativeToolsInherit', { defaultValue: '使用原生默认工具配置' })}
          </label>
          {toolSelectionMode === 'explicit' && <>
            <Label htmlFor="native-tool-profile">{t('form.toolProfile')}</Label>
            <Select
              id="native-tool-profile"
              value={toolProfile}
              disabled={toolsDisabled}
              onChange={(event) => {
                const toolProfile = event.target.value;
                setToolDraft((prev) => ({ ...prev, toolProfile, allowedToolKeys: toolProfile === 'default' ? [] : prev.allowedToolKeys }));
              }}
            >
              {(toolConfigView?.toolProfiles ?? []).map((profile) => (
                <option key={profile.profileKey} value={profile.profileKey}>{profile.displayName}</option>
              ))}
            </Select>
            <div className="min-h-0 space-y-2 overflow-y-auto">
              {(toolConfigView?.toolOptions ?? []).filter((tool) => tool.optionType === 'tool').map((tool) => (
                <div key={tool.toolKey} className="flex items-center justify-between gap-3 rounded-lg border p-2">
                  <span className="text-sm">{tool.displayName}</span>
                  <Select
                    aria-label={tool.displayName}
                    className="w-auto"
                    value={readToolPolicySetting(tool.toolKey)}
                    disabled={toolsDisabled}
                    onChange={(event) => setToolPolicySetting(tool.toolKey, event.target.value as 'default' | 'allow' | 'deny')}
                  >
                    <option value="default">{t('form.capabilities.policyDefault')}</option>
                    {toolProfile === 'native' && <option value="allow">{t('form.nativeToolsInclude', { defaultValue: '加入显式工具列表' })}</option>}
                    <option value="deny">{t('form.capabilities.deny')}</option>
                  </Select>
                </div>
              ))}
            </div>
          </>}
        </section>
        {scope && <NativePolicySection scope={scope} />}
      </> : null,
    },
  });
}
