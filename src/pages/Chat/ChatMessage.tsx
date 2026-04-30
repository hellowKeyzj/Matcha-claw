import { useMemo, useState, memo } from 'react';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import type { ChatMessageRow } from './chat-row-model';
import { getOrBuildChatMessageView } from './chat-message-view';
import { AssistantMessageBody } from './assistant-message-body';
import { MessageShell } from './chat-message-shell';
import { UserMessageBody } from './user-message-body';
import { ChatImageLightbox } from './components/ChatImageLightbox';
import {
  AssistantMessageMedia,
  AssistantMessageMetaBar,
  ThinkingSection,
  ToolStatusBar,
  ToolUseList,
  UserMessageMedia,
  UserMessageMetaBar,
  type MessageLightboxState,
} from './chat-message-parts';

export const ChatMessage = memo(function ChatMessage({
  row,
  showThinking,
  suppressToolCards = false,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
  userAvatarImageUrl,
  streamingTools = [],
}: ChatMessageProps) {
  const { message } = row;
  const messageView = useMemo(() => getOrBuildChatMessageView(message), [message]);
  const isUser = row.role === 'user';
  const isStreaming = Boolean(message.streaming);
  const hasText = row.text.trim().length > 0;
  const visibleThinking = showThinking ? messageView.thinking : null;
  const visibleTools = suppressToolCards ? [] : messageView.toolUses;
  const [lightboxImg, setLightboxImg] = useState<MessageLightboxState | null>(null);

  const hasStreamingToolStatus = isStreaming && streamingTools.length > 0;
  const hasStreamingShell = isStreaming && !isUser;
  if (!hasText && !visibleThinking && messageView.images.length === 0 && visibleTools.length === 0 && messageView.attachedFiles.length === 0 && !hasStreamingToolStatus && !hasStreamingShell) return null;

  return (
    <>
      <MessageShell
        isUser={isUser}
        assistantAgentId={assistantAgentId}
        assistantAgentName={assistantAgentName}
        assistantAvatarSeed={assistantAvatarSeed}
        assistantAvatarStyle={assistantAvatarStyle}
        userAvatarImageUrl={userAvatarImageUrl}
      >
        {isStreaming && !isUser && streamingTools.length > 0 && (
          <ToolStatusBar tools={streamingTools} />
        )}

        {visibleThinking && (
          <ThinkingSection content={visibleThinking} />
        )}

        <ToolUseList tools={visibleTools} />

        {isUser && (
          <UserMessageMedia
            images={messageView.images}
            attachedFiles={messageView.attachedFiles}
            onPreview={setLightboxImg}
          />
        )}

        {/* Main text bubble */}
        {hasText && (
          isUser ? (
            <UserMessageBody text={row.text} />
          ) : (
            <AssistantMessageBody
              text={row.text}
              message={message}
              isStreaming={isStreaming}
            />
          )
        )}
        {!hasText && !isUser && isStreaming && (
          <AssistantMessageBody
            text=""
            message={message}
            isStreaming
          />
        )}

        {!isUser && (
          <AssistantMessageMedia
            images={messageView.images}
            attachedFiles={messageView.attachedFiles}
            onPreview={setLightboxImg}
          />
        )}

        {isUser && <UserMessageMetaBar timestamp={message.timestamp} />}
        {!isUser && hasText && <AssistantMessageMetaBar text={row.text} timestamp={message.timestamp} />}
      </MessageShell>

      {/* Image lightbox portal */}
      {lightboxImg && (
        <ChatImageLightbox
          src={lightboxImg.src}
          fileName={lightboxImg.fileName}
          filePath={lightboxImg.filePath}
          onClose={() => setLightboxImg(null)}
        />
      )}
    </>
  );
});

interface ChatMessageProps {
  row: ChatMessageRow;
  showThinking: boolean;
  suppressToolCards?: boolean;
  assistantAgentId?: string;
  assistantAgentName?: string;
  assistantAvatarSeed?: string;
  assistantAvatarStyle?: AgentAvatarStyle;
  userAvatarImageUrl?: string | null;
  streamingTools?: Array<{
    id?: string;
    toolCallId?: string;
    name: string;
    status: 'running' | 'completed' | 'error';
    durationMs?: number;
    summary?: string;
  }>;
}
