import type { NavigateFunction } from 'react-router-dom';
import { useChatStore } from '@/plugins/chat/store';
import { showWorkspaceChat } from '@/plugins/workspace/actions';
import { selectTeamSessionRoles } from './session-projection';
import { useTeamsStore } from './store';

type TeamSessionNavigation = Pick<ReturnType<typeof useTeamsStore.getState>,
  'createRun' | 'setActiveRun' | 'syncRunList' | 'refreshSnapshot'>;

export function useTeamSessionNavigation<T>(selector: (state: TeamSessionNavigation) => T): T {
  return useTeamsStore(selector);
}

export async function openTeamRun(navigate: NavigateFunction, teamId: string, runId?: string): Promise<void> {
  const conversation = useChatStore.getState().currentConversation;
  let state = useTeamsStore.getState();
  let targetRunId = runId ?? state.teams.find((team) => team.id === teamId)?.activeRunId;
  let leader = selectTeamSessionRoles(state, teamId, targetRunId).find((role) => role.roleId === 'leader' && role.runId === targetRunId);
  if (!leader) {
    await state.syncRunList(teamId);
    if (useChatStore.getState().currentConversation !== conversation) return;
    state = useTeamsStore.getState();
    targetRunId ??= state.teams.find((team) => team.id === teamId)?.activeRunId;
    leader = selectTeamSessionRoles(state, teamId, targetRunId).find((role) => role.roleId === 'leader' && role.runId === targetRunId);
  }
  if (targetRunId && !leader) {
    await state.refreshSnapshot(teamId, { runId: targetRunId });
    if (useChatStore.getState().currentConversation !== conversation) return;
    state = useTeamsStore.getState();
    leader = selectTeamSessionRoles(state, teamId, targetRunId).find((role) => role.roleId === 'leader' && role.runId === targetRunId);
  }
  state.setActiveTeam(teamId);
  if (targetRunId && state.teams.find((team) => team.id === teamId)?.activeRunId !== targetRunId) state.setActiveRun(teamId, targetRunId);
  showWorkspaceChat();
  if (leader) useChatStore.getState().openSessionIdentity({ sessionIdentity: leader.sessionIdentity, endpointSessionId: leader.endpointSessionId });
  await navigate('/', { state: leader
    ? { teamDesignSurface: { kind: 'team-graph', sourceSessionIdentity: leader.sessionIdentity, teamId, runId: leader.runId } }
    : { teamsSidebar: true } });
}
