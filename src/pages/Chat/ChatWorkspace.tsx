import { memo, useCallback, useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '@/stores/chat';
import { useTeamsStore } from '@/stores/teams';
import { buildSessionIdentityKey, sessionIdentitiesEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import { Button } from '@/components/ui/button';
import { ChatShell } from './components/ChatShell';
import { ChatOffline } from './components/ChatOffline';
import { ChatHeaderBar } from './components/ChatHeaderBar';
import type { ChatListHandle } from './components/ChatList';
import { openChatRuntimeSurface, useChatSidePanelController, type ChatRuntimeSurfaceDescriptor } from './useChatSidePanelController';
import { useChatWindowDockController } from './useChatWindowDockController';
import { selectChatSessionRecordKey, useChatRuntime } from './chat-session';
import type { ChatMessageSlots } from './ChatMessages';

export const ChatWorkspace = memo(function ChatWorkspace({ isActive, enabled, sessionIdentity, viewportPaneRef, input, slots, onRuntimeSendMessage, onRuntimeOpenLink }: {
  isActive: boolean;
  enabled: boolean;
  sessionIdentity: SessionIdentity | null;
  viewportPaneRef: RefObject<ChatListHandle | null>;
  input: ReactNode;
  slots: ChatMessageSlots;
  onRuntimeSendMessage: (text: string) => Promise<void>;
  onRuntimeOpenLink: (url: string) => Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const location = useLocation();
  const navigate = useNavigate();
  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const { runtime, directory } = useChatRuntime();
  const { hasItems, designTeamId, teamGraphTeamId, teamGraphRunId, catalogStatus, catalogError } = useChatStore(useShallow((state) => {
    const record = state.loadedSessions[selectChatSessionRecordKey(state)];
    const ownership = sessionIdentity && record?.meta.sessionIdentity
      && sessionIdentitiesEqual(sessionIdentity, record.meta.sessionIdentity) ? record.meta.ownership : null;
    return {
      hasItems: Boolean(record?.items.length),
      designTeamId: ownership?.kind === 'team' && ownership.roleId === 'leader' ? ownership.teamId : null,
      teamGraphTeamId: ownership?.kind === 'team' ? ownership.teamId : null,
      teamGraphRunId: ownership?.kind === 'team' ? ownership.teamRunId : null,
      catalogStatus: state.sessionRuntimeCatalog.status,
      catalogError: state.sessionRuntimeCatalog.error,
    };
  }));
  const designTeamKnown = useTeamsStore((state) => Boolean(designTeamId && state.teams.some((team) => team.id === designTeamId)));
  const {
    sidePanelOpen: sidePanelIntentOpen,
    sidePanelWidth: sidePanelRenderWidth,
    sidePanelPreferredWidth,
    activeSidePanelTab,
    artifactWorkbenchFullscreen,
    openSidePanel: openSidePanelDomain,
    setActiveSidePanelTab,
    closeSidePanel: closeSidePanelDomain,
    setSidePanelWidth,
    toggleArtifactWorkbenchFullscreen,
    runtimeSurface,
    sidePanelInline,
    boardChatDock,
    boardFullscreen,
    setBoardChatDock,
    setBoardFullscreen,
  } = useChatSidePanelController(enabled, chatLayoutRef, sessionIdentity ?? undefined);
  const openedDesignNavigationRef = useRef<string | null>(null);
  useEffect(() => {
    const surface = (location.state as { teamDesignSurface?: Extract<ChatRuntimeSurfaceDescriptor, { kind: 'team-graph' }> } | null)?.teamDesignSurface;
    if (!surface || openedDesignNavigationRef.current === location.key || !enabled || !sessionIdentity
      || surface.teamId !== teamGraphTeamId || surface.runId !== teamGraphRunId
      || buildSessionIdentityKey(surface.sourceSessionIdentity) !== buildSessionIdentityKey(sessionIdentity)) return;
    openedDesignNavigationRef.current = location.key;
    openChatRuntimeSurface(surface);
  }, [location.key, location.state, enabled, sessionIdentity, teamGraphTeamId, teamGraphRunId]);
  const chatWindowDock = useChatWindowDockController({
    enabled,
    panelOpen: sidePanelIntentOpen,
    inline: sidePanelInline,
    preferredWidth: sidePanelPreferredWidth,
    renderWidth: sidePanelRenderWidth,
    artifactWorkbenchFullscreen,
    chatLayoutRef,
    openPanel: openSidePanelDomain,
    closePanel: closeSidePanelDomain,
    setPanelWidth: setSidePanelWidth,
  });
  const openArtifacts = useCallback(() => setActiveSidePanelTab('artifacts'), [setActiveSidePanelTab]);
  const handleComposerWheel = useCallback((deltaY: number) => {
    viewportPaneRef.current?.scrollByWheelDelta(deltaY);
  }, [viewportPaneRef]);
  const handleComposerGeometryChange = useCallback(() => {
    viewportPaneRef.current?.notifyComposerGeometryChanged();
  }, [viewportPaneRef]);
  const sessionRuntimeInitializing = !hasItems && (runtime.state === 'resolving'
    || runtime.state === 'starting'
    || (runtime.state === 'unselected' && directory.status !== 'error'
      && (catalogStatus === 'idle' || catalogStatus === 'loading')));
  if (sessionRuntimeInitializing) {
    return <ChatOffline title={t('runtimePreparing.title')} description={t('runtimePreparing.description')} tone="loading" />;
  }
  if (runtime.state === 'unselected' && !hasItems && (directory.status === 'error' || catalogStatus === 'error')) {
    return <ChatOffline title={t('runtimePreparationFailed.title')} description={directory.error || catalogError || t('runtimePreparationFailed.description')} />;
  }
  if (runtime.state !== 'ready' && !hasItems) {
    return <ChatOffline title={t('runtimeUnavailable.title')}
      description={(runtime.state === 'unavailable' ? runtime.error : catalogError) || t('runtimeUnavailable.description')} />;
  }
  return <>
    {isActive && designTeamId && !designTeamKnown ? (
      <div role="alert" className="flex items-center gap-2 p-3 text-sm text-destructive">
        {t('teams:chat.teamNotFound')}
        <Button variant="outline" size="sm" onClick={() => navigate('/teams')}>{t('teams:chat.backToList')}</Button>
      </div>
    ) : null}
    <ChatShell
      chatLayoutRef={chatLayoutRef}
      sidePanelPhase={chatWindowDock.phase}
      sidePanelMode={chatWindowDock.sidePanelMode}
      sidePanelWidth={chatWindowDock.sidePanelWidth}
      sidePanelMainWidth={chatWindowDock.sidePanelMainWidth}
      sidePanelVisible={chatWindowDock.sidePanelVisible}
      artifactWorkbenchFullscreen={artifactWorkbenchFullscreen}
      boardChatDock={boardChatDock}
      boardFullscreen={boardFullscreen}
      onSidePanelResize={chatWindowDock.resizeSidePanelWidth}
      onSidePanelResizeCommit={chatWindowDock.commitSidePanelWidth}
      onComposerWheel={handleComposerWheel}
      onComposerGeometryChange={handleComposerGeometryChange}
      input={input}
      isEmptyState={slots.isEmptyState}
      emptyState={slots.emptyState}
      errorBanner={slots.errorBanner}
      approvalDock={slots.approvalDock}
      header={<ChatHeaderBar {...slots.headerProps} sidePanelOpen={chatWindowDock.sidePanelExpanded} onToggleSidePanel={chatWindowDock.toggleSidePanel} />}
      viewportPane={slots.viewportPane(openArtifacts)}
      sidePanel={slots.sidePanel({
        mode: chatWindowDock.sidePanelMode,
        width: chatWindowDock.sidePanelWidth,
        activeTab: activeSidePanelTab,
        runtimeSurface,
        onBoardChatDockChange: setBoardChatDock,
        onBoardFullscreenChange: setBoardFullscreen,
        onSendMessage: onRuntimeSendMessage,
        onOpenLink: onRuntimeOpenLink,
        artifactWorkbenchFullscreen,
        onTabChange: setActiveSidePanelTab,
        onClose: chatWindowDock.closeSidePanel,
        onToggleArtifactWorkbenchFullscreen: toggleArtifactWorkbenchFullscreen,
      }, openArtifacts)}
    />
  </>;
});
