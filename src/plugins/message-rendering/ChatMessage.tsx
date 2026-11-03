import { useState, memo } from 'react';
import { useContributions } from '@/plugin-host/react';
import { messageContextTags } from './extensions';
import { readTaggedMessage } from './tagged-context';
import type { ChatUserMessageItem } from '@/plugins/message-rendering/chat-render-item-model';
import { MessageShell } from '@/plugins/message-rendering/chat-message-shell';
import { UserMessageBody } from '@/plugins/message-rendering/user-message-body';
import { useLargeTextContent } from '@/plugins/message-rendering/large-text-loader';
import { ChatImageLightbox } from '@/plugins/message-rendering/ChatImageLightbox';
import { ContentNotices } from '@/plugins/message-rendering/content-notices';
import {
  UserMessageMedia,
  UserMessageMetaBar,
  type MessageLightboxState,
} from '@/plugins/message-rendering/chat-message-parts';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { AttachedFileMeta } from './attachments';

export const ChatMessage = memo(function ChatMessage({
  item,
  userAvatarImageUrl,
  sessionIdentity,
  endpointSessionId,
  onReuseMessage,
  onOpenFile,
}: ChatMessageProps) {
  const [lightboxImg, setLightboxImg] = useState<(MessageLightboxState & { sessionIdentity?: SessionIdentity }) | null>(null);
  const contextTags = useContributions(messageContextTags);
  const largeTextContent = useLargeTextContent({
    initialText: item.text,
    itemKey: item.key,
    largeText: item.largeText,
    sessionIdentity,
    endpointSessionId,
  });
  const message = readTaggedMessage(largeTextContent.text, contextTags, largeTextContent.complete);
  const reuseMessage = () => {
    if (!onReuseMessage) return;
    if (item.largeText) {
      largeTextContent.loadAll(onReuseMessage);
    } else {
      onReuseMessage(item.text);
    }
  };

  const hasText = !!item.largeText || message.text.trim().length > 0;
  const hasContexts = message.contexts.length > 0;
  if (!hasText && !hasContexts && item.images.length === 0 && item.attachedFiles.length === 0 && !item.contentNotices?.length) return null;

  return (
    <>
      <MessageShell
        isUser
        userAvatarImageUrl={userAvatarImageUrl}
      >
        <UserMessageMedia
          images={item.images}
          attachedFiles={item.attachedFiles}
          sessionIdentity={sessionIdentity}
          onOpenFile={onOpenFile}
          onPreview={(preview) => setLightboxImg({ ...preview, sessionIdentity })}
        />

        <ContentNotices notices={item.contentNotices} />

        {hasContexts && <div className="space-y-2">
          {message.contexts.map((context, index) => <div key={index} className="max-w-prose space-y-1 break-words text-sm">
            <p className="font-medium">{context.name}</p>
            {context.prompt !== undefined && <p className="whitespace-pre-wrap">{context.prompt}</p>}
          </div>)}
        </div>}

        {hasText && (
          <UserMessageBody
            text={message.text}
            loadMoreButton={largeTextContent.loadMoreButton}
          />
        )}

        <UserMessageMetaBar
          timestamp={item.createdAt}
          onReuse={(hasText || hasContexts) && onReuseMessage ? reuseMessage : undefined}
          loading={largeTextContent.loading}
        />
      </MessageShell>

      {lightboxImg && (
        <ChatImageLightbox
          src={lightboxImg.src}
          fileName={lightboxImg.fileName}
          filePath={lightboxImg.filePath}
          mediaReference={lightboxImg.mediaReference}
          mimeType={lightboxImg.mimeType}
          sessionIdentity={lightboxImg.sessionIdentity}
          onClose={() => setLightboxImg(null)}
        />
      )}
    </>
  );
});

interface ChatMessageProps {
  item: ChatUserMessageItem;
  userAvatarImageUrl?: string | null;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  onReuseMessage?: (text: string) => void;
  onOpenFile?: (file: AttachedFileMeta) => boolean | void;
}
