import { memo } from 'react';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';

interface UserMessageBodyProps {
  text: string;
}

export const UserMessageBody = memo(function UserMessageBody({
  text,
}: UserMessageBodyProps) {
  return (
    <div className={CHAT_LAYOUT_TOKENS.userBubble}>
      <p className="whitespace-pre-wrap break-words text-[14px] leading-[1.58]">{text}</p>
    </div>
  );
});
