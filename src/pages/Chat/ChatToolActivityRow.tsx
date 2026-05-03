import { memo } from 'react';
import type { ChatToolActivityRow } from './chat-row-model';
import { MessageShell } from './chat-message-shell';
import { AssistantMessageMetaBar, ToolActivityBar } from './chat-message-parts';

interface ChatToolActivityRowViewProps {
  row: ChatToolActivityRow;
  userAvatarImageUrl?: string | null;
}

export const ChatToolActivityRowView = memo(function ChatToolActivityRowView({
  row,
  userAvatarImageUrl,
}: ChatToolActivityRowViewProps) {
  if (row.toolUses.length === 0) {
    return null;
  }

  return (
    <MessageShell
      isUser={false}
      assistantAgentId={row.assistantPresentation?.agentId}
      assistantAgentName={row.assistantPresentation?.agentName}
      assistantAvatarSeed={row.assistantPresentation?.avatarSeed}
      assistantAvatarStyle={row.assistantPresentation?.avatarStyle}
      userAvatarImageUrl={userAvatarImageUrl}
    >
      <ToolActivityBar
        tools={row.toolUses}
        statuses={row.toolStatuses}
      />
      <AssistantMessageMetaBar text={row.toolUses.map((tool) => tool.name).join(', ')} timestamp={row.createdAt} />
    </MessageShell>
  );
});
