import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentSkillOption } from './components/AgentSkillConfigDialog';

interface AgentLike {
  id: string;
  name?: string;
  workspace?: string;
  model?: string;
  skills?: string[];
}

interface SkillLike {
  id: string;
  name: string;
  icon?: string;
  enabled?: boolean;
  eligible?: boolean;
}

interface UseSkillConfigInput {
  currentAgent?: AgentLike;
  skills: SkillLike[];
  skillsSnapshotReady: boolean;
  skillsInitialLoading: boolean;
  fetchSkills: () => Promise<void>;
  updateAgent: (input: {
    agentId: string;
    name: string;
    workspace: string;
    model?: string;
    skills?: string[] | null;
  }) => Promise<void>;
}

interface UseSkillConfigResult {
  open: boolean;
  saving: boolean;
  selectedSkillIds: string[];
  availableSkillOptions: AgentSkillOption[];
  skillsLoading: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  toggleSkill: (skillId: string, checked: boolean) => void;
  save: () => Promise<void>;
}

export function useSkillConfig(input: UseSkillConfigInput): UseSkillConfigResult {
  const {
    currentAgent,
    skills,
    skillsSnapshotReady,
    skillsInitialLoading,
    fetchSkills,
    updateAgent,
  } = input;

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);

  const availableSkillOptions = useMemo<AgentSkillOption[]>(
    () => skills
      .filter((skill) => skill.enabled !== false && skill.eligible !== false)
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        icon: skill.icon,
      })),
    [skills],
  );
  const availableSkillIds = useMemo(
    () => availableSkillOptions.map((skill) => skill.id),
    [availableSkillOptions],
  );
  const availableSkillSet = useMemo(
    () => new Set(availableSkillIds),
    [availableSkillIds],
  );

  const openDialog = useCallback(() => {
    if (!currentAgent) {
      return;
    }
    setOpen(true);
    if (!skillsSnapshotReady && !skillsInitialLoading) {
      void fetchSkills();
    }
  }, [currentAgent, fetchSkills, skillsInitialLoading, skillsSnapshotReady]);

  const closeDialog = useCallback(() => {
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open || !currentAgent) {
      return;
    }
    const currentSkills = Array.isArray(currentAgent.skills)
      ? currentAgent.skills
      : availableSkillIds;
    const normalized = Array.from(new Set(currentSkills.filter((id) => availableSkillSet.has(id))));
    setSelectedSkillIds(normalized);
  }, [availableSkillIds, availableSkillSet, currentAgent, open]);

  const toggleSkill = useCallback((skillId: string, checked: boolean) => {
    setSelectedSkillIds((prev) => {
      if (checked) {
        if (prev.includes(skillId)) {
          return prev;
        }
        return [...prev, skillId];
      }
      return prev.filter((id) => id !== skillId);
    });
  }, []);

  const save = useCallback(async () => {
    if (!currentAgent) {
      return;
    }
    setSaving(true);
    try {
      await updateAgent({
        agentId: currentAgent.id,
        name: currentAgent.name || currentAgent.id,
        workspace: currentAgent.workspace ?? '',
        model: currentAgent.model,
        skills: selectedSkillIds,
      });
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }, [currentAgent, selectedSkillIds, updateAgent]);

  return {
    open,
    saving,
    selectedSkillIds,
    availableSkillOptions,
    skillsLoading: !skillsSnapshotReady && skillsInitialLoading,
    openDialog,
    closeDialog,
    toggleSkill,
    save,
  };
}

