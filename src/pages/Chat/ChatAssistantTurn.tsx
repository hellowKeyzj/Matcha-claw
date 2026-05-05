import { useState, memo, useReducer } from 'react';
import type { ChatAssistantTurnItem } from './chat-render-item-model';
import { AssistantMessageBody } from './assistant-message-body';
import { MessageShell } from './chat-message-shell';
import { ChatImageLightbox } from './components/ChatImageLightbox';
import { getAssistantTurnPlainText } from './chat-message-view';
import {
  AssistantMessageMedia,
  AssistantEmbeddedToolResults,
  AssistantMessageMetaBar,
  ThinkingSection,
  ToolCardList,
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
  const [collapseVersion, requestCollapse] = useReducer((value: number) => value + 1, 0);
  const [lightboxImg, setLightboxImg] = useState<MessageLightboxState | null>(null);

  const isStreaming = item.status === 'streaming' || item.status === 'waiting_tool';
  const hasContentSegments = item.segments.some((segment) => {
    if (segment.kind === 'thinking') {
      return showThinking && segment.text.trim().length > 0;
    }
    if (segment.kind === 'message') {
      return segment.text.trim().length > 0;
    }
    if (segment.kind === 'tool') {
      return true;
    }
    return segment.images.length > 0 || segment.attachedFiles.length > 0;
  });
  const hasPendingShell = isStreaming && !hasContentSegments;
  const plainText = getAssistantTurnPlainText(item);
  if (!hasContentSegments && !hasPendingShell) {
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
        {item.segments.map((segment) => {
          if (segment.kind === 'thinking') {
            if (!showThinking || !segment.text.trim()) {
              return null;
            }
            return (
              <div key={segment.key} className="flex flex-col items-start gap-0.5 pt-0.5">
                <ThinkingSection content={segment.text} collapseVersion={collapseVersion} />
              </div>
            );
          }
          if (segment.kind === 'tool') {
            const embeddedToolResults = (
              segment.tool.result.kind === 'canvas'
              && segment.tool.result.surface === 'assistant-bubble'
              && segment.tool.result.preview.surface === 'assistant_message'
            )
              ? [{
                  key: segment.tool.toolCallId || segment.tool.id || segment.key,
                  ...(segment.tool.toolCallId ? { toolCallId: segment.tool.toolCallId } : {}),
                  toolName: segment.tool.name,
                  preview: segment.tool.result.preview,
                  ...(segment.tool.result.rawText ? { rawText: segment.tool.result.rawText } : {}),
                }]
              : [];
            return (
              <div key={segment.key} className="flex flex-col items-start gap-0 pt-0">
                <ToolCardList tools={[segment.tool]} collapseVersion={collapseVersion} />
                <AssistantEmbeddedToolResults
                  embeddedToolResults={embeddedToolResults}
                  collapseVersion={collapseVersion}
                />
              </div>
            );
          }
          if (segment.kind === 'message') {
            return (
              <AssistantMessageBody
                key={segment.key}
                text={segment.text}
                markdownHtml={item.assistantSegmentMarkdownHtmlByKey[segment.key] || null}
                isStreaming={isStreaming}
                onBodyClick={requestCollapse}
              />
            );
          }
          return (
            <AssistantMessageMedia
              key={segment.key}
              images={segment.images}
              attachedFiles={segment.attachedFiles}
              onPreview={setLightboxImg}
            />
          );
        })}

        {hasPendingShell && (
          <AssistantMessageBody
            text=""
            markdownHtml={null}
            isStreaming={isStreaming}
            onBodyClick={requestCollapse}
          />
        )}

        {plainText && <AssistantMessageMetaBar text={plainText} timestamp={item.createdAt} />}
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
