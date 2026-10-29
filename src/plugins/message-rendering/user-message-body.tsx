import { memo, type ReactNode } from 'react';
import { MESSAGE_LAYOUT_TOKENS } from '@/plugins/message-rendering/message-layout-tokens';

interface UserMessageBodyProps {
  text: string;
  loadMoreButton?: ReactNode;
}

export const UserMessageBody = memo(function UserMessageBody({
  text,
  loadMoreButton,
}: UserMessageBodyProps) {
  return (
    <div className={MESSAGE_LAYOUT_TOKENS.userBubble}>
      <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.58]">{text}</p>
      {loadMoreButton}
    </div>
  );
});
