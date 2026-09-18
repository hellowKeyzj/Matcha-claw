import { AlertCircle, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ApprovalDecision, ApprovalItem, ChatSessionRuntimeErrorDetail, ChatSessionRuntimeNotice } from '@/stores/chat';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from '../chat-layout-tokens';

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

function runtimeDetailParts(detail: ChatSessionRuntimeErrorDetail): string[] {
  return [
    detail.failoverReason,
    detail.providerRuntimeFailureKind,
    detail.providerErrorType,
    detail.providerErrorMessagePreview,
    detail.httpStatus ? `HTTP ${detail.httpStatus}` : null,
  ].filter((part): part is string => Boolean(part));
}

function guardianTitle(notice: ChatSessionRuntimeNotice, translate: (key: string) => string): string {
  switch (notice.kind) {
    case 'guardian_reviewing':
      return translate('runtimeStatus.guardian.reviewing');
    case 'guardian_approved':
      return translate('runtimeStatus.guardian.approved');
    case 'guardian_denied':
      return translate('runtimeStatus.guardian.denied');
    case 'guardian_warning':
      return translate('runtimeStatus.guardian.warning');
    case 'guardian_strict_review_required':
      return translate('runtimeStatus.guardian.strictReviewRequired');
  }
}

function guardianDetail(notice: ChatSessionRuntimeNotice): string | null {
  return notice.command || notice.riskLevel || notice.rationale || notice.message;
}

export function ChatRuntimeStatusDock({
  compacting,
  errorDetail,
  runtimeNotice = null,
}: {
  compacting: boolean;
  errorDetail: ChatSessionRuntimeErrorDetail | null;
  runtimeNotice?: ChatSessionRuntimeNotice | null;
}) {
  const { t } = useTranslation('chat');
  const detailParts = errorDetail ? runtimeDetailParts(errorDetail) : [];
  const guardian = runtimeNotice;
  if (!compacting && detailParts.length === 0 && !guardian) {
    return null;
  }

  const title = compacting ? t('pending.compacting') : guardian ? guardianTitle(guardian, t) : t(errorDetail?.kind === 'fallback' ? 'runtimeStatus.providerFallback' : 'runtimeStatus.runtimeError');
  const detail = compacting ? null : guardian ? guardianDetail(guardian) : detailParts.join(' · ');

  return (
    <div className={CHAT_LAYOUT_TOKENS.runtimeDockRail} data-testid="chat-runtime-status-dock">
      <div className="flex min-h-11 items-center gap-3 rounded-[18px] border border-border/55 bg-background/94 px-3 py-2 shadow-[0_12px_34px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:shadow-[0_16px_44px_rgba(0,0,0,0.24)]">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/55 bg-card text-muted-foreground shadow-sm">
          {compacting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : guardian ? <ShieldCheck className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium leading-5 text-foreground">
            {title}
          </div>
          {detail ? (
            <div className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground/78" title={detail}>
              {detail}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function isGenericApprovalTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return !normalized || normalized === 'approval required' || normalized === '审批待处理';
}

function approvalLabel(approval: ApprovalItem, translate: (key: string) => string): string {
  return isGenericApprovalTitle(approval.title) ? translate('approval.requestLabel') : approval.title.trim();
}

function approvalDetail(approval: ApprovalItem): string | null {
  const command = approval.command?.trim();
  return command || null;
}

function decisionLabel(decision: ApprovalDecision, translate: (key: string) => string): string {
  switch (decision) {
    case 'allow-once':
      return translate('approval.allowOnce');
    case 'allow-always':
      return translate('approval.allowAlways');
    case 'deny':
      return translate('approval.deny');
  }
}

function decisionButtonClassName(decision: ApprovalDecision): string {
  if (decision === 'allow-once') {
    return 'border-foreground bg-foreground text-background hover:bg-foreground/90';
  }
  if (decision === 'allow-always') {
    return 'border-border/55 bg-background/78 text-foreground hover:bg-secondary';
  }
  return 'border-transparent bg-transparent text-muted-foreground hover:bg-destructive/8 hover:text-destructive';
}

export function ChatApprovalDock({
  waitingLabel,
  approvals,
  onResolve,
}: {
  waitingLabel: string;
  approvals: ApprovalItem[];
  onResolve: (approval: ApprovalItem, decision: ApprovalDecision) => void;
}) {
  const { t } = useTranslation('chat');
  const approval = approvals[0] ?? null;
  const approvalCommand = approval ? approvalDetail(approval) : null;
  const extraCount = Math.max(0, approvals.length - 1);

  return (
    <div className={CHAT_LAYOUT_TOKENS.runtimeDockRail} data-testid="chat-approval-dock">
      <div className="flex min-h-12 items-center gap-3 rounded-[18px] border border-border/55 bg-background/94 px-3 py-2 shadow-[0_12px_34px_rgba(15,23,42,0.10)] backdrop-blur-xl dark:shadow-[0_16px_44px_rgba(0,0,0,0.28)]">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/55 bg-card text-muted-foreground shadow-sm">
          {approval ? <ShieldCheck className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium leading-5 text-foreground">
              {approval ? approvalLabel(approval, t) : waitingLabel}
            </span>
            {extraCount > 0 ? (
              <span className="shrink-0 rounded-full border border-border/45 bg-card px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                +{extraCount}
              </span>
            ) : null}
          </div>
          {approvalCommand ? (
            <div className="mt-0.5 truncate font-mono text-[11px] leading-4 text-muted-foreground/78" title={approvalCommand}>
              {approvalCommand}
            </div>
          ) : null}
        </div>
        {approval && approval.allowedDecisions.length > 0 ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {approval.allowedDecisions.map((decision) => {
              const label = decisionLabel(decision, t);
              return (
                <button
                  key={decision}
                  type="button"
                  onClick={() => onResolve(approval, decision)}
                  className={cn(
                    'h-8 rounded-full border px-3 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20',
                    decisionButtonClassName(decision),
                  )}
                  aria-label={label}
                >
                  {label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
