import { useState, memo } from 'react';
import type { ChatAssistantTurnItem } from './chat-render-item-model';
import { AssistantMessageBody } from './assistant-message-body';
import { MessageShell } from './chat-message-shell';
import { ChatImageLightbox } from './components/ChatImageLightbox';
import {
  AssistantMessageMedia,
  AssistantMessageMetaBar,
  ThinkingSection,
  ToolStatusBar,
  ToolUseList,
  type MessageLightboxState,
} from './chat-message-parts';

interface ChatAssistantTurnProps {
  item: ChatAssistantTurnItem;
  showThinking: boolean;
  userAvatarImageUrl?: string | null;
}

export const ChatAssistantTurn = memo(function ChatAssistantTurn({
  item,
  showThinking,
  userAvatarImageUrl,
}: ChatAssistantTurnProps) {
  const hasText = item.text.trim().length > 0;
  const visibleThinking = showThinking ? item.thinking : null;
  const visibleTools = item.toolCalls;
  const [lightboxImg, setLightboxImg] = useState<MessageLightboxState | null>(null);

  const isStreaming = item.status === 'streaming' || item.status === 'waiting_tool';
  const hasStreamingShell = isStreaming && !hasText;
  if (!hasText && !visibleThinking && item.images.length === 0 && visibleTools.length === 0 && item.attachedFiles.length === 0 && item.toolStatuses.length === 0 && !hasStreamingShell) {
    return null;
  }

  return (
    <>
      <MessageShell
        isUser={false}
        assistantAgentId={item.assistantPresentation?.agentId}
        assistantAgentName={item.assistantPresentation?.agentName}
        assistantAvatarSeed={item.assistantPresentation?.avatarSeed}
        assistantAvatarStyle={item.assistantPresentation?.avatarStyle}
        userAvatarImageUrl={userAvatarImageUrl}
      >
        {item.toolStatuses.length > 0 && (
          <ToolStatusBar tools={item.toolStatuses} />
        )}

        {visibleThinking && (
          <ThinkingSection content={visibleThinking} />
        )}

        <ToolUseList tools={visibleTools} />

        {(hasText || isStreaming) && (
          <AssistantMessageBody
            text={item.text}
            markdownHtml={item.assistantMarkdownHtml}
            isStreaming={isStreaming}
          />
        )}

        <AssistantMessageMedia
          images={item.images}
          attachedFiles={item.attachedFiles}
          onPreview={setLightboxImg}
        />

        {hasText && <AssistantMessageMetaBar text={item.text} timestamp={item.createdAt} />}
      </MessageShell>

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
