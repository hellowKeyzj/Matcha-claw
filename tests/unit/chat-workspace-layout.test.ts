import { describe, expect, it } from 'vitest';
import {
  canDockSidePanel,
  CHAT_WORKSPACE_LAYOUT,
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
      + CHAT_WORKSPACE_LAYOUT.chatMainMinWidth
    );

    expect(canDockSidePanel(threshold - 1)).toBe(false);
    expect(canDockSidePanel(threshold)).toBe(true);

    expect(resolveChatSidePanelLayout(false, 1200)).toEqual({
      sidePanelOpen: false,
      sidePanelMode: 'hidden',
      sidePanelWidth: 0,
    });

    expect(resolveChatSidePanelLayout(true, threshold - 1)).toEqual({
      sidePanelOpen: true,
      sidePanelMode: 'overlay',
      sidePanelWidth: CHAT_WORKSPACE_LAYOUT.sidePanelDefaultWidth,
    });

    expect(resolveChatSidePanelLayout(true, 1200)).toEqual({
      sidePanelOpen: true,
      sidePanelMode: 'docked',
      sidePanelWidth: CHAT_WORKSPACE_LAYOUT.sidePanelDefaultWidth,
    });
  });
});
