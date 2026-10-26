import { AlertCircle, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ApprovalDecision, ApprovalItem, ChatSessionRuntimeErrorDetail, ChatSessionRuntimeNotice } from '@/plugins/chat/store';
import { cn } from '@/lib/utils';
import { CHAT_LAYOUT_TOKENS } from '@/plugins/chat/chat-layout-tokens';

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
    <div className={CHAT_LAYOUT_TOKENS.inputBannerItem} role="alert">
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 break-words text-destructive">{error}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-full px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {dismissLabel}
      </button>
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
    <div className={CHAT_LAYOUT_TOKENS.inputBannerItem} data-testid="chat-runtime-status-dock" role="status">
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground">
        {compacting ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> : guardian ? <ShieldCheck className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words font-medium text-foreground">
          {title}
        </div>
        {detail ? (
          <div className="mt-0.5 break-words text-xs text-muted-foreground" title={detail}>
            {detail}
          </div>
        ) : null}
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
    return 'border-border/55 bg-background/95 text-foreground hover:bg-secondary';
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
    <div className={CHAT_LAYOUT_TOKENS.inputPanel} data-chat-composer-wheel-local="true" data-testid="chat-approval-dock">
      <div className={cn(CHAT_LAYOUT_TOKENS.inputPanelBody, 'flex items-start gap-3')} data-chat-composer-wheel-local="true">
        <span className="mt-0.5 shrink-0 text-muted-foreground">
          {approval ? <ShieldCheck className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <span className="min-w-0 flex-1 break-words font-medium leading-5 text-foreground">
              {approval ? approvalLabel(approval, t) : waitingLabel}
            </span>
            {extraCount > 0 ? (
              <span className="shrink-0 text-xs font-medium leading-5 text-muted-foreground">
                +{extraCount}
              </span>
            ) : null}
          </div>
          {approvalCommand ? (
            <div className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground" title={approvalCommand}>
              {approvalCommand}
            </div>
          ) : null}
        </div>
      </div>
      {approval && approval.allowedDecisions.length > 0 ? (
        <div className={cn(CHAT_LAYOUT_TOKENS.inputPanelFooter, 'flex flex-wrap items-center justify-end gap-1.5')}>
          {approval.allowedDecisions.map((decision) => {
            const label = decisionLabel(decision, t);
            return (
              <button
                key={decision}
                type="button"
                onClick={() => onResolve(approval, decision)}
                className={cn(
                  'min-h-8 min-w-0 max-w-full whitespace-normal break-words rounded-full border px-3 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20',
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
  );
}
