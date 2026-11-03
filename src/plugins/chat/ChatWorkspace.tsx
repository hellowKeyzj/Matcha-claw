import { memo, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useContributions } from '@/plugin-host/react';
import { useChatStore } from '@/plugins/chat/store';
import { useLayoutStore } from '@/app/layout/store';
import { CHAT_WORKSPACE_LAYOUT, clampChatSidePanelWidth } from '@/app/layout/workspace';
import { sessionIdentitiesEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import { ChatShell } from '@/plugins/chat/components/ChatShell';
import { ChatOffline } from '@/plugins/chat/components/ChatOffline';
import { ChatHeaderBar } from '@/plugins/chat/components/ChatHeaderBar';
import type { ChatListHandle } from '@/plugins/chat/components/ChatList';
import { useChatWindowDockController } from '@/plugins/chat/useChatWindowDockController';
import { isChatRuntimePreparing, selectChatSessionRecordKey, useChatRuntime } from '@/plugins/chat/chat-session';
import { useWorkspace } from '@/plugins/workspace/context';
import { workspacePanels } from '@/plugins/workspace/extensions';
import { chatWorkspaceContent } from './extensions';
import type { ChatMessageSlots } from '@/plugins/chat/ChatMessages';

function readPanelWidth(): number {
  try {
    const width = Number(window.sessionStorage.getItem('chat:side-panel-width'));
    if (Number.isFinite(width) && width > 0) return width;
  } catch { /* Storage may be unavailable. */ }
  return CHAT_WORKSPACE_LAYOUT.sidePanelDefaultWidth;
}

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
  const workspace = useWorkspace();
  const panels = useContributions(workspacePanels);
  const contributions = useContributions(chatWorkspaceContent);
  const content = useMemo(() => [...contributions].sort((a, b) => a.order - b.order), [contributions]);
  const { hasItems, ownership, catalogStatus, catalogError, sessionRuntimeInitializing } = useChatStore(useShallow((state) => {
    const record = state.loadedSessions[selectChatSessionRecordKey(state)];
    return {
      hasItems: Boolean(record?.items.length),
      ownership: sessionIdentity && record?.meta.sessionIdentity
        && sessionIdentitiesEqual(sessionIdentity, record.meta.sessionIdentity) ? record.meta.ownership : null,
      catalogStatus: state.sessionRuntimeCatalog.status,
      catalogError: state.sessionRuntimeCatalog.error,
      sessionRuntimeInitializing: isChatRuntimePreparing(state, runtime, directory.status),
    };
  }));
  const [width, setWidth] = useState(readPanelWidth);
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth);
  const preferredWidth = clampChatSidePanelWidth(width, Number.POSITIVE_INFINITY);
  const setPanelWidth = useCallback((next: number, commit = true) => {
    const width = clampChatSidePanelWidth(Math.round(next), chatLayoutRef.current?.clientWidth ?? window.innerWidth);
    setWidth(width);
    if (commit) {
      try { window.sessionStorage.setItem('chat:side-panel-width', String(width)); } catch { /* Storage may be unavailable. */ }
    }
  }, []);
  useLayoutEffect(() => {
    const node = chatLayoutRef.current;
    if (!node) return;
    const measure = () => setContainerWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const { open, show, hide, layout } = workspace;
  const fullscreen = isActive && open && layout.fullscreen;
  useLayoutEffect(() => {
    useLayoutStore.getState().setViewportTakeover(fullscreen);
    return () => useLayoutStore.getState().clearViewportTakeover();
  }, [fullscreen]);
  const chatWindowDock = useChatWindowDockController({
    enabled: isActive,
    panelOpen: open,
    inline: layout.fullscreen || layout.position === 'top' || layout.position === 'full',
    preferredWidth,
    renderWidth: clampChatSidePanelWidth(width, containerWidth),
    containerWidth,
    chatLayoutRef,
    openPanel: show,
    closePanel: hide,
    setPanelWidth,
  });
  const handleComposerWheel = useCallback((deltaY: number) => {
    viewportPaneRef.current?.scrollByWheelDelta(deltaY);
  }, [viewportPaneRef]);
  const handleComposerGeometryChange = useCallback(() => {
    viewportPaneRef.current?.notifyComposerGeometryChanged();
  }, [viewportPaneRef]);
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
      <Content isActive={isActive} enabled={enabled} visible={!offline} sessionIdentity={sessionIdentity} ownership={ownership} />
    </Suspense>)}
    <ChatShell
      chatLayoutRef={chatLayoutRef}
      sidePanelPhase={chatWindowDock.phase}
      sidePanelMode={chatWindowDock.sidePanelMode}
      sidePanelWidth={chatWindowDock.sidePanelWidth}
      sidePanelMainWidth={chatWindowDock.sidePanelMainWidth}
      sidePanelVisible={chatWindowDock.sidePanelVisible}
      panelLayout={layout}
      onSidePanelResize={chatWindowDock.resizeSidePanelWidth}
      onSidePanelResizeCommit={chatWindowDock.commitSidePanelWidth}
      onComposerWheel={handleComposerWheel}
      onComposerGeometryChange={handleComposerGeometryChange}
      input={slots.input}
      isEmptyState={slots.isEmptyState}
      emptyState={slots.emptyState}
      offline={offline}
      header={<ChatHeaderBar {...slots.headerProps} sidePanelOpen={chatWindowDock.sidePanelExpanded} onToggleSidePanel={chatWindowDock.toggleSidePanel} />}
      viewportPane={slots.viewportPane()}
      sidePanel={panels.map(({ id, component: Panel }) => <Suspense key={id} fallback={null}>
        <Panel visible={isActive && chatWindowDock.sidePanelVisible}
          mode={chatWindowDock.sidePanelMode} width={layout.fullscreen ? containerWidth : chatWindowDock.sidePanelWidth}
          onHide={chatWindowDock.closeSidePanel} onSendMessage={onRuntimeSendMessage} onOpenLink={onRuntimeOpenLink} />
      </Suspense>)}
    />
  </>;
});
