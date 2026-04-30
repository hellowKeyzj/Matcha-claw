import { AlertCircle, Loader2 } from 'lucide-react';
import type { ApprovalDecision, ApprovalItem } from '@/stores/chat';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';
import { ApprovalActionsPanel } from './ChatStates';

export function ChatErrorBanner({
  error,
  dismissLabel,
  onDismiss,
}: {
  error: string;
  dismissLabel: string;
  onDismiss: () => void;
}) {
  return (
    <div className={CHAT_LAYOUT_TOKENS.runtimeDockRail}>
      <div className="flex items-center justify-between gap-3 rounded-[22px] border border-destructive/14 bg-background/92 px-4 py-3 shadow-[0_10px_30px_rgba(220,38,38,0.045)] backdrop-blur-xl">
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </p>
        <button
          onClick={onDismiss}
          className="rounded-full border border-destructive/16 bg-background/80 px-2.5 py-1 text-[11px] text-destructive/72 transition-colors hover:bg-background/90 hover:text-destructive"
        >
          {dismissLabel}
        </button>
      </div>
    </div>
  );
}

export function ChatApprovalDock({
  waitingLabel,
  approvals,
  onResolve,
}: {
  waitingLabel: string;
  approvals: ApprovalItem[];
  onResolve: (id: string, decision: ApprovalDecision) => void;
}) {
  return (
    <div className={CHAT_LAYOUT_TOKENS.runtimeDockRail} data-testid="chat-approval-dock">
      <div className="rounded-[22px] border border-primary/14 bg-background/92 px-4 py-3 shadow-[0_10px_30px_rgba(37,99,235,0.045)] backdrop-blur-xl">
        <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>{waitingLabel}</span>
        </div>
        {approvals.length > 0 && (
          <ApprovalActionsPanel
            approvals={approvals}
            onResolve={(id, decision) => onResolve(id, decision)}
          />
        )}
      </div>
    </div>
  );
}
