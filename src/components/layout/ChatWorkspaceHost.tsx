import { AgentSessionsPane } from './AgentSessionsPane';
import { Chat } from '@/pages/Chat';

interface ChatWorkspaceHostProps {
  agentSessionsWidth: number;
  agentSessionsCollapsed: boolean;
  agentSessionsCollapsedWidth: number;
  onToggleAgentSessionsCollapse: () => void;
}

export function ChatWorkspaceHost({
  agentSessionsWidth,
  agentSessionsCollapsed,
  agentSessionsCollapsedWidth,
  onToggleAgentSessionsCollapse,
}: ChatWorkspaceHostProps) {
  return (
    <div
      data-testid="chat-workspace-host"
      className="flex h-full min-w-0 overflow-hidden bg-card"
    >
      <AgentSessionsPane
        expandedWidth={agentSessionsWidth}
        collapsed={agentSessionsCollapsed}
        collapsedWidth={agentSessionsCollapsedWidth}
        onToggleCollapse={onToggleAgentSessionsCollapse}
        showRightDivider
      />
      <div className="min-w-0 flex-1 overflow-hidden bg-card">
        <Chat />
      </div>
    </div>
  );
}
