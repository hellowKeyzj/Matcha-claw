export const CHAT_WORKSPACE_LAYOUT = {
  sidebarMinWidth: 200,
  sidebarMaxWidth: 420,
  sidebarDefaultWidth: 256,
  sidebarRailWidth: 64,
  agentSessionsMinWidth: 220,
  agentSessionsMaxWidth: 520,
  agentSessionsDefaultWidth: 240,
  agentSessionsCollapsedWidth: 0,
  sidePanelMinWidth: 260,
  sidePanelDefaultWidth: 360,
  paneResizerWidth: 6,
  chatMainMinWidth: 360,
} as const;

export interface ChatWorkspaceLayoutInput {
  containerWidth: number;
  sidebarVisible: boolean;
  sidebarWidth: number;
  agentSessionsUserCollapsed: boolean;
}

export interface ChatWorkspaceLayoutResult {
  sidebarWidth: number;
  sidebarOccupiedWidth: number;
  agentSessionsCollapsed: boolean;
  agentSessionsWidth: number;
}

export type ChatSidePanelMode = 'hidden' | 'docked' | 'overlay';

export interface ChatSidePanelLayoutResult {
  sidePanelOpen: boolean;
  sidePanelMode: ChatSidePanelMode;
  sidePanelWidth: number;
}

export function clampPaneWidth(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getSidebarResizeMaxWidth(containerWidth: number): number {
  const maxWidth = Math.min(
    CHAT_WORKSPACE_LAYOUT.sidebarMaxWidth,
    containerWidth
      - CHAT_WORKSPACE_LAYOUT.paneResizerWidth
      - CHAT_WORKSPACE_LAYOUT.agentSessionsCollapsedWidth
      - CHAT_WORKSPACE_LAYOUT.chatMainMinWidth,
  );
  return Math.max(CHAT_WORKSPACE_LAYOUT.sidebarMinWidth, maxWidth);
}

export function getSidebarRenderWidth(sidebarVisible: boolean, sidebarWidth: number): number {
  if (!sidebarVisible) {
    return CHAT_WORKSPACE_LAYOUT.sidebarRailWidth;
  }
  return clampPaneWidth(
    sidebarWidth,
    CHAT_WORKSPACE_LAYOUT.sidebarMinWidth,
    CHAT_WORKSPACE_LAYOUT.sidebarMaxWidth,
  );
}

export function getSidebarOccupiedWidth(sidebarVisible: boolean, sidebarWidth: number): number {
  return getSidebarRenderWidth(sidebarVisible, sidebarWidth)
    + (sidebarVisible ? CHAT_WORKSPACE_LAYOUT.paneResizerWidth : 0);
}

export function canExpandAgentSessions(
  containerWidth: number,
  sidebarOccupiedWidth: number,
): boolean {
  const availableWidth = containerWidth - sidebarOccupiedWidth;
  return availableWidth >= (
    CHAT_WORKSPACE_LAYOUT.agentSessionsMinWidth
    + CHAT_WORKSPACE_LAYOUT.chatMainMinWidth
  );
}

export function resolveChatWorkspaceLayout(
  input: ChatWorkspaceLayoutInput,
): ChatWorkspaceLayoutResult {
  const sidebarWidth = input.sidebarVisible
    ? clampPaneWidth(
      input.sidebarWidth,
      CHAT_WORKSPACE_LAYOUT.sidebarMinWidth,
      getSidebarResizeMaxWidth(input.containerWidth),
    )
    : CHAT_WORKSPACE_LAYOUT.sidebarRailWidth;
  const sidebarOccupiedWidth = getSidebarOccupiedWidth(input.sidebarVisible, sidebarWidth);

  if (
    input.agentSessionsUserCollapsed
    || !canExpandAgentSessions(input.containerWidth, sidebarOccupiedWidth)
  ) {
    return {
      sidebarWidth,
      sidebarOccupiedWidth,
      agentSessionsCollapsed: true,
      agentSessionsWidth: CHAT_WORKSPACE_LAYOUT.agentSessionsCollapsedWidth,
    };
  }

  return {
    sidebarWidth,
    sidebarOccupiedWidth,
    agentSessionsCollapsed: false,
    agentSessionsWidth: clampPaneWidth(
      CHAT_WORKSPACE_LAYOUT.agentSessionsDefaultWidth,
      CHAT_WORKSPACE_LAYOUT.agentSessionsMinWidth,
      Math.min(
        CHAT_WORKSPACE_LAYOUT.agentSessionsMaxWidth,
        input.containerWidth - sidebarOccupiedWidth - CHAT_WORKSPACE_LAYOUT.chatMainMinWidth,
      ),
    ),
  };
}

export function canDockSidePanel(containerWidth: number): boolean {
  return containerWidth >= (
    CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth
    + CHAT_WORKSPACE_LAYOUT.chatMainMinWidth
  );
}

export function resolveChatSidePanelLayout(
  open: boolean,
  containerWidth: number,
): ChatSidePanelLayoutResult {
  if (!open) {
    return {
      sidePanelOpen: false,
      sidePanelMode: 'hidden',
      sidePanelWidth: 0,
    };
  }

  return {
    sidePanelOpen: true,
    sidePanelMode: canDockSidePanel(containerWidth) ? 'docked' : 'overlay',
    sidePanelWidth: CHAT_WORKSPACE_LAYOUT.sidePanelDefaultWidth,
  };
}
