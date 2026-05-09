import { describe, expect, it } from 'vitest';
import {
  canDockSidePanel,
  CHAT_WORKSPACE_LAYOUT,
  clampChatSidePanelWidth,
  getDefaultChatSidePanelWidth,
  getChatSidePanelMaxWidth,
  resolveChatWorkspaceLayout,
  resolveChatSidePanelLayout,
} from '@/pages/Chat/chat-workspace-layout';

describe('chat workspace layout', () => {
  it('auto-collapses the agent sessions pane when the workspace becomes too narrow', () => {
    const wideLayout = resolveChatWorkspaceLayout({
      containerWidth: 1200,
      sidebarVisible: true,
      sidebarWidth: CHAT_WORKSPACE_LAYOUT.sidebarDefaultWidth,
      agentSessionsUserCollapsed: false,
    });

    expect(wideLayout.agentSessionsCollapsed).toBe(false);
    expect(wideLayout.agentSessionsWidth).toBe(CHAT_WORKSPACE_LAYOUT.agentSessionsDefaultWidth);

    const narrowLayout = resolveChatWorkspaceLayout({
      containerWidth: 760,
      sidebarVisible: true,
      sidebarWidth: CHAT_WORKSPACE_LAYOUT.sidebarDefaultWidth,
      agentSessionsUserCollapsed: false,
    });

    expect(narrowLayout.agentSessionsCollapsed).toBe(true);
    expect(narrowLayout.agentSessionsWidth).toBe(CHAT_WORKSPACE_LAYOUT.agentSessionsCollapsedWidth);
  });

  it('docks the chat side panel only when the chat main area can keep its minimum width', () => {
    const threshold = (
      CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth
      + CHAT_WORKSPACE_LAYOUT.chatMainLightMinWidth
    );
    const artifactThreshold = (
      CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth
      + CHAT_WORKSPACE_LAYOUT.chatMainArtifactMinWidth
    );

    expect(canDockSidePanel(threshold - 1)).toBe(false);
    expect(canDockSidePanel(threshold)).toBe(true);
    expect(canDockSidePanel(artifactThreshold - 1, 'artifacts')).toBe(false);
    expect(canDockSidePanel(artifactThreshold, 'artifacts')).toBe(true);

    expect(resolveChatSidePanelLayout(false, 1200)).toEqual({
      sidePanelOpen: false,
      sidePanelMode: 'hidden',
      sidePanelWidth: 0,
    });

    expect(resolveChatSidePanelLayout(true, threshold - 1)).toEqual({
      sidePanelOpen: true,
      sidePanelMode: 'overlay',
      sidePanelWidth: CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth,
    });

    expect(resolveChatSidePanelLayout(true, 1200)).toEqual({
      sidePanelOpen: true,
      sidePanelMode: 'docked',
      sidePanelWidth: CHAT_WORKSPACE_LAYOUT.sidePanelLightDefaultWidth,
    });

    expect(resolveChatSidePanelLayout(true, 1200, getDefaultChatSidePanelWidth('artifacts'), 'artifacts')).toEqual({
      sidePanelOpen: true,
      sidePanelMode: 'docked',
      sidePanelWidth: CHAT_WORKSPACE_LAYOUT.sidePanelArtifactDefaultWidth,
    });
  });

  it('clamps the chat side panel width against the current container bounds', () => {
    expect(getChatSidePanelMaxWidth(1200)).toBe(CHAT_WORKSPACE_LAYOUT.sidePanelLightMaxWidth);
    expect(getChatSidePanelMaxWidth(700)).toBe(340);
    expect(getChatSidePanelMaxWidth(580)).toBe(CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth);
    expect(getChatSidePanelMaxWidth(1200, 'artifacts')).toBe(CHAT_WORKSPACE_LAYOUT.sidePanelArtifactMaxWidth);
    expect(getChatSidePanelMaxWidth(900, 'artifacts')).toBe(720);

    expect(clampChatSidePanelWidth(120, 1200)).toBe(CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth);
    expect(clampChatSidePanelWidth(500, 1200)).toBe(500);
    expect(clampChatSidePanelWidth(1000, 1200)).toBe(CHAT_WORKSPACE_LAYOUT.sidePanelLightMaxWidth);
    expect(clampChatSidePanelWidth(1000, 1200, 'artifacts')).toBe(960);
  });

  it('uses the caller-provided width for both docked and overlay side panel layouts', () => {
    const threshold = (
      CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth
      + CHAT_WORKSPACE_LAYOUT.chatMainLightMinWidth
    );

    expect(resolveChatSidePanelLayout(true, threshold - 1, 420)).toEqual({
      sidePanelOpen: true,
      sidePanelMode: 'overlay',
      sidePanelWidth: CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth,
    });

    expect(resolveChatSidePanelLayout(true, 1200, 420)).toEqual({
      sidePanelOpen: true,
      sidePanelMode: 'docked',
      sidePanelWidth: 420,
    });

    expect(resolveChatSidePanelLayout(true, 1200, 820, 'artifacts')).toEqual({
      sidePanelOpen: true,
      sidePanelMode: 'docked',
      sidePanelWidth: 820,
    });
  });
});
