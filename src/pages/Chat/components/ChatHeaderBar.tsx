import { Brain, PanelRightClose, PanelRightOpen, RefreshCw } from 'lucide-react';
import { memo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

const HEADER_BUTTON_CLASSNAME = 'h-8 w-8 rounded-md border-0 bg-transparent p-0 text-muted-foreground shadow-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:ring-0 focus-visible:ring-offset-0';
const HEADER_TOOLTIP_PROPS = {
  side: 'bottom' as const,
  align: 'end' as const,
  sideOffset: 8,
};

export const ChatHeaderBar = memo(function ChatHeaderBar({
  onRefresh,
  refreshBusy,
  showThinking,
  onToggleThinking,
  sidePanelOpen,
  unfinishedTaskCount,
  onToggleSidePanel,
}: {
  onRefresh: () => void;
  refreshBusy: boolean;
  showThinking: boolean;
  onToggleThinking: () => void;
  sidePanelOpen: boolean;
  unfinishedTaskCount: number;
  onToggleSidePanel: () => void;
}) {
  const { t } = useTranslation('chat');
  const sidePanelToggleLabel = sidePanelOpen
    ? t('toolbar.closeSidePanel')
    : t('toolbar.openSidePanel');

  return (
    <div className="flex items-start justify-end gap-2">
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={HEADER_BUTTON_CLASSNAME}
              onClick={onRefresh}
              disabled={refreshBusy}
            >
              <RefreshCw className={cn('h-4 w-4', refreshBusy && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent {...HEADER_TOOLTIP_PROPS}>
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
                showThinking && 'bg-secondary text-foreground',
              )}
              onClick={onToggleThinking}
            >
              <Brain className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent {...HEADER_TOOLTIP_PROPS}>
            <p>{showThinking ? t('toolbar.hideThinking') : t('toolbar.showThinking')}</p>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <div className="relative">
              <Button
                variant="ghost"
              size="icon"
              aria-label={sidePanelToggleLabel}
              className={cn(
                HEADER_BUTTON_CLASSNAME,
                sidePanelOpen && 'bg-secondary text-foreground',
              )}
              onClick={onToggleSidePanel}
            >
                {sidePanelOpen ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRightOpen className="h-4 w-4" />
                )}
              </Button>
              {unfinishedTaskCount > 0 ? (
                <Badge
                  variant="secondary"
                  className="pointer-events-none absolute -right-1 -top-1 h-5 min-w-5 justify-center px-1.5 text-[10px]"
                >
                  {unfinishedTaskCount}
                </Badge>
              ) : null}
            </div>
          </TooltipTrigger>
          <TooltipContent {...HEADER_TOOLTIP_PROPS}>
            <p>{sidePanelToggleLabel}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
});
