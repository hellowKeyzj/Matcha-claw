import { useState, memo } from 'react';
import type { ChatUserMessageItem } from './chat-render-item-model';
import { MessageShell } from './chat-message-shell';
import { UserMessageBody } from './user-message-body';
import { useLargeTextContent } from './large-text-loader';
import { ChatImageLightbox } from './components/ChatImageLightbox';
import {
  UserMessageMedia,
  UserMessageMetaBar,
  type MessageLightboxState,
} from './chat-message-parts';
import type { SessionIdentity } from '../../types/desktop/runtime-address';

export const ChatMessage = memo(function ChatMessage({
  item,
  userAvatarImageUrl,
  sessionIdentity,
  endpointSessionId,
  onReuseMessage,
}: ChatMessageProps) {
  const [lightboxImg, setLightboxImg] = useState<MessageLightboxState | null>(null);
  const largeTextContent = useLargeTextContent({
    initialText: item.text,
    itemKey: item.key,
    largeText: item.largeText,
    sessionIdentity,
    endpointSessionId,
  });
  const reuseMessage = () => {
    if (!onReuseMessage) return;
    if (item.largeText) {
      largeTextContent.loadAll(onReuseMessage);
    } else {
      onReuseMessage(item.text);
    }
  };

  const hasText = !!item.largeText || item.text.trim().length > 0;
  if (!hasText && item.images.length === 0 && item.attachedFiles.length === 0) return null;

  return (
    <>
      <MessageShell
        isUser
        userAvatarImageUrl={userAvatarImageUrl}
      >
        <UserMessageMedia
          images={item.images}
          attachedFiles={item.attachedFiles}
          onPreview={setLightboxImg}
        />

        {hasText && (
          <UserMessageBody
            text={largeTextContent.text}
            loadMoreButton={largeTextContent.loadMoreButton}
          />
        )}

        <UserMessageMetaBar
          timestamp={item.createdAt}
          onReuse={hasText && onReuseMessage ? reuseMessage : undefined}
          loading={largeTextContent.loading}
        />
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

interface ChatMessageProps {
  item: ChatUserMessageItem;
  userAvatarImageUrl?: string | null;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
  onReuseMessage?: (text: string) => void;
}
