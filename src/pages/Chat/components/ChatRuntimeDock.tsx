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
    <div className="border-t border-destructive/20 bg-destructive/10 px-4 py-2">
      <div className={`flex items-center justify-between ${CHAT_LAYOUT_TOKENS.runtimeDockRail}`}>
        <p className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </p>
        <button
          onClick={onDismiss}
          className="text-xs text-destructive/60 underline hover:text-destructive"
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
    <div className="border-t border-primary/20 bg-card/70 px-4 py-3" data-testid="chat-approval-dock">
      <div className={CHAT_LAYOUT_TOKENS.runtimeDockRail}>
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
