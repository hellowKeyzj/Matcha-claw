export const CHAT_WORKSPACE_LAYOUT = {
  sidebarMinWidth: 200,
  sidebarMaxWidth: 420,
  sidebarDefaultWidth: 256,
  sidePanelMinWidth: 260,
  sidePanelMaxWidth: 1600,
  sidePanelLightDefaultWidth: 360,
  sidePanelArtifactDefaultWidth: 640,
  paneResizerWidth: 6,
  chatMainLightMinWidth: 360,
  chatMainMinWidth: 180,
} as const;

export interface ChatWorkspaceLayoutInput {
  containerWidth: number;
  sidebarVisible: boolean;
  sidebarWidth: number;
}

export interface ChatWorkspaceLayoutResult {
  sidebarWidth: number;
  sidebarOccupiedWidth: number;
}

export type ChatSidePanelMode = 'docked' | 'overlay';
export type ChatSidePanelWidthPolicy = 'light' | 'artifacts';
export type ChatWindowDockPhase = 'closed' | 'opening' | 'open' | 'closing';

export interface ChatSidePanelLayoutResult {
  sidePanelOpen: boolean;
  sidePanelMode: ChatSidePanelMode;
  sidePanelWidth: number;
}

export function getDefaultChatSidePanelWidth(policy: ChatSidePanelWidthPolicy): number {
  return policy === 'artifacts'
    ? CHAT_WORKSPACE_LAYOUT.sidePanelArtifactDefaultWidth
    : CHAT_WORKSPACE_LAYOUT.sidePanelLightDefaultWidth;
}

export function clampPaneWidth(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function getSidebarResizeMaxWidth(containerWidth: number): number {
  const maxWidth = Math.min(
    CHAT_WORKSPACE_LAYOUT.sidebarMaxWidth,
    containerWidth
      - CHAT_WORKSPACE_LAYOUT.paneResizerWidth
      - CHAT_WORKSPACE_LAYOUT.chatMainLightMinWidth,
  );
  return Math.max(CHAT_WORKSPACE_LAYOUT.sidebarMinWidth, maxWidth);
}

export function getSidebarRenderWidth(sidebarVisible: boolean, sidebarWidth: number): number {
  if (!sidebarVisible) {
    return 0;
  }
  return clampPaneWidth(
    sidebarWidth,
    CHAT_WORKSPACE_LAYOUT.sidebarMinWidth,
    CHAT_WORKSPACE_LAYOUT.sidebarMaxWidth,
  );
}

export function getSidebarOccupiedWidth(sidebarVisible: boolean, sidebarWidth: number): number {
  return sidebarVisible
    ? getSidebarRenderWidth(sidebarVisible, sidebarWidth) + CHAT_WORKSPACE_LAYOUT.paneResizerWidth
    : 0;
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
    : 0;

  return {
    sidebarWidth,
    sidebarOccupiedWidth: getSidebarOccupiedWidth(input.sidebarVisible, sidebarWidth),
  };
}

export function canDockSidePanel(containerWidth: number): boolean {
  return containerWidth >= (
    CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth
    + CHAT_WORKSPACE_LAYOUT.chatMainMinWidth
  );
}

export function getChatSidePanelMaxWidth(containerWidth: number): number {
  const bounded = Math.min(
    CHAT_WORKSPACE_LAYOUT.sidePanelMaxWidth,
    containerWidth - CHAT_WORKSPACE_LAYOUT.chatMainMinWidth,
  );
  return Math.max(CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth, bounded);
}

export function clampChatSidePanelWidth(
  width: number,
  containerWidth: number,
): number {
  return clampPaneWidth(
    width,
    CHAT_WORKSPACE_LAYOUT.sidePanelMinWidth,
    getChatSidePanelMaxWidth(containerWidth),
  );
}

export function resolveChatSidePanelLayout(
  open: boolean,
  containerWidth: number,
  width: number = getDefaultChatSidePanelWidth('light'),
): ChatSidePanelLayoutResult {
  return {
    sidePanelOpen: open,
    sidePanelMode: canDockSidePanel(containerWidth) ? 'docked' : 'overlay',
    sidePanelWidth: clampChatSidePanelWidth(width, containerWidth),
  };
}
