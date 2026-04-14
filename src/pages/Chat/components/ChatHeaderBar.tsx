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
    <div className="flex shrink-0 items-center justify-end px-2 py-2 md:px-4">
      {showBackgroundStatus && (
        <div className="mr-2 inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>{refreshing ? statusRefreshingLabel : statusMutatingLabel}</span>
        </div>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mr-2 h-8"
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
