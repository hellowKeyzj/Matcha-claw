import { memo } from 'react';
import type { AgentAvatarStyle } from '@/lib/agent-avatar';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from './chat-layout-tokens';
import { MessageShell } from './chat-message-shell';

interface PendingAssistantShellProps {
  state: 'typing' | 'activity';
  assistantAgentId?: string;
  assistantAgentName?: string;
  assistantAvatarSeed?: string;
  assistantAvatarStyle?: AgentAvatarStyle;
  userAvatarImageUrl?: string | null;
}

export const PendingAssistantShell = memo(function PendingAssistantShell({
  state,
  assistantAgentId,
  assistantAgentName,
  assistantAvatarSeed,
  assistantAvatarStyle,
  userAvatarImageUrl,
}: PendingAssistantShellProps) {
  return (
    <MessageShell
      isUser={false}
      assistantAgentId={assistantAgentId}
      assistantAgentName={assistantAgentName}
      assistantAvatarSeed={assistantAvatarSeed}
      assistantAvatarStyle={assistantAvatarStyle}
      userAvatarImageUrl={userAvatarImageUrl}
    >
      <div
        data-chat-body-mode="streaming"
        className={cn(
          CHAT_LAYOUT_TOKENS.assistantSurface,
          'relative',
        )}
      >
        {state === 'activity' ? (
          <div className="flex min-h-[34px] items-center gap-2 px-0.5 py-1.5 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span>Processing tool results...</span>
          </div>
        ) : (
          <div className="flex min-h-[34px] items-center px-0.5 py-1.5">
            <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground/50 align-text-bottom" />
          </div>
        )}
      </div>
    </MessageShell>
  );
});
