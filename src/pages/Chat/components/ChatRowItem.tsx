import { ChatMessage } from '../ChatMessage';
import { ExecutionGraphCard } from '../ExecutionGraphCard';
import type { ChatRow } from '../chat-row-model';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import type { MarkdownBodyRenderMode } from '../md-pipeline';
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
  bodyRenderModeByRowKey,
  onRequestFullRender,
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
  bodyRenderModeByRowKey?: ReadonlyMap<string, MarkdownBodyRenderMode>;
  onRequestFullRender?: (rowKey: string) => void;
  onJumpToRowKey?: (rowKey?: string) => void;
}) {
  if (row.kind === 'message') {
    return (
      <ChatMessage
        message={row.message}
        showThinking={showThinking}
        suppressToolCards={suppressedToolCardRowKeys.has(row.key)}
        assistantAgentId={assistantAgentId}
        assistantAgentName={assistantAgentName}
        assistantAvatarSeed={assistantAvatarSeed}
        assistantAvatarStyle={assistantAvatarStyle}
        userAvatarImageUrl={userAvatarImageUrl}
        bodyRenderMode={bodyRenderModeByRowKey?.get(row.key)}
        onRequestFullRender={() => onRequestFullRender?.(row.key)}
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

  if (row.kind === 'streaming') {
    return (
      <ChatMessage
        message={row.message}
        showThinking={showThinking}
        isStreaming
        streamingTools={row.streamingTools}
        assistantAgentId={assistantAgentId}
        assistantAgentName={assistantAgentName}
        assistantAvatarSeed={assistantAvatarSeed}
        assistantAvatarStyle={assistantAvatarStyle}
        userAvatarImageUrl={userAvatarImageUrl}
      />
    );
  }

  if (row.kind === 'activity') {
    return <ActivityIndicator />;
  }

  return <TypingIndicator />;
}
