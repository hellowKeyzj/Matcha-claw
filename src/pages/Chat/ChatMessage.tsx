import { useState, memo } from 'react';
import type { ChatUserMessageItem } from './chat-render-item-model';
import { MessageShell } from './chat-message-shell';
import { UserMessageBody } from './user-message-body';
import { ChatImageLightbox } from './components/ChatImageLightbox';
import {
  UserMessageMedia,
  UserMessageMetaBar,
  type MessageLightboxState,
} from './chat-message-parts';

export const ChatMessage = memo(function ChatMessage({
  item,
  userAvatarImageUrl,
}: ChatMessageProps) {
  const [lightboxImg, setLightboxImg] = useState<MessageLightboxState | null>(null);

  const hasText = item.text.trim().length > 0;
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
          <UserMessageBody text={item.text} />
        )}

        <UserMessageMetaBar timestamp={item.createdAt} />
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
}
