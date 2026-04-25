import { ChatMessage } from '../ChatMessage';
import { ExecutionGraphCard } from '../ExecutionGraphCard';
import type { ChatRow } from '../chat-row-model';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { ActivityIndicator, TypingIndicator } from './ChatStates';

const EMPTY_SUPPRESSED_KEYS = new Set<string>();

export function ChatRowItem({
  row,
  showThinking,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
  userAvatarImageUrl,
  suppressedToolCardRowKeys = EMPTY_SUPPRESSED_KEYS,
  onJumpToRowKey,
}: {
  row: ChatRow;
  showThinking: boolean;
  assistantAgentId?: string;
  assistantAgentName?: string;
  assistantAvatarSeed?: string;
  assistantAvatarStyle?: AgentAvatarStyle;
  userAvatarImageUrl?: string | null;
  suppressedToolCardRowKeys?: Set<string>;
  onJumpToRowKey?: (rowKey?: string) => void;
}) {
  if (row.kind === 'message') {
    return (
      <ChatMessage
        message={row.message}
        showThinking={showThinking}
        isStreaming={row.isStreaming}
        streamingTools={row.streamingTools}
        suppressToolCards={suppressedToolCardRowKeys.has(row.key)}
        assistantAgentId={assistantAgentId}
        assistantAgentName={assistantAgentName}
        assistantAvatarSeed={assistantAvatarSeed}
        assistantAvatarStyle={assistantAvatarStyle}
        userAvatarImageUrl={userAvatarImageUrl}
      />
    );
  }

  if (row.kind === 'execution_graph') {
    return (
      <ExecutionGraphCard
        agentLabel={row.graph.agentLabel}
        sessionLabel={row.graph.sessionLabel}
        steps={row.graph.steps}
        active={row.graph.active}
        onJumpToTrigger={() => onJumpToRowKey?.(row.graph.triggerMessageKey)}
        onJumpToReply={() => onJumpToRowKey?.(row.graph.replyMessageKey)}
      />
    );
  }

  if (row.kind === 'activity') {
    return <ActivityIndicator />;
  }

  return <TypingIndicator />;
}
