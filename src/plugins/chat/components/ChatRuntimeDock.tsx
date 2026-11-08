import { AlertCircle, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApprovalDecision, ApprovalItem, ChatSessionRuntimeErrorDetail, ChatSessionRuntimeNotice } from '@/plugins/chat/store';
import type { SessionApprovalDetails, SessionApprovalScope, SessionApprovalText } from '@/types/session/snapshot';
import { stringifySessionToolPayload } from '@/plugins/chat/store/session-projection-facts';
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

function approvalLabel(approval: ApprovalItem, translate: (key: string) => string): string | SessionApprovalText {
  const details = approval.details;
  if (details?.kind === 'tool') return details.toolName;
  if (details?.kind === 'exec') return translate('approval.commandRequest');
  if (details?.kind === 'plugin' || details?.kind === 'system-agent') return details.title;
  return isGenericApprovalTitle(approval.title) ? translate('approval.requestLabel') : approval.title.trim();
}

function ApprovalField({ label, value, mono = false, heading = false }: {
  label: string;
  value?: string | SessionApprovalText | null;
  mono?: boolean;
  heading?: boolean;
}) {
  const { t } = useTranslation('chat');
  if (value == null) return null;
  const text = typeof value === 'string' ? value : value.text;
  const shownBytes = typeof value === 'string' ? null : new TextEncoder().encode(text).length;
  return (
    <div>
      <dt className={heading ? 'sr-only' : 'font-medium text-muted-foreground'}>{label}</dt>
      <dd>
        <div role="region" tabIndex={0} aria-label={label} className={cn('max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 [overflow-wrap:anywhere]', mono && 'font-mono')}>
          {text}
        </div>
        {typeof value !== 'string' && shownBytes !== null && value.totalBytes > shownBytes ? (
          <p role="note" className="mt-0.5 font-medium text-foreground">{t('approval.textIncomplete', { shownBytes, totalBytes: value.totalBytes })}</p>
        ) : null}
      </dd>
    </div>
  );
}

function ApprovalScopeFields({ scope }: { scope?: SessionApprovalScope }) {
  const { t } = useTranslation('chat');
  if (!scope) return null;
  return (
    <div className="mt-2 text-xs leading-5" role="group" aria-label={t('approval.scopeLabel')}>
      <div className="font-medium text-foreground">{t('approval.scopeLabel')}</div>
      <dl className="mt-1 space-y-1">
        <ApprovalField label={t('approval.scopeKind')} value={t(`approval.scopeKinds.${scope.kind}`)} />
        {scope.kind === 'standing-grant' ? (
          <>
            <ApprovalField label={t('approval.automation')} value={scope.automation} />
            <ApprovalField label={t('approval.command')} value={scope.command} mono />
            {scope.expiresInDays !== undefined ? <ApprovalField label={t('approval.expiresInDays')} value={String(scope.expiresInDays)} /> : null}
          </>
        ) : (
          <ApprovalField label={t('approval.target')} value={scope.target} mono />
        )}
        {scope.kind === 'message-send' ? (
          <>
            <ApprovalField label={t('approval.recipientCount')} value={String(scope.recipientCount)} />
            {scope.recipients?.map((recipient, index) => <ApprovalField key={index} label={t('approval.recipientPreview')} value={recipient} mono />)}
            {scope.audience ? <ApprovalField label={t('approval.audienceLabel')} value={t(`approval.audiences.${scope.audience}`)} /> : null}
          </>
        ) : null}
        {scope.kind === 'payment' ? (
          <>
            <ApprovalField label={t('approval.amount')} value={scope.amount} />
            <ApprovalField label={t('approval.currency')} value={scope.currency} />
          </>
        ) : null}
        {scope.kind === 'external-post' ? <ApprovalField label={t('approval.visibilityLabel')} value={t(`approval.visibility.${scope.visibility}`)} /> : null}
      </dl>
    </div>
  );
}

