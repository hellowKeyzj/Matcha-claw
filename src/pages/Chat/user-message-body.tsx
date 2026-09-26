import { memo } from 'react';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';
import { useLargeTextContent } from './large-text-loader';
import type { SessionIdentity } from '../../types/desktop/runtime-address';
import type { SessionLargeTextMetadata } from '../../types/session/tool-card';

interface UserMessageBodyProps {
  text: string;
  largeText?: SessionLargeTextMetadata;
  sessionIdentity?: SessionIdentity;
  endpointSessionId?: string | null;
}

export const UserMessageBody = memo(function UserMessageBody({
  text,
  largeText,
  sessionIdentity,
  endpointSessionId,
}: UserMessageBodyProps) {
  const largeTextContent = useLargeTextContent({ initialText: text, largeText, sessionIdentity, endpointSessionId });
  return (
    <div className={CHAT_LAYOUT_TOKENS.userBubble}>
      <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.58]">{largeTextContent.text}</p>
      {largeTextContent.loadMoreButton}
    </div>
  );
});
