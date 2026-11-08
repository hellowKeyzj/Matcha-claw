import { useCallback, useMemo, useRef, useState } from 'react';
import { buildAgentSkillConfigKey, useAgentSkillConfigStore, type AgentSkillConfigView } from '@/plugins/agents/stores/agent-skill-config';
import { useSkillsStore } from '@/plugins/skills/stores/skills';
import { buildCapabilityScopeKey, type AgentScope } from '@/types/desktop/runtime-address';
import type { AgentSkillOption } from '@/plugins/chat/components/AgentSkillConfigPanel';

interface UseAgentSkillConfigInput {
  currentAgentId?: string | null;
  scope: AgentScope | null;
}

interface UseAgentSkillConfigResult {
  selectedSkillIds: string[];
  allowedSkillIdsForChat: string[] | null;
  availableSkillOptions: AgentSkillOption[];
  skillsLoading: boolean;
  skillsError: string | null;
  savingSkillId: string | null;
  prepare: () => void;
  resetSession: () => void;
  toggleSkill: (skillId: string, checked: boolean) => void;
}

function normalizeSkillIds(skillIds: readonly string[]): string[] {
  return Array.from(new Set(skillIds.map((skillId) => skillId.trim()).filter(Boolean)));
}

function equalSkillIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  for (let index = 0; index < normalizedLeft.length; index += 1) {
    if (normalizedLeft[index] !== normalizedRight[index]) {
      return false;
    }
  }
  return true;
}

function shouldToggleFromEffectiveSkillKeys(view: AgentSkillConfigView): boolean {
  return view.selectionMode === 'inheritsDefaultSkills';
}

function resolveNextSelectedSkillIds(params: {
  previousSkillIds: readonly string[];
  skillId: string;
  checked: boolean;
}): string[] {
  const { previousSkillIds, skillId, checked } = params;
  if (checked) {
    return previousSkillIds.includes(skillId)
      ? [...previousSkillIds]
      : [...previousSkillIds, skillId];
  }
  return previousSkillIds.filter((id) => id !== skillId);
}

function resolveAgentSkillSelectionForWrite(params: {
  selectedSkillIds: readonly string[];
  inheritedDefaultSkillKeys: readonly string[];
}):
  | { selectionType: 'inheritDefaultSkills' }
  | { selectionType: 'setExplicitSkillAllowlist'; skillKeys: string[] } {
  const { selectedSkillIds, inheritedDefaultSkillKeys } = params;
  if (equalSkillIds(selectedSkillIds, inheritedDefaultSkillKeys)) {
    return { selectionType: 'inheritDefaultSkills' };
  }
  return {
    selectionType: 'setExplicitSkillAllowlist',
    skillKeys: normalizeSkillIds(selectedSkillIds),
  };
}

type LocalSkillSelection = {
  readonly agentId: string;
  readonly skillIds: readonly string[];
};

