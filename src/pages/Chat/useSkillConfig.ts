import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSkillOption } from './components/AgentSkillConfigPanel';

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
  description?: string;
  icon?: string;
  enabled?: boolean;
  eligible?: boolean;
}

interface UseSkillConfigInput {
  currentAgent?: AgentLike;
  readAgent: (agentId: string) => AgentLike | undefined;
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
  selectedSkillIds: string[];
  availableSkillOptions: AgentSkillOption[];
  skillsLoading: boolean;
  prepare: () => void;
  resetSession: () => void;
  toggleSkill: (skillId: string, checked: boolean) => void;
}

function equalSkillIds(left: string[], right: string[]): boolean {
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

function normalizeSelectedSkillIds(params: {
  currentAgent?: AgentLike;
  availableSkillIds: string[];
  availableSkillSet: Set<string>;
  skillsSnapshotReady: boolean;
}): string[] {
  const { currentAgent, availableSkillIds, availableSkillSet, skillsSnapshotReady } = params;
  if (!currentAgent) {
    return [];
  }

  const currentSkills = Array.isArray(currentAgent.skills)
    ? currentAgent.skills
    : (skillsSnapshotReady ? availableSkillIds : []);

  return skillsSnapshotReady
    ? Array.from(new Set(currentSkills.filter((id) => availableSkillSet.has(id))))
    : Array.from(new Set(currentSkills));
}

export function useSkillConfig(input: UseSkillConfigInput): UseSkillConfigResult {
  const {
    currentAgent,
    readAgent,
    skills,
    skillsSnapshotReady,
    skillsInitialLoading,
    fetchSkills,
    updateAgent,
  } = input;

  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [, setSyncedSkillIds] = useState<string[]>([]);
  const preparedAgentIdRef = useRef<string | null>(null);
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
  const selectedSkillIdsRef = useRef<string[]>([]);
  const syncedSkillIdsRef = useRef<string[]>([]);
  const syncInFlightRef = useRef(false);
  const syncRequestSeqRef = useRef(0);
  const hasLocalInteractionRef = useRef(false);

  const availableSkillOptions = useMemo<AgentSkillOption[]>(
    () => skills
      .filter((skill) => skill.enabled !== false && skill.eligible !== false)
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
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
  const applySelectedSkillIds = useCallback((nextSkillIds: string[]) => {
    if (equalSkillIds(selectedSkillIdsRef.current, nextSkillIds)) {
      return;
    }
    selectedSkillIdsRef.current = nextSkillIds;
    setSelectedSkillIds(nextSkillIds);
  }, []);

  const applySyncedSkillIds = useCallback((nextSkillIds: string[]) => {
    if (equalSkillIds(syncedSkillIdsRef.current, nextSkillIds)) {
      return;
    }
    syncedSkillIdsRef.current = nextSkillIds;
    setSyncedSkillIds(nextSkillIds);
  }, []);

  const resolveAgentSkillIds = useCallback((agent?: AgentLike) => normalizeSelectedSkillIds({
    currentAgent: agent,
    availableSkillIds,
    availableSkillSet,
    skillsSnapshotReady,
  }), [availableSkillIds, availableSkillSet, skillsSnapshotReady]);

  const syncLatestSkillSelection = useCallback(() => {
    const agentId = preparedAgentIdRef.current;
    if (!agentId || syncInFlightRef.current) {
      return;
    }

    const desiredSkillIds = selectedSkillIdsRef.current;
    const committedSkillIds = syncedSkillIdsRef.current;
    if (equalSkillIds(desiredSkillIds, committedSkillIds)) {
      return;
    }

    const latestAgent = readAgent(agentId) ?? currentAgent;
    if (!latestAgent) {
      return;
    }

    const requestSkillIds = desiredSkillIds;
    const requestSeq = syncRequestSeqRef.current + 1;
    syncRequestSeqRef.current = requestSeq;
    syncInFlightRef.current = true;

    void updateAgent({
      agentId,
      name: latestAgent.name || latestAgent.id,
      workspace: latestAgent.workspace ?? '',
      model: latestAgent.model,
      skills: requestSkillIds,
    }).then(() => {
      if (syncRequestSeqRef.current !== requestSeq || preparedAgentIdRef.current !== agentId) {
        return;
      }
      const committedAgent = readAgent(agentId) ?? latestAgent;
      const committedAfterSync = resolveAgentSkillIds(committedAgent);
      applySyncedSkillIds(committedAfterSync);

      if (
        equalSkillIds(selectedSkillIdsRef.current, requestSkillIds)
        && !equalSkillIds(committedAfterSync, requestSkillIds)
      ) {
        applySelectedSkillIds(committedAfterSync);
      }
    }).finally(() => {
      if (syncRequestSeqRef.current !== requestSeq || preparedAgentIdRef.current !== agentId) {
        return;
      }
      syncInFlightRef.current = false;
      if (!equalSkillIds(selectedSkillIdsRef.current, syncedSkillIdsRef.current)) {
        syncLatestSkillSelection();
      }
    });
  }, [
    applySelectedSkillIds,
    applySyncedSkillIds,
    currentAgent,
    readAgent,
    resolveAgentSkillIds,
    updateAgent,
  ]);

  useEffect(() => {
    if (!pendingAgentId || !currentAgent || currentAgent.id !== pendingAgentId) {
      return;
    }
    const normalizedSkillIds = resolveAgentSkillIds(currentAgent);
    if (!hasLocalInteractionRef.current) {
      applySelectedSkillIds(normalizedSkillIds);
    }
    applySyncedSkillIds(normalizedSkillIds);
    if (skillsSnapshotReady || Array.isArray(currentAgent.skills)) {
      preparedAgentIdRef.current = currentAgent.id;
      setPendingAgentId(null);
      if (!equalSkillIds(selectedSkillIdsRef.current, syncedSkillIdsRef.current)) {
        syncLatestSkillSelection();
      }
    }
  }, [
    applySelectedSkillIds,
    applySyncedSkillIds,
    currentAgent,
    pendingAgentId,
    resolveAgentSkillIds,
    syncLatestSkillSelection,
    skillsSnapshotReady,
  ]);

  useEffect(() => {
    if (!currentAgent || preparedAgentIdRef.current !== currentAgent.id || syncInFlightRef.current) {
      return;
    }
    const normalizedSkillIds = resolveAgentSkillIds(currentAgent);
    applySyncedSkillIds(normalizedSkillIds);
    applySelectedSkillIds(normalizedSkillIds);
  }, [applySelectedSkillIds, applySyncedSkillIds, currentAgent, resolveAgentSkillIds]);

  useEffect(() => {
    syncLatestSkillSelection();
  }, [selectedSkillIds, syncLatestSkillSelection]);

  const prepare = useCallback(() => {
    if (!currentAgent) {
      return;
    }
    if (!skillsSnapshotReady && !skillsInitialLoading) {
      void fetchSkills();
    }
    if (preparedAgentIdRef.current === currentAgent.id) {
      return;
    }
    setPendingAgentId(currentAgent.id);
  }, [currentAgent, fetchSkills, skillsInitialLoading, skillsSnapshotReady]);

  const resetSession = useCallback(() => {
    syncRequestSeqRef.current += 1;
    preparedAgentIdRef.current = null;
    setPendingAgentId(null);
    syncInFlightRef.current = false;
    hasLocalInteractionRef.current = false;
    applySelectedSkillIds([]);
    applySyncedSkillIds([]);
  }, [applySelectedSkillIds, applySyncedSkillIds]);

  const toggleSkill = useCallback((skillId: string, checked: boolean) => {
    if (!currentAgent) {
      return;
    }

    const previousSelectedSkillIds = selectedSkillIdsRef.current;
    const nextSelectedSkillIds = checked
      ? (previousSelectedSkillIds.includes(skillId) ? previousSelectedSkillIds : [...previousSelectedSkillIds, skillId])
      : previousSelectedSkillIds.filter((id) => id !== skillId);

    if (equalSkillIds(nextSelectedSkillIds, previousSelectedSkillIds)) {
      return;
    }

    hasLocalInteractionRef.current = true;
    applySelectedSkillIds(nextSelectedSkillIds);
  }, [applySelectedSkillIds, currentAgent]);

  return {
    selectedSkillIds,
    availableSkillOptions,
    skillsLoading: !skillsSnapshotReady && skillsInitialLoading,
    prepare,
    resetSession,
    toggleSkill,
  };
}
