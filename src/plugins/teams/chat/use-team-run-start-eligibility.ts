import { useCallback } from 'react';
import { selectChatComposerFacts, selectChatSelection, useChatRuntime } from '@/plugins/chat/chat-session';
import { useChatStore, type ChatStoreState } from '@/plugins/chat/store';
import { selectCurrentChatSendGate } from '@/plugins/chat/store/selectors';
import { resolveCurrentConversationRuntimeState } from '@/plugins/chat/store/session-runtime-graph';
import { getSessionApprovalStatus } from '@/plugins/chat/store/store-state-helpers';
import { isRunActive } from '@/plugins/chat/store/types';
import { isRuntimeEndpointReady, supportsRuntimeEndpointCapabilityFamily, useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import { runtimeEndpointsEqual, sessionIdentitiesEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { RuntimeEndpointSummary } from '@/types/runtime-topology';
import { useTeamsStore } from '../store';

function canStartFromCurrentChat(state: ChatStoreState, teamId: string | null, runId: string | null, identity: SessionIdentity | null): boolean {
  const { currentConversation, currentSessionRecordKey, connectorSessionIdentity } = selectChatSelection(state);
  if (!identity || !teamId || !runId || currentConversation?.kind !== 'session'
    || currentSessionRecordKey !== currentConversation.sessionRecordKey || !connectorSessionIdentity
    || !sessionIdentitiesEqual(identity, currentConversation.sessionIdentity)
    || !sessionIdentitiesEqual(identity, connectorSessionIdentity)) return false;
  const { ownership, runPhase, imageGenerationActive } = selectChatComposerFacts(state);
  const sendGate = selectCurrentChatSendGate(state);
  return ownership?.kind === 'team' && ownership.roleId === 'leader' && ownership.teamId === teamId && ownership.teamRunId === runId
    && !isRunActive({ runPhase }) && !imageGenerationActive
    && getSessionApprovalStatus(state, currentSessionRecordKey) !== 'awaiting_approval'
    && sendGate.canSend && sendGate.kind === 'session' && sendGate.sessionKey === currentSessionRecordKey
    && sessionIdentitiesEqual(sendGate.sessionIdentity, identity);
}

function canStartTargetRun(state: ReturnType<typeof useTeamsStore.getState>, endpoints: readonly RuntimeEndpointSummary[], teamId: string | null, runId: string | null, identity: SessionIdentity | null): boolean {
  if (!teamId || !runId || !identity || !state.teams.some((team) => team.id === teamId)) return false;
  const record = state.designByRunId[runId];
  const snapshot = record?.snapshot;
  if (record?.mutationPending || snapshot?.teamId !== teamId || snapshot.runId !== runId || snapshot.startGate.status === 'started'
    || !snapshot.roles.some((role) => role.roleId === 'leader' && role.runId === runId && sessionIdentitiesEqual(role.sessionIdentity, identity))) return false;
  return endpoints.some((entry) => runtimeEndpointsEqual(entry.endpointRef, identity.endpoint)
    && isRuntimeEndpointReady(entry) && supportsRuntimeEndpointCapabilityFamily(entry, 'team'));
}

export function useTeamRunStartEligibility(teamId: string | null, runId: string | null, identity: SessionIdentity | null) {
  const { runtime, directory } = useChatRuntime();
  const chatEligible = useChatStore((state) => canStartFromCurrentChat(state, teamId, runId, identity));
  const targetEligible = useTeamsStore((state) => canStartTargetRun(state, directory.endpoints, teamId, runId, identity));
  const canStartRunNow = useCallback(() => {
    const chat = useChatStore.getState();
    const endpoints = useRuntimeEndpointsStore.getState();
    return canStartFromCurrentChat(chat, teamId, runId, identity)
      && canStartTargetRun(useTeamsStore.getState(), endpoints.endpoints, teamId, runId, identity)
      && resolveCurrentConversationRuntimeState({
        currentConversation: chat.currentConversation, graph: chat.sessionRuntimeGraph,
        directoryStatus: endpoints.status, directoryError: endpoints.error, directoryEndpoints: endpoints.endpoints,
      }).state === 'ready';
  }, [teamId, runId, identity]);
  return { canStartRun: runtime.state === 'ready' && chatEligible && targetEligible, canStartRunNow };
}