export function useAgentSkillConfig({ currentAgentId, scope }: UseAgentSkillConfigInput): UseAgentSkillConfigResult {
  const normalizedAgentId = currentAgentId?.trim() || null;
  const nativeAgent = scope?.kind === 'agent' && scope.endpoint.kind === 'native-runtime' && scope.endpoint.runtimeAdapterId === 'matcha-agent';
  const configKey = !nativeAgent && normalizedAgentId && scope ? buildAgentSkillConfigKey(scope, normalizedAgentId) : null;
  const view = useAgentSkillConfigStore((state) => (
    configKey ? state.viewByAgentId[configKey] : undefined
  ));
  const loading = useAgentSkillConfigStore((state) => (
    configKey ? state.loadingByAgentId[configKey] === true : false
  ));
  const loadAgentSkillConfig = useAgentSkillConfigStore((state) => state.loadAgentSkillConfig);
  const setAgentSkillConfig = useAgentSkillConfigStore((state) => state.setAgentSkillConfig);
  const skillsScopeKey = nativeAgent && scope ? buildCapabilityScopeKey(scope) : null;
  const nativeSkills = useSkillsStore((state) => (
    skillsScopeKey !== null && state.scopeKey === skillsScopeKey ? state.skills : undefined
  ));
  const nativeSkillsLoading = useSkillsStore((state) => skillsScopeKey !== null && (
    state.scopeKey !== skillsScopeKey || (!state.snapshotReady && !state.error)
  ));
  const nativeSkillsError = useSkillsStore((state) => (
    skillsScopeKey !== null && state.scopeKey === skillsScopeKey ? state.error : null
  ));
  const nativeApplications = useSkillsStore((state) => (
    skillsScopeKey !== null && state.scopeKey === skillsScopeKey ? state.configApplicationBySkillId : undefined
  ));
  const nativeSavingSkillId = useSkillsStore((state) => (
    skillsScopeKey !== null && state.scopeKey === skillsScopeKey ? Object.keys(state.mutatingBySkillId)[0] ?? null : null
  ));

  const [saveError, setSaveError] = useState<{ scopeKey: string; skillId: string } | null>(null);
  const [localSelection, setLocalSelection] = useState<LocalSkillSelection | null>(null);
  const [savingSelection, setSavingSelection] = useState<{ agentId: string; skillId: string } | null>(null);
  const savingAgentIdRef = useRef<string | null>(null);
  const writeSeqRef = useRef(0);

  const localSelectedSkillIds = localSelection?.agentId === configKey
    ? localSelection.skillIds
    : null;
  const savingSkillId = nativeAgent ? nativeSavingSkillId : savingSelection?.agentId === configKey
    ? savingSelection.skillId
    : null;
  const isSavingCurrentAgentSkillConfig = savingSkillId !== null;
  const selectedSkillIds = useMemo(() => {
    if (nativeAgent) return (nativeSkills ?? []).filter((skill) => skill.enabled).map((skill) => skill.id);
    if (localSelectedSkillIds) {
      return normalizeSkillIds(localSelectedSkillIds);
    }
    if (!normalizedAgentId || view?.agentId !== normalizedAgentId) {
      return [];
    }
    return normalizeSkillIds(view.effectiveSkillKeys);
  }, [localSelectedSkillIds, nativeAgent, nativeSkills, normalizedAgentId, view]);
  const allowedSkillIdsForChat = useMemo<string[] | null>(() => {
    if (nativeAgent || !view || loading || isSavingCurrentAgentSkillConfig) {
      return null;
    }
    if (view.support.supportType === 'unsupported') {
      return view.support.reason === 'agentNotConfigured' ? [] : null;
    }
    return normalizeSkillIds(view.effectiveSkillKeys);
  }, [isSavingCurrentAgentSkillConfig, loading, nativeAgent, view]);

  const availableSkillOptions = useMemo<AgentSkillOption[]>(() => {
    if (nativeAgent) {
      return (nativeSkills ?? []).filter((skill) => (
        skill.source === 'bundled' && skill.eligible === true && skill.selectable === true
      )).map((skill) => ({
        id: skill.id,
        name: skill.name.trim() || skill.id,
        description: skill.description,
        selectable: skill.selectable,
        application: nativeApplications?.[skill.id],
        saveError: saveError?.scopeKey === skillsScopeKey && saveError.skillId === skill.id,
      }));
    }
    return (view?.options ?? []).map((option) => ({
      id: option.skillKey,
      name: option.displayName.trim() || option.skillKey,
      description: option.description,
      selectable: option.selectable,
      unavailableReason: option.unavailableReason,
    }));
  }, [nativeAgent, nativeApplications, nativeSkills, saveError, skillsScopeKey, view?.options]);

  const prepare = useCallback(() => {
    if (nativeAgent || !normalizedAgentId || !scope) return;
    void loadAgentSkillConfig(normalizedAgentId, scope).catch(() => undefined);
  }, [loadAgentSkillConfig, nativeAgent, normalizedAgentId, scope]);

  const resetSession = useCallback(() => {
    writeSeqRef.current += 1;
    setLocalSelection((currentSelection) => (
      currentSelection?.agentId === configKey ? null : currentSelection
    ));
  }, [configKey]);

  const toggleSkill = useCallback((skillId: string, checked: boolean) => {
    if (nativeAgent && scope && skillsScopeKey) {
      const state = useSkillsStore.getState();
      if (state.scopeKey !== skillsScopeKey || state.mutating) return;
      const skill = state.skills.find((entry) => entry.id === skillId);
      if (!skill || skill.source !== 'bundled' || !skill.eligible || !skill.selectable || skill.enabled === checked) return;
      const generation = state.scopeGeneration;
      setSaveError(null);
      void (checked ? state.enableSkill(skillId, scope) : state.disableSkill(skillId, scope)).catch(() => {
        const current = useSkillsStore.getState();
        if (current.scopeKey === skillsScopeKey && current.scopeGeneration === generation) {
          setSaveError({ scopeKey: skillsScopeKey, skillId });
        }
      });
      return;
    }
    const agentId = normalizedAgentId;
    const currentView = view;
    if (!agentId || !scope || !configKey || !currentView || currentView.agentId !== agentId || !currentView.revision) {
      return;
    }
    if (currentView.support.supportType === 'unsupported') {
      return;
    }
    if (savingAgentIdRef.current === configKey) {
      return;
    }

    const targetSkillOption = currentView.options.find((option) => option.skillKey === skillId);
    if (checked && targetSkillOption?.selectable === false) {
      return;
    }

    const baseSkillIds = !localSelectedSkillIds && shouldToggleFromEffectiveSkillKeys(currentView)
      ? normalizeSkillIds(currentView.effectiveSkillKeys)
      : selectedSkillIds;
    const nextSelectedSkillIds = normalizeSkillIds(resolveNextSelectedSkillIds({
      previousSkillIds: baseSkillIds,
      skillId,
      checked,
    }));

    if (equalSkillIds(baseSkillIds, nextSelectedSkillIds)) {
      return;
    }

    setLocalSelection({ agentId: configKey, skillIds: nextSelectedSkillIds });
    savingAgentIdRef.current = configKey;
    setSavingSelection({ agentId: configKey, skillId });
    const writeSeq = writeSeqRef.current + 1;
    writeSeqRef.current = writeSeq;

    void setAgentSkillConfig({
      agentId,
      revision: currentView.revision,
      selection: resolveAgentSkillSelectionForWrite({
        selectedSkillIds: nextSelectedSkillIds,
        inheritedDefaultSkillKeys: currentView.inheritedDefaultSkillKeys,
      }),
    }, scope).then(() => {
      if (writeSeqRef.current !== writeSeq) {
        return;
      }
      setLocalSelection((currentSelection) => (
        currentSelection?.agentId === configKey ? null : currentSelection
      ));
    }).catch(() => {
      if (writeSeqRef.current !== writeSeq) {
        return;
      }
      setLocalSelection((currentSelection) => (
        currentSelection?.agentId === configKey ? null : currentSelection
      ));
    }).finally(() => {
      if (savingAgentIdRef.current !== configKey) {
        return;
      }
      savingAgentIdRef.current = null;
      setSavingSelection((currentSavingSelection) => (
        currentSavingSelection?.agentId === configKey ? null : currentSavingSelection
      ));
    });
  }, [configKey, localSelectedSkillIds, nativeAgent, normalizedAgentId, scope, selectedSkillIds, setAgentSkillConfig, skillsScopeKey, view]);

  return {
    selectedSkillIds,
    allowedSkillIdsForChat,
    availableSkillOptions,
    skillsLoading: nativeAgent ? nativeSkillsLoading : loading && !view,
    skillsError: nativeSkillsError,
    savingSkillId,
    prepare,
    resetSession,
    toggleSkill,
  };
}
