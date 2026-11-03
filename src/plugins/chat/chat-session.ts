import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ChatStoreState } from '@/plugins/chat/store';
import { deriveSessionRecord } from '@/plugins/chat/store/session-presentation';
import { createEmptySessionRecord } from '@/plugins/chat/store/store-state-helpers';
import { buildCurrentConversationFromSessionRecord, resolveCurrentConversationRuntimeState } from '@/plugins/chat/store/session-runtime-graph';
import { useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import { selectAgentsResource, useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { runtimeEndpointsEqual } from '@/types/desktop/runtime-address';

const EMPTY_SESSION = createEmptySessionRecord();

export function selectChatSessionRecordKey(state: ChatStoreState) {
  return state.currentSessionKey
    || (state.currentConversation?.kind === 'session' ? state.currentConversation.sessionRecordKey : '');
}

export function selectChatSession(state: ChatStoreState) {
  const key = selectChatSessionRecordKey(state);
  return deriveSessionRecord((key && state.loadedSessions[key]) || EMPTY_SESSION);
}

export function selectChatComposerFacts(state: ChatStoreState) {
  const record = selectChatSession(state);
  return {
    sessionIdentity: record.meta.sessionIdentity,
    endpointSessionId: record.meta.endpointSessionId,
    ownership: record.meta.ownership,
    goal: record.meta.goal,
    modelState: record.meta.modelState,
    historyStatus: record.meta.historyStatus,
    contextTokens: record.contextTokens,
    runPhase: record.runtime.runPhase,
    activeRunId: record.runtime.activeRunId,
    imageGenerationActive: record.runtime.imageGeneration?.active === true,
  };
}

export function selectChatSelection(state: ChatStoreState) {
  const currentConversation = state.currentConversation;
  const currentSessionRecordKey = selectChatSessionRecordKey(state);
  const meta = state.loadedSessions[currentSessionRecordKey]?.meta ?? EMPTY_SESSION.meta;
  return {
    currentConversation,
    currentSessionRecordKey,
    currentComposerDraftKey: currentConversation?.kind === 'session' ? currentSessionRecordKey
      : currentConversation?.kind === 'draft' ? `${currentConversation.runtimeScopeKey}:agent:${currentConversation.agentId}:draft` : '',
    currentWorkspaceIdentity: currentConversation?.kind === 'session' ? currentConversation.sessionIdentity : meta.sessionIdentity,
    currentWorkspaceDraftId: currentConversation?.kind === 'draft' ? currentConversation.id : currentConversation?.promotedDraft?.id,
    currentWorkspacePromotion: currentConversation?.kind === 'session' ? currentConversation.promotedDraft : undefined,
    connectorSessionIdentity: meta.sessionIdentity,
    currentAgentId: currentConversation?.agentId ?? meta.agentId ?? '',
  };
}

export function useChatRuntime() {
  const directory = useRuntimeEndpointsStore(useShallow((state) => ({
    status: state.status, error: state.error, endpoints: state.endpoints,
  })));
  const runtime = useChatStore(useShallow((state) => resolveCurrentConversationRuntimeState({
    currentConversation: state.currentConversation ?? buildCurrentConversationFromSessionRecord(selectChatSession(state)),
    graph: state.sessionRuntimeGraph,
    directoryStatus: directory.status,
    directoryError: directory.error,
    directoryEndpoints: directory.endpoints,
  })));
  return { runtime, directory };
}

export function isChatRuntimePreparing(
  state: ChatStoreState,
  runtime: ReturnType<typeof useChatRuntime>['runtime'],
  directoryStatus: ReturnType<typeof useChatRuntime>['directory']['status'],
): boolean {
  const hasItems = Boolean(state.loadedSessions[selectChatSessionRecordKey(state)]?.items.length);
  const catalogStatus = state.sessionRuntimeCatalog.status;
  return !hasItems && (runtime.state === 'resolving'
    || runtime.state === 'starting'
    || (runtime.state === 'unselected' && directoryStatus !== 'error'
      && (catalogStatus === 'idle' || catalogStatus === 'loading')));
}

export function useChatAgent() {
  const { currentConversation, currentAgentId } = useChatStore(useShallow(selectChatSelection));
  const agents = useSubagentsStore((state) => selectAgentsResource(state, currentConversation?.endpoint ?? null).data);
  const managementScope = useSubagentsStore((state) => state.managementScope);
  const currentAgent = currentAgentId && managementScope && currentConversation
    && runtimeEndpointsEqual(managementScope.endpoint, currentConversation.endpoint)
    ? agents.find((agent) => agent.id === currentAgentId) : undefined;
  return { agents, managementScope, currentAgent };
}
