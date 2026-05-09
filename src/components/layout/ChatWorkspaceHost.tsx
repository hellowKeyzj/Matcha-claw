import { AgentSessionsPane } from './AgentSessionsPane';
import { Chat } from '@/pages/Chat';

interface ChatWorkspaceHostProps {
  agentSessionsWidth: number;
  agentSessionsCollapsed: boolean;
  agentSessionsCollapsedWidth: number;
  onToggleAgentSessionsCollapse: () => void;
  takeoverMode: 'none' | 'artifact-workbench';
}

export function ChatWorkspaceHost({
  agentSessionsWidth,
  agentSessionsCollapsed,
  agentSessionsCollapsedWidth,
  onToggleAgentSessionsCollapse,
  takeoverMode,
}: ChatWorkspaceHostProps) {
  const artifactWorkbenchFullscreen = takeoverMode === 'artifact-workbench';

  return (
    <div
      data-testid="chat-workspace-host"
      data-takeover-mode={takeoverMode}
      className="flex h-full min-w-0 overflow-hidden bg-card"
    >
      {!artifactWorkbenchFullscreen ? (
        <AgentSessionsPane
          expandedWidth={agentSessionsWidth}
          collapsed={agentSessionsCollapsed}
          collapsedWidth={agentSessionsCollapsedWidth}
          onToggleCollapse={onToggleAgentSessionsCollapse}
          showRightDivider
        />
      ) : null}
      <div className="min-w-0 flex-1 overflow-hidden bg-card">
        <Chat />
      </div>
    </div>
  );
}
