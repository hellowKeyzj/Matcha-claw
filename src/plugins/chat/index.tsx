import { traceLog } from '@/lib/trace-logger';
/**
 * Chat Page
 * Native React implementation using runtime-host session APIs.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ChatStoreState } from '@/plugins/chat/store';
import { selectCurrentChatSendGate } from '@/plugins/chat/store/selectors';
import { useGatewayStore } from '@/plugins/runtime/store';
import { useSubagentsStore } from '@/plugins/agents/stores/subagents';
import { sessionIdentitiesEqual } from '@/types/desktop/runtime-address';
import { invokeIpc } from '@/lib/api-client';
import type { ChatListHandle } from '@/plugins/chat/components/ChatList';
import type { ChatInputHandle } from '@/plugins/chat/ChatInput';
import { useChatInit } from '@/plugins/chat/useChatInit';
import { useChatObservation } from '@/plugins/chat/useChatObservation';
import { selectChatSelection, useChatRuntime } from '@/plugins/chat/chat-session';
import { ChatComposer } from '@/plugins/chat/ChatComposer';
import { ChatMessages } from '@/plugins/chat/ChatMessages';
import { ChatWorkspace } from '@/plugins/chat/ChatWorkspace';

interface ChatProps { isActive?: boolean; }

export function Chat({ isActive = true }: ChatProps) {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const navigate = useNavigate();
  const { currentWorkspaceIdentity, connectorSessionIdentity } = useChatStore(useShallow(selectChatSelection));
  const { runtime: currentConversationRuntime } = useChatRuntime();
  const currentChatRuntimeAvailable = currentConversationRuntime.state === 'ready';
  const workspaceActive = isActive;
  const chatSideEffectsActive = workspaceActive && currentChatRuntimeAvailable;
  const { switchSession, openAgentConversation, bootstrapSessionRuntime, loadHistory, loadSessions, cleanupEmptySession, sendMessage } = useChatStore(useShallow((state) => ({
    switchSession: state.switchSession, openAgentConversation: state.openAgentConversation, bootstrapSessionRuntime: state.bootstrapSessionRuntime,
    loadHistory: state.loadHistory, loadSessions: state.loadSessions, cleanupEmptySession: state.cleanupEmptySession, sendMessage: state.sendMessage,
  })));
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const questionRecoveryKey = useGatewayStore((state) => `${state.status.connectedAt ?? ''}:${state.runtimeHost.restartCount}`);
  const viewportPaneRef = useRef<ChatListHandle>(null);
  const composerRef = useRef<ChatInputHandle>(null);
  useChatObservation(chatSideEffectsActive, connectorSessionIdentity);
  const chatRuntimeBranch = currentConversationRuntime.state === 'resolving' ? 'starting' : currentConversationRuntime.state;
  useEffect(() => {
    traceLog(() => [JSON.stringify({ prefix: '[startup-trace]', traceScope: 'renderer-boundary', source: 'chat-page', phase: chatRuntimeBranch })]);
  }, [chatRuntimeBranch]);
  useChatInit({
    isActive: workspaceActive,
    locationSearch: location.search,
    navigate,
    switchSession,
    openAgentConversation,
    bootstrapSessionRuntime,
    loadAgents,
    loadSessions,
    loadHistory,
    cleanupEmptySession,
  });
  const handleSendMessage = useCallback(async (
    text: string,
    attachments?: Parameters<typeof sendMessage>[1],
  ) => {
    viewportPaneRef.current?.prepareCurrentLatestBottomAlign();
    return sendMessage(text, attachments);
  }, [sendMessage]);
  const runtimeActionOwner = useMemo(() => ({ identity: currentWorkspaceIdentity, enabled: chatSideEffectsActive, recoveryKey: questionRecoveryKey }), [currentWorkspaceIdentity, chatSideEffectsActive, questionRecoveryKey]);
  const runtimeActionOwnerRef = useRef<typeof runtimeActionOwner | null>(null);
  useLayoutEffect(() => {
    runtimeActionOwnerRef.current = runtimeActionOwner.enabled ? runtimeActionOwner : null;
    const retireOnSelectionChange = (state: ChatStoreState) => {
      const conversation = state.currentConversation;
      const identity = conversation?.kind === 'session' ? conversation.sessionIdentity
        : conversation?.kind === 'draft' ? null : state.loadedSessions[state.currentSessionKey]?.meta.sessionIdentity;
      if (!runtimeActionOwner.identity || !identity || !sessionIdentitiesEqual(runtimeActionOwner.identity, identity)) runtimeActionOwnerRef.current = null;
    };
    retireOnSelectionChange(useChatStore.getState());
    const unsubscribe = useChatStore.subscribe(retireOnSelectionChange);
    return () => { runtimeActionOwnerRef.current = null; unsubscribe(); };
  }, [runtimeActionOwner]);
  const handleRuntimeSendMessage = useCallback(async (text: string) => {
    const gate = selectCurrentChatSendGate(useChatStore.getState());
    if (runtimeActionOwnerRef.current !== runtimeActionOwner
      || !runtimeActionOwner.identity || !gate.canSend || gate.kind !== 'session'
      || !sessionIdentitiesEqual(runtimeActionOwner.identity, gate.sessionIdentity)) {
      throw new Error(t('board.sendUnavailable', { defaultValue: 'This session changed or cannot receive a message right now.' }));
    }
    const result = await handleSendMessage(text);
    if (!result.accepted) throw new Error(result.error || t('board.sendUnavailable', { defaultValue: 'This session changed or cannot receive a message right now.' }));
  }, [handleSendMessage, runtimeActionOwner, t]);
  const handleRuntimeOpenLink = useCallback(async (url: string) => {
    if (runtimeActionOwnerRef.current !== runtimeActionOwner) return;
    await invokeIpc('shell:openExternal', url);
  }, [runtimeActionOwner]);
  return (
    <ChatComposer isActive={workspaceActive} composerRef={composerRef} viewportPaneRef={viewportPaneRef}>
      {(renderInput) => <ChatMessages isActive={workspaceActive} renderInput={renderInput} composerRef={composerRef} viewportPaneRef={viewportPaneRef}
        onRuntimeSendMessage={handleRuntimeSendMessage} onRuntimeOpenLink={handleRuntimeOpenLink}>
        {(slots) => <ChatWorkspace
          isActive={workspaceActive}
          enabled={chatSideEffectsActive}
          sessionIdentity={currentWorkspaceIdentity}
          viewportPaneRef={viewportPaneRef}
          slots={slots}
          onRuntimeSendMessage={handleRuntimeSendMessage}
          onRuntimeOpenLink={handleRuntimeOpenLink}
        />}
      </ChatMessages>}
    </ChatComposer>
  );
}

export default Chat;
