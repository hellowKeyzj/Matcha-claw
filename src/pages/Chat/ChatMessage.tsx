import { useState, memo } from 'react';
import type { ChatMessageRow } from './chat-row-model';
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
  userAvatarImageUrl,
}: ChatMessageProps) {
  const isUser = row.role === 'user';
  const isStreaming = row.isStreaming;
  const hasText = row.text.trim().length > 0;
  const visibleThinking = showThinking ? row.thinking : null;
  const visibleTools = row.toolUses;
  const [lightboxImg, setLightboxImg] = useState<MessageLightboxState | null>(null);

  const hasStreamingToolStatus = isStreaming && row.toolStatuses.length > 0;
  const hasStreamingShell = isStreaming && !isUser;
  if (!hasText && !visibleThinking && row.images.length === 0 && visibleTools.length === 0 && row.attachedFiles.length === 0 && !hasStreamingToolStatus && !hasStreamingShell) return null;

  return (
    <>
      <MessageShell
        isUser={isUser}
        assistantAgentId={row.assistantPresentation?.agentId}
        assistantAgentName={row.assistantPresentation?.agentName}
        assistantAvatarSeed={row.assistantPresentation?.avatarSeed}
        assistantAvatarStyle={row.assistantPresentation?.avatarStyle}
        userAvatarImageUrl={userAvatarImageUrl}
      >
        {isStreaming && !isUser && row.toolStatuses.length > 0 && (
          <ToolStatusBar tools={row.toolStatuses} />
        )}

        {visibleThinking && (
          <ThinkingSection content={visibleThinking} />
        )}

        <ToolUseList tools={visibleTools} />

        {isUser && (
          <UserMessageMedia
            images={row.images}
            attachedFiles={row.attachedFiles}
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
              markdownHtml={row.assistantMarkdownHtml}
              isStreaming={isStreaming}
            />
          )
        )}
        {!hasText && !isUser && isStreaming && (
          <AssistantMessageBody
            text=""
            markdownHtml={row.assistantMarkdownHtml}
            isStreaming
          />
        )}

        {!isUser && (
          <AssistantMessageMedia
            images={row.images}
            attachedFiles={row.attachedFiles}
            onPreview={setLightboxImg}
          />
        )}

        {isUser && <UserMessageMetaBar timestamp={row.createdAt} />}
        {!isUser && hasText && <AssistantMessageMetaBar text={row.text} timestamp={row.createdAt} />}
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
  userAvatarImageUrl?: string | null;
}
