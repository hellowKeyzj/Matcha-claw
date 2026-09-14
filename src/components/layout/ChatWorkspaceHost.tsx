import { AgentSessionsPane } from './AgentSessionsPane';
import { Chat } from '@/pages/Chat';

interface ChatWorkspaceHostProps {
  takeoverMode: 'none' | 'artifact-workbench';
}

export function ChatWorkspaceHost({
  takeoverMode,
}: ChatWorkspaceHostProps) {
  const artifactWorkbenchFullscreen = takeoverMode === 'artifact-workbench';

  return (
    <div
      data-testid="chat-workspace-host"
      data-takeover-mode={takeoverMode}
      className="relative flex h-full min-w-0 overflow-hidden bg-card"
    >
      {!artifactWorkbenchFullscreen ? (
        <div className="pointer-events-none absolute inset-y-0 left-0 z-20 w-0 overflow-visible">
          <div className="pointer-events-auto h-full">
            <AgentSessionsPane />
          </div>
        </div>
      ) : null}
      <div className="min-w-0 flex-1 overflow-hidden bg-card">
        <Chat />
      </div>
    </div>
  );
}
