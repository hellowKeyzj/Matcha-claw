import { useCallback, useMemo, useRef, useState } from 'react';
import { useAgentSkillConfigStore, type AgentSkillConfigView } from '@/stores/agent-skill-config';
import type { AgentSkillOption } from './components/AgentSkillConfigPanel';

interface UseAgentSkillConfigInput {
  currentAgentId?: string | null;
}

interface UseAgentSkillConfigResult {
  selectedSkillIds: string[];
  allowedSkillIdsForChat: string[] | null;
  availableSkillOptions: AgentSkillOption[];
  skillsLoading: boolean;
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

export function useAgentSkillConfig({ currentAgentId }: UseAgentSkillConfigInput): UseAgentSkillConfigResult {
  const normalizedAgentId = currentAgentId?.trim() || null;
  const view = useAgentSkillConfigStore((state) => (
    normalizedAgentId ? state.viewByAgentId[normalizedAgentId] : undefined
  ));
  const loading = useAgentSkillConfigStore((state) => (
    normalizedAgentId ? state.loadingByAgentId[normalizedAgentId] === true : false
  ));
  const loadAgentSkillConfig = useAgentSkillConfigStore((state) => state.loadAgentSkillConfig);
  const setAgentSkillConfig = useAgentSkillConfigStore((state) => state.setAgentSkillConfig);

  const [localSelection, setLocalSelection] = useState<LocalSkillSelection | null>(null);
  const [savingAgentId, setSavingAgentId] = useState<string | null>(null);
  const savingAgentIdRef = useRef<string | null>(null);
  const writeSeqRef = useRef(0);

  const localSelectedSkillIds = localSelection?.agentId === normalizedAgentId
    ? localSelection.skillIds
    : null;
  const isSavingCurrentAgentSkillConfig = savingAgentId === normalizedAgentId;
  const selectedSkillIds = useMemo(() => {
    if (localSelectedSkillIds) {
      return normalizeSkillIds(localSelectedSkillIds);
    }
    if (!normalizedAgentId || view?.agentId !== normalizedAgentId) {
      return [];
    }
    return normalizeSkillIds(view.effectiveSkillKeys);
  }, [localSelectedSkillIds, normalizedAgentId, view]);
  const allowedSkillIdsForChat = useMemo<string[] | null>(() => {
    if (!view || loading || isSavingCurrentAgentSkillConfig) {
      return null;
    }
    if (view.support.supportType === 'unsupported') {
      return view.support.reason === 'agentNotConfigured' ? [] : null;
    }
    return normalizeSkillIds(view.effectiveSkillKeys);
  }, [isSavingCurrentAgentSkillConfig, loading, view]);

  const availableSkillOptions = useMemo<AgentSkillOption[]>(() => (
    (view?.options ?? []).map((option) => ({
      id: option.skillKey,
      name: option.displayName.trim() || option.skillKey,
      description: option.description,
      selectable: option.selectable,
      unavailableReason: option.unavailableReason,
    }))
  ), [view?.options]);

  const prepare = useCallback(() => {
    if (!normalizedAgentId) {
      return;
    }
    void loadAgentSkillConfig(normalizedAgentId).catch(() => undefined);
  }, [loadAgentSkillConfig, normalizedAgentId]);

  const resetSession = useCallback(() => {
    writeSeqRef.current += 1;
    setLocalSelection((currentSelection) => (
      currentSelection?.agentId === normalizedAgentId ? null : currentSelection
    ));
  }, [normalizedAgentId]);

  const toggleSkill = useCallback((skillId: string, checked: boolean) => {
    const agentId = normalizedAgentId;
    const currentView = view;
    if (!agentId || !currentView || currentView.agentId !== agentId || !currentView.revision) {
      return;
    }
    if (currentView.support.supportType === 'unsupported') {
      return;
    }
    if (savingAgentIdRef.current === agentId) {
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

    setLocalSelection({ agentId, skillIds: nextSelectedSkillIds });
    savingAgentIdRef.current = agentId;
    setSavingAgentId(agentId);
    const writeSeq = writeSeqRef.current + 1;
    writeSeqRef.current = writeSeq;

    void setAgentSkillConfig({
      agentId,
      revision: currentView.revision,
      selection: resolveAgentSkillSelectionForWrite({
        selectedSkillIds: nextSelectedSkillIds,
        inheritedDefaultSkillKeys: currentView.inheritedDefaultSkillKeys,
      }),
    }).then(() => {
      if (writeSeqRef.current !== writeSeq) {
        return;
      }
      setLocalSelection((currentSelection) => (
        currentSelection?.agentId === agentId ? null : currentSelection
      ));
    }).catch(() => {
      if (writeSeqRef.current !== writeSeq) {
        return;
      }
      setLocalSelection((currentSelection) => (
        currentSelection?.agentId === agentId ? null : currentSelection
      ));
    }).finally(() => {
      if (savingAgentIdRef.current !== agentId) {
        return;
      }
      savingAgentIdRef.current = null;
      setSavingAgentId((currentSavingAgentId) => (
        currentSavingAgentId === agentId ? null : currentSavingAgentId
      ));
    });
  }, [localSelectedSkillIds, normalizedAgentId, selectedSkillIds, setAgentSkillConfig, view]);

  return {
    selectedSkillIds,
    allowedSkillIdsForChat,
    availableSkillOptions,
    skillsLoading: (loading && !view) || isSavingCurrentAgentSkillConfig,
    prepare,
    resetSession,
    toggleSkill,
  };
}