function ApprovalDetailFields({ details }: { details: SessionApprovalDetails }) {
  const { t } = useTranslation('chat');
  const [parametersOpen, setParametersOpen] = useState(false);
  if (details.kind === 'tool') {
    const input = details.input;
    return (
      <>
        {input.kind === 'omitted' ? (
          <p role="note" className="mt-1 text-xs font-medium leading-5 text-foreground">{t('approval.parametersOmitted', { totalBytes: input.totalBytes })}</p>
        ) : null}
        <dl className="mt-1 space-y-1 text-xs leading-5">
          {input.kind === 'complete' ? ['command', 'file_path', 'path', 'url'].map((name) => {
            const value = input.value[name];
            return typeof value === 'string' ? <ApprovalField key={name} label={t(`approval.${name}`)} value={value} mono /> : null;
          }) : input.targets.map((target) => <ApprovalField key={target.name} label={t(`approval.${target.name}`)} value={target} mono />)}
          <ApprovalField label={t('approval.decisionReason')} value={details.decisionReason} />
          <ApprovalField label={t('approval.blockedPath')} value={details.blockedPath} mono />
        </dl>
        {input.kind === 'complete' ? (
          <details className="mt-2 text-xs" open={parametersOpen} onToggle={(event) => setParametersOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20">
              {t('approval.parameters')}
            </summary>
            {parametersOpen ? <pre tabIndex={0} aria-label={t('approval.parameters')} className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-background/50 p-2 font-mono leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 [overflow-wrap:anywhere]">
              {stringifySessionToolPayload(input.value, true)}
            </pre> : null}
          </details>
        ) : null}
      </>
    );
  }
  return (
    <>
      <dl className="mt-1 space-y-1 text-xs leading-5">
        {details.kind === 'exec' ? (
          <>
            <ApprovalField label={t('approval.command')} value={details.commandText} mono />
            <ApprovalField label={t('approval.commandPreview')} value={details.commandPreview} mono />
            <ApprovalField label={t('approval.warning')} value={details.warningText} />
          </>
        ) : (
          <>
            <ApprovalField label={t('approval.description')} value={details.description} />
            {details.kind === 'plugin' ? (
              <>
                <ApprovalField label={t('approval.detail')} value={details.detail} mono />
                <ApprovalField label={t('approval.severityLabel')} value={t(`approval.severities.${details.severity}`)} />
              </>
            ) : null}
          </>
        )}
      </dl>
      {details.kind !== 'system-agent' ? <ApprovalScopeFields scope={details.scope} /> : null}
      <dl className="mt-2 space-y-1 text-xs leading-5">
        {details.kind === 'exec' ? (
          <>
            <ApprovalField label={t('approval.host')} value={details.host} mono />
            <ApprovalField label={t('approval.nodeId')} value={details.nodeId} mono />
          </>
        ) : null}
        {details.kind === 'plugin' ? (
          <>
            <ApprovalField label={t('approval.pluginId')} value={details.pluginId} mono />
            <ApprovalField label={t('approval.toolName')} value={details.toolName} mono />
            {details.externalResolution ? (
              <>
                <ApprovalField label={t('approval.externalResolution')} value={details.externalResolution.label} />
                <ApprovalField label={t('approval.externalDecisions')} value={details.externalResolution.decisions.map((decision) => decisionLabel(decision, t)).join(' · ')} />
              </>
            ) : null}
          </>
        ) : null}
        <ApprovalField label={t('approval.agentId')} value={details.agentId} mono />
        {details.kind === 'system-agent' ? <ApprovalField label={t('approval.proposalHash')} value={details.proposalHash} mono /> : null}
      </dl>
    </>
  );
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
  const details = approval?.details;
  const description = approval && details?.kind === 'tool' && !isGenericApprovalTitle(approval.title) && approval.title.trim() !== details.toolName.trim()
    ? approval.title.trim() : null;
  const extraCount = Math.max(0, approvals.length - 1);

  return (
    <div className={CHAT_LAYOUT_TOKENS.inputPanel} data-chat-composer-wheel-local="true" data-testid="chat-approval-dock">
      <div className={cn(CHAT_LAYOUT_TOKENS.inputPanelBody, 'flex items-start gap-3')} data-chat-composer-wheel-local="true">
        <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground">
          {approval ? <ShieldCheck className="h-4 w-4" /> : <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <dl className="min-w-0 flex-1 break-words font-medium leading-5 text-foreground">
              <ApprovalField label={t('approval.panelTitle')} value={approval ? approvalLabel(approval, t) : waitingLabel} heading />
            </dl>
            {extraCount > 0 ? (
              <span className="shrink-0 text-xs font-medium leading-5 text-muted-foreground">
                +{extraCount}
              </span>
            ) : null}
          </div>
          {description ? (
            <div tabIndex={0} className="mt-1 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 [overflow-wrap:anywhere]">
              {description}
            </div>
          ) : null}
          {approval && details ? <ApprovalDetailFields key={approval.id} details={details} /> : null}
          {approval && !details && approval.command ? (
            <dl className="mt-1 text-xs leading-5">
              <ApprovalField label={t('approval.command')} value={approval.command} mono />
            </dl>
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
