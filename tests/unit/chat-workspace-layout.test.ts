import { describe, expect, it } from 'vitest';
import {
  canExpandTaskInbox,
  CHAT_WORKSPACE_LAYOUT,
  resolveChatWorkspaceLayout,
  resolveTaskInboxLayout,
} from '@/pages/Chat/chat-workspace-layout';

describe('chat workspace layout', () => {
  it('auto-collapses the agent sessions pane when the workspace becomes too narrow', () => {
    const wideLayout = resolveChatWorkspaceLayout({
      containerWidth: 1200,
      sidebarCollapsed: false,
      sidebarPreferredWidth: CHAT_WORKSPACE_LAYOUT.sidebarDefaultWidth,
      agentSessionsUserCollapsed: false,
      agentSessionsPreferredWidth: CHAT_WORKSPACE_LAYOUT.agentSessionsDefaultWidth,
    });

    expect(wideLayout.agentSessionsCollapsed).toBe(false);
    expect(wideLayout.agentSessionsWidth).toBe(CHAT_WORKSPACE_LAYOUT.agentSessionsDefaultWidth);

    const narrowLayout = resolveChatWorkspaceLayout({
      containerWidth: 760,
      sidebarCollapsed: false,
      sidebarPreferredWidth: CHAT_WORKSPACE_LAYOUT.sidebarDefaultWidth,
      agentSessionsUserCollapsed: false,
      agentSessionsPreferredWidth: CHAT_WORKSPACE_LAYOUT.agentSessionsDefaultWidth,
    });

    expect(narrowLayout.agentSessionsCollapsed).toBe(true);
    expect(narrowLayout.agentSessionsWidth).toBe(CHAT_WORKSPACE_LAYOUT.agentSessionsCollapsedWidth);
  });

  it('keeps the task inbox expanded only when there is enough room for the chat main area to shrink first', () => {
    const threshold = (
      CHAT_WORKSPACE_LAYOUT.taskInboxMinWidth
      + CHAT_WORKSPACE_LAYOUT.paneResizerWidth
      + CHAT_WORKSPACE_LAYOUT.chatMainMinWidth
    );

    expect(canExpandTaskInbox(threshold - 1)).toBe(false);
    expect(canExpandTaskInbox(threshold)).toBe(true);

    expect(resolveTaskInboxLayout(false, 360, threshold - 1)).toEqual({
      taskInboxCollapsed: true,
      taskInboxWidth: 360,
    });

    expect(resolveTaskInboxLayout(false, 360, 900)).toEqual({
      taskInboxCollapsed: false,
      taskInboxWidth: 360,
    });
  });
});
