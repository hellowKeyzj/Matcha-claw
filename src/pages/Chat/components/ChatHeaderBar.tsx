import { Brain, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/stores/chat';
import { selectChatToolbarState } from '@/stores/chat/selectors';
import { useTranslation } from 'react-i18next';

const HEADER_BUTTON_CLASSNAME = 'h-8 rounded-full border border-border/40 bg-background/70 text-muted-foreground shadow-none hover:bg-background/84 hover:text-foreground';

export const ChatHeaderBar = memo(function ChatHeaderBar({
  showBackgroundStatus,
  refreshing,
  hasCurrentAgent,
  onOpenSkillConfig,
  skillConfigLabel,
  statusRefreshingLabel,
  statusMutatingLabel,
}: {
  showBackgroundStatus: boolean;
  refreshing: boolean;
  hasCurrentAgent: boolean;
  onOpenSkillConfig: () => void;
  skillConfigLabel: string;
  statusRefreshingLabel: string;
  statusMutatingLabel: string;
}) {
  const {
    refresh,
    foregroundHistorySessionKey,
    sessionMetasResource,
    showThinking,
    toggleThinking,
  } = useChatStore(useShallow(selectChatToolbarState));
  const { t } = useTranslation('chat');
  const refreshBusy = foregroundHistorySessionKey != null || sessionMetasResource.status === 'loading';

  return (
    <div className="flex items-start justify-end gap-2">
      {showBackgroundStatus && (
        <div className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border/45 bg-background/74 px-3 text-[11px] text-muted-foreground shadow-[0_8px_22px_rgba(15,23,42,0.05)] backdrop-blur-xl">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{refreshing ? statusRefreshingLabel : statusMutatingLabel}</span>
        </div>
      )}

      <div className="inline-flex items-center gap-1.5 rounded-full border border-border/45 bg-background/58 p-1.5 shadow-[0_10px_30px_rgba(15,23,42,0.055)] backdrop-blur-xl">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={`${HEADER_BUTTON_CLASSNAME} px-3 text-xs`}
          disabled={!hasCurrentAgent}
          onClick={onOpenSkillConfig}
        >
          <Settings2 className="mr-1 h-3.5 w-3.5" />
          {skillConfigLabel}
        </Button>

        <div className="h-5 w-px bg-border/45" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={HEADER_BUTTON_CLASSNAME}
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
                HEADER_BUTTON_CLASSNAME,
                showThinking && 'bg-secondary/62 text-foreground',
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
    </div>
  );
});

