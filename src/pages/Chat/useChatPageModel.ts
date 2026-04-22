import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '@/stores/chat';
import {
  selectChatPageActions,
  selectChatPageRuntimeState,
  selectChatPageSessionState,
  selectChatPageViewState,
} from '@/stores/chat/selectors';
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

  const sessionState = useChatStore(useShallow(selectChatPageSessionState));
  const viewState = useChatStore(useShallow(selectChatPageViewState));
  const runtimeState = useChatStore(useShallow(selectChatPageRuntimeState));
  const actions = useChatStore(useShallow(selectChatPageActions));
  const agents = useSubagentsStore((s) => (Array.isArray(s.agentsResource.data) ? s.agentsResource.data : []));
  const loadAgents = useSubagentsStore((s) => s.loadAgents);
  const updateAgent = useSubagentsStore((s) => s.updateAgent);
  const skills = useSkillsStore((s) => s.skills);
  const skillsSnapshotReady = useSkillsStore((s) => s.snapshotReady);
  const skillsInitialLoading = useSkillsStore((s) => s.initialLoading);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const userAvatarDataUrl = useSettingsStore((s) => s.userAvatarDataUrl);

  const currentAgentId = parseAgentIdFromSessionKey(sessionState.currentSessionKey);
  const currentAgent = agents.find((item) => item.id === currentAgentId);
  const waitingApproval = runtimeState.approvalStatus === 'awaiting_approval';

  return {
    isGatewayRunning,
    gatewayRpc,
    sessionState,
    viewState,
    runtimeState,
    actions,
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
  };
}
