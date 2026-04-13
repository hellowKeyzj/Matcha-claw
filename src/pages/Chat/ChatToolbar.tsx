/**
 * Chat Toolbar
 * Session selector, new session, refresh, and thinking toggle.
 * Rendered in the Header when on the Chat page.
 */
import { RefreshCw, Brain } from 'lucide-react';
import { memo } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

export const ChatToolbar = memo(function ChatToolbar() {
  const refresh = useChatStore((s) => s.refresh);
  const initialLoading = useChatStore((s) => s.initialLoading);
  const refreshing = useChatStore((s) => s.refreshing);
  const showThinking = useChatStore((s) => s.showThinking);
  const toggleThinking = useChatStore((s) => s.toggleThinking);
  const { t } = useTranslation('chat');
  const refreshBusy = initialLoading || refreshing;

  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => refresh()}
            disabled={refreshBusy}
          >
            <RefreshCw className={cn('h-4 w-4', refreshBusy && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('toolbar.refresh')}</p>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              'h-8 w-8',
              showThinking && 'bg-secondary text-foreground',
            )}
            onClick={toggleThinking}
          >
            <Brain className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{showThinking ? t('toolbar.hideThinking') : t('toolbar.showThinking')}</p>
        </TooltipContent>
      </Tooltip>
    </div>
  );
});
