import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '@/stores/chat';
import { selectChatPageState } from '@/stores/chat/selectors';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useSubagentsStore } from '@/stores/subagents';
import { useSettingsStore } from '@/stores/settings';

function parseAgentIdFromSessionKey(sessionKey: string): string {
  const matched = sessionKey.match(/^agent:([^:]+):/i);
  return matched?.[1] ?? 'main';
}

export function useChatPageModel() {
  const gatewayStatus = useGatewayStore((s) => s.status);
  const gatewayRpc = useGatewayStore((s) => s.rpc);
  const isGatewayRunning = gatewayStatus.state === 'running';

  const chatState = useChatStore(useShallow(selectChatPageState));
  const agents = useSubagentsStore((s) => s.agents);
  const loadAgents = useSubagentsStore((s) => s.loadAgents);
  const updateAgent = useSubagentsStore((s) => s.updateAgent);
  const skills = useSkillsStore((s) => s.skills);
  const skillsSnapshotReady = useSkillsStore((s) => s.snapshotReady);
  const skillsInitialLoading = useSkillsStore((s) => s.initialLoading);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const userAvatarDataUrl = useSettingsStore((s) => s.userAvatarDataUrl);

  const currentAgentId = parseAgentIdFromSessionKey(chatState.currentSessionKey);
  const currentAgent = agents.find((item) => item.id === currentAgentId);
  const waitingApproval = chatState.approvalStatus === 'awaiting_approval';

  return {
    isGatewayRunning,
    gatewayRpc,
    agents,
    loadAgents,
    updateAgent,
    skills,
    skillsSnapshotReady,
    skillsInitialLoading,
    fetchSkills,
    userAvatarDataUrl,
    currentAgentId,
    currentAgent,
    waitingApproval,
    ...chatState,
  };
}
