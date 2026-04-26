export const CHAT_WORKSPACE_LAYOUT = {
  sidebarMinWidth: 200,
  sidebarMaxWidth: 420,
  sidebarDefaultWidth: 256,
  sidebarCollapsedWidth: 64,
  agentSessionsMinWidth: 220,
  agentSessionsMaxWidth: 520,
  agentSessionsDefaultWidth: 300,
  agentSessionsCollapsedWidth: 52,
  taskInboxMinWidth: 260,
  taskInboxMaxWidth: 560,
  taskInboxDefaultWidth: 360,
  taskInboxCollapsedWidth: 52,
  paneResizerWidth: 6,
  chatMainMinWidth: 360,
} as const;

export interface ChatWorkspaceLayoutInput {
  containerWidth: number;
  sidebarCollapsed: boolean;
  sidebarPreferredWidth: number;
  agentSessionsUserCollapsed: boolean;
  agentSessionsPreferredWidth: number;
}

export interface ChatWorkspaceLayoutResult {
  sidebarWidth: number;
  agentSessionsCollapsed: boolean;
  agentSessionsWidth: number;
}

export interface TaskInboxLayoutResult {
  taskInboxCollapsed: boolean;
  taskInboxWidth: number;
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

export function getAgentSessionsResizeMaxWidth(
  containerWidth: number,
  sidebarWidth: number,
  sidebarCollapsed: boolean,
): number {
  const sidebarResizerWidth = sidebarCollapsed ? 0 : CHAT_WORKSPACE_LAYOUT.paneResizerWidth;
  const availableWidth = containerWidth - sidebarWidth - sidebarResizerWidth;
  const maxWidth = Math.min(
    CHAT_WORKSPACE_LAYOUT.agentSessionsMaxWidth,
    availableWidth
      - CHAT_WORKSPACE_LAYOUT.paneResizerWidth
      - CHAT_WORKSPACE_LAYOUT.chatMainMinWidth,
  );
  return Math.max(CHAT_WORKSPACE_LAYOUT.agentSessionsMinWidth, maxWidth);
}

export function canExpandAgentSessions(
  containerWidth: number,
  sidebarWidth: number,
  sidebarCollapsed: boolean,
): boolean {
  const sidebarResizerWidth = sidebarCollapsed ? 0 : CHAT_WORKSPACE_LAYOUT.paneResizerWidth;
  const availableWidth = containerWidth - sidebarWidth - sidebarResizerWidth;
  return availableWidth >= (
    CHAT_WORKSPACE_LAYOUT.agentSessionsMinWidth
    + CHAT_WORKSPACE_LAYOUT.paneResizerWidth
    + CHAT_WORKSPACE_LAYOUT.chatMainMinWidth
  );
}

export function resolveChatWorkspaceLayout(
  input: ChatWorkspaceLayoutInput,
): ChatWorkspaceLayoutResult {
  const sidebarWidth = input.sidebarCollapsed
    ? CHAT_WORKSPACE_LAYOUT.sidebarCollapsedWidth
    : clampPaneWidth(
      input.sidebarPreferredWidth,
      CHAT_WORKSPACE_LAYOUT.sidebarMinWidth,
      getSidebarResizeMaxWidth(input.containerWidth),
    );

  if (
    input.agentSessionsUserCollapsed
    || !canExpandAgentSessions(input.containerWidth, sidebarWidth, input.sidebarCollapsed)
  ) {
    return {
      sidebarWidth,
      agentSessionsCollapsed: true,
      agentSessionsWidth: CHAT_WORKSPACE_LAYOUT.agentSessionsCollapsedWidth,
    };
  }

  return {
    sidebarWidth,
    agentSessionsCollapsed: false,
    agentSessionsWidth: clampPaneWidth(
      input.agentSessionsPreferredWidth,
      CHAT_WORKSPACE_LAYOUT.agentSessionsMinWidth,
      getAgentSessionsResizeMaxWidth(input.containerWidth, sidebarWidth, input.sidebarCollapsed),
    ),
  };
}

export function getTaskInboxResizeMaxWidth(containerWidth: number): number {
  const maxWidth = Math.min(
    CHAT_WORKSPACE_LAYOUT.taskInboxMaxWidth,
    containerWidth
      - CHAT_WORKSPACE_LAYOUT.paneResizerWidth
      - CHAT_WORKSPACE_LAYOUT.chatMainMinWidth,
  );
  return Math.max(CHAT_WORKSPACE_LAYOUT.taskInboxMinWidth, maxWidth);
}

export function canExpandTaskInbox(containerWidth: number): boolean {
  return containerWidth >= (
    CHAT_WORKSPACE_LAYOUT.taskInboxMinWidth
    + CHAT_WORKSPACE_LAYOUT.paneResizerWidth
    + CHAT_WORKSPACE_LAYOUT.chatMainMinWidth
  );
}

export function resolveTaskInboxLayout(
  preferredCollapsed: boolean,
  preferredWidth: number,
  containerWidth: number,
): TaskInboxLayoutResult {
  const normalizedWidth = clampPaneWidth(
    preferredWidth,
    CHAT_WORKSPACE_LAYOUT.taskInboxMinWidth,
    CHAT_WORKSPACE_LAYOUT.taskInboxMaxWidth,
  );

  if (preferredCollapsed || !canExpandTaskInbox(containerWidth)) {
    return {
      taskInboxCollapsed: true,
      taskInboxWidth: normalizedWidth,
    };
  }

  return {
    taskInboxCollapsed: false,
    taskInboxWidth: clampPaneWidth(
      normalizedWidth,
      CHAT_WORKSPACE_LAYOUT.taskInboxMinWidth,
      getTaskInboxResizeMaxWidth(containerWidth),
    ),
  };
}
