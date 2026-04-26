import type { MouseEvent as ReactMouseEvent } from 'react';
import { AgentSessionsPane } from './AgentSessionsPane';
import { VerticalPaneResizer } from './VerticalPaneResizer';
import { Chat } from '@/pages/Chat';
import { cn } from '@/lib/utils';

interface ChatWorkspaceHostProps {
  isActive: boolean;
  agentSessionsWidth: number;
  agentSessionsCollapsed: boolean;
  agentSessionsCollapsedWidth: number;
  onToggleAgentSessionsCollapse: () => void;
  onAgentSessionsResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

export function ChatWorkspaceHost({
  isActive,
  agentSessionsWidth,
  agentSessionsCollapsed,
  agentSessionsCollapsedWidth,
  onToggleAgentSessionsCollapse,
  onAgentSessionsResizeStart,
}: ChatWorkspaceHostProps) {
  return (
    <div
      data-testid="chat-workspace-host"
      data-active={String(isActive)}
      aria-hidden={!isActive}
      inert={!isActive ? true : undefined}
      className={cn(
        'absolute inset-0 flex min-w-0 overflow-hidden bg-card',
        !isActive && 'pointer-events-none opacity-0',
      )}
    >
      <AgentSessionsPane
        expandedWidth={agentSessionsWidth}
        collapsed={agentSessionsCollapsed}
        collapsedWidth={agentSessionsCollapsedWidth}
        onToggleCollapse={onToggleAgentSessionsCollapse}
        showRightDivider={agentSessionsCollapsed}
      />
      {!agentSessionsCollapsed && (
        <VerticalPaneResizer
          testId="layout-agent-sessions-resizer"
          onMouseDown={onAgentSessionsResizeStart}
          ariaLabel="Resize agent sessions pane"
          variant="subtle-border"
        />
      )}
      <div className="min-w-0 flex-1 overflow-hidden bg-card">
        <Chat isActive={isActive} />
      </div>
    </div>
  );
}
