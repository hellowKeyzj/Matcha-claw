import { memo, Suspense, useCallback, useMemo, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useContributions } from '@/plugin-host/react';
import { useChatStore } from '@/plugins/chat/store';
import { sessionIdentitiesEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import { ChatShell } from '@/plugins/chat/components/ChatShell';
import { ChatOffline } from '@/plugins/chat/components/ChatOffline';
import { ChatHeaderBar } from '@/plugins/chat/components/ChatHeaderBar';
import type { ChatListHandle } from '@/plugins/chat/components/ChatList';
import { useChatSidePanelController } from '@/plugins/chat/useChatSidePanelController';
import { useChatWindowDockController } from '@/plugins/chat/useChatWindowDockController';
import { selectChatSessionRecordKey, useChatRuntime } from '@/plugins/chat/chat-session';
import { chatWorkspaceContent } from './extensions';
import type { ChatMessageSlots } from '@/plugins/chat/ChatMessages';

export const ChatWorkspace = memo(function ChatWorkspace({ isActive, enabled, sessionIdentity, viewportPaneRef, slots, onRuntimeSendMessage, onRuntimeOpenLink }: {
  isActive: boolean;
  enabled: boolean;
  sessionIdentity: SessionIdentity | null;
  viewportPaneRef: RefObject<ChatListHandle | null>;
  slots: ChatMessageSlots;
  onRuntimeSendMessage: (text: string) => Promise<void>;
  onRuntimeOpenLink: (url: string) => Promise<void>;
}) {
  const { t } = useTranslation('chat');
  const chatLayoutRef = useRef<HTMLDivElement>(null);
  const { runtime, directory } = useChatRuntime();
  const contributions = useContributions(chatWorkspaceContent);
  const content = useMemo(() => [...contributions].sort((a, b) => a.order - b.order), [contributions]);
  const { hasItems, ownership, catalogStatus, catalogError } = useChatStore(useShallow((state) => {
    const record = state.loadedSessions[selectChatSessionRecordKey(state)];
    return {
      hasItems: Boolean(record?.items.length),
      ownership: sessionIdentity && record?.meta.sessionIdentity
        && sessionIdentitiesEqual(sessionIdentity, record.meta.sessionIdentity) ? record.meta.ownership : null,
      catalogStatus: state.sessionRuntimeCatalog.status,
      catalogError: state.sessionRuntimeCatalog.error,
    };
  }));
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
    panelContent,
    panelLayout,
    setPanelLayout,
    openPanel,
    sidePanelInline,
    registerCloseHandler,
    requestClose,
  } = useChatSidePanelController(enabled, chatLayoutRef, sessionIdentity ?? undefined);
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
    requestClose,
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
  const offline = sessionRuntimeInitializing
    ? <ChatOffline title={t('runtimePreparing.title')} tone="loading" />
    : runtime.state === 'unselected' && !hasItems && (directory.status === 'error' || catalogStatus === 'error')
      ? <ChatOffline title={t('runtimePreparationFailed.title')} description={directory.error || catalogError || t('runtimePreparationFailed.description')} />
      : runtime.state !== 'ready' && !hasItems
        ? <ChatOffline title={t('runtimeUnavailable.title')}
          description={(runtime.state === 'unavailable' ? runtime.error : catalogError) || t('runtimeUnavailable.description')} />
        : null;
  return <>
    {content.map(({ id, component: Content }) => <Suspense key={id} fallback={null}>
      <Content isActive={isActive} enabled={enabled} visible={!offline} sessionIdentity={sessionIdentity} ownership={ownership} openPanel={openPanel} />
    </Suspense>)}
    {offline ?? <ChatShell
      chatLayoutRef={chatLayoutRef}
      sidePanelPhase={chatWindowDock.phase}
      sidePanelMode={chatWindowDock.sidePanelMode}
      sidePanelWidth={chatWindowDock.sidePanelWidth}
      sidePanelMainWidth={chatWindowDock.sidePanelMainWidth}
      sidePanelVisible={chatWindowDock.sidePanelVisible}
      artifactWorkbenchFullscreen={artifactWorkbenchFullscreen}
      panelLayout={panelLayout}
      onSidePanelResize={chatWindowDock.resizeSidePanelWidth}
      onSidePanelResizeCommit={chatWindowDock.commitSidePanelWidth}
      onComposerWheel={handleComposerWheel}
      onComposerGeometryChange={handleComposerGeometryChange}
      input={slots.input}
      isEmptyState={slots.isEmptyState}
      emptyState={slots.emptyState}
      header={<ChatHeaderBar {...slots.headerProps} sidePanelOpen={chatWindowDock.sidePanelExpanded} onToggleSidePanel={chatWindowDock.toggleSidePanel} />}
      viewportPane={slots.viewportPane(openArtifacts)}
      sidePanel={slots.sidePanel({
        mode: chatWindowDock.sidePanelMode,
        width: chatWindowDock.sidePanelWidth,
        activeTab: activeSidePanelTab,
        content: panelContent,
        layout: panelLayout,
        onLayoutChange: setPanelLayout,
        registerCloseHandler,
        onSendMessage: onRuntimeSendMessage,
        onOpenLink: onRuntimeOpenLink,
        artifactWorkbenchFullscreen,
        onTabChange: setActiveSidePanelTab,
        onClose: chatWindowDock.closeSidePanel,
        onToggleArtifactWorkbenchFullscreen: toggleArtifactWorkbenchFullscreen,
      }, openArtifacts)}
    />}
  </>;
});
