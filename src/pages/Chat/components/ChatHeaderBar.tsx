import { Loader2, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatToolbar } from '../ChatToolbar';

export function ChatHeaderBar({
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
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full border border-border/45 bg-background/58 p-1.5 shadow-[0_10px_30px_rgba(15,23,42,0.055)] backdrop-blur-xl">
      {showBackgroundStatus && (
        <div className="inline-flex items-center gap-1 rounded-full border border-border/45 bg-background/78 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{refreshing ? statusRefreshingLabel : statusMutatingLabel}</span>
        </div>
      )}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 rounded-full border border-border/40 bg-background/70 px-3 text-xs text-muted-foreground shadow-none hover:bg-background/84 hover:text-foreground"
        disabled={!hasCurrentAgent}
        onClick={onOpenSkillConfig}
      >
        <Settings2 className="mr-1 h-3.5 w-3.5" />
        {skillConfigLabel}
      </Button>
      <ChatToolbar />
    </div>
  );
}
