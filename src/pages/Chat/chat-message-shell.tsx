import type { ReactNode } from 'react';
import { User } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';

export type MessageAvatarSlot = 'visible' | 'placeholder';

interface MessageShellProps {
  isUser: boolean;
  assistantAgentId?: string;
  assistantAgentName?: string;
  assistantAvatarSeed?: string;
  assistantAvatarStyle?: AgentAvatarStyle;
  assistantAvatarSlot?: MessageAvatarSlot;
  userAvatarImageUrl?: string | null;
  children: ReactNode;
}

export function MessageShell({
  isUser,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
  assistantAvatarSlot = 'visible',
  userAvatarImageUrl,
  children,
}: MessageShellProps) {
  return (
    <div
      className={cn(
        CHAT_LAYOUT_TOKENS.messageShell,
        isUser
          ? CHAT_LAYOUT_TOKENS.messageShellUserColumns
          : CHAT_LAYOUT_TOKENS.messageShellAssistantColumns,
      )}
    >
      <div
        className={cn(
          CHAT_LAYOUT_TOKENS.messageAvatar,
          isUser
            ? CHAT_LAYOUT_TOKENS.messageAvatarUserOrder
            : CHAT_LAYOUT_TOKENS.messageAvatarAssistantOrder,
          !isUser && assistantAvatarSlot === 'placeholder'
            ? 'pointer-events-none opacity-0'
            : 'border border-border/60 bg-card text-foreground shadow-sm',
        )}
        aria-hidden={!isUser && assistantAvatarSlot === 'placeholder' ? 'true' : undefined}
      >
        {!isUser && assistantAvatarSlot === 'placeholder' ? null : isUser ? (
          userAvatarImageUrl ? (
            <img
              src={userAvatarImageUrl}
              alt="user-avatar"
              className="h-full w-full rounded-full object-cover"
            />
          ) : (
            <User className="h-4 w-4" />
          )
        ) : (
          <AgentAvatar
            agentId={assistantAgentId}
            agentName={assistantAgentName}
            avatarSeed={assistantAvatarSeed}
            avatarStyle={assistantAvatarStyle}
            className="h-full w-full"
            dataTestId="assistant-message-avatar"
          />
        )}
      </div>

      <div
        className={cn(
          CHAT_LAYOUT_TOKENS.messageContentColumn,
          isUser
            ? CHAT_LAYOUT_TOKENS.messageContentUserOrder
            : CHAT_LAYOUT_TOKENS.messageContentAssistantOrder,
        )}
      >
        {children}
      </div>
    </div>
  );
}
