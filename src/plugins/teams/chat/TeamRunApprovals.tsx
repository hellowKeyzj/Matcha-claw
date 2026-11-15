import { useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowRight, CheckCircle2, Clock3, Loader2, UserCheck, X, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { TeamRoleBindingRecord } from '@/types/team-design';
import type { TeamRunScope } from '@/types/desktop/runtime-address';
import type { RunWorkspaceProjection, TeamArtifactRecord } from '@/types/team-workspace';
import { TeamNodeDeliveries } from '../pages/TeamNodeDeliveries';
import { TeamFilePreview } from '../pages/TeamFilePreview';
import { TeamApprovalDraftsContext } from './team-approval-drafts';
import type { TeamApprovalRecord, TeamApprovalResolutionDecision } from '../services/team-runtime-client';
import { isTeamApprovalActionable, type TeamApprovalRunEligibility } from '../approval-projection';

type TeamRunApprovalsProps = {
  approvals: TeamApprovalRecord[];
  runEligibility: TeamApprovalRunEligibility;
  artifacts: TeamArtifactRecord[];
  roles: TeamRoleBindingRecord[];
  fileScope?: TeamRunScope;
  workspaceStatus?: RunWorkspaceProjection['status'];
  disabled: boolean;
  onReveal: () => void;
  canEdit: boolean;
  canMutate: boolean;
  pendingAction: string | null;
  onResolve: (approvalId: string, decision: TeamApprovalResolutionDecision, note?: string) => Promise<void>;
};

export function TeamApprovalDrafts({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const drafts = useMemo(() => ({ notes, setNotes }), [notes]);
  return <TeamApprovalDraftsContext.Provider value={drafts}>{children}</TeamApprovalDraftsContext.Provider>;
}

export function ApprovalRecord({ approval, runEligibility, artifacts, roles, fileScope, workspaceStatus, disabled, onReveal, canEdit, canMutate, pendingAction, onResolve, showReviewer = false, inDialog = false, previewing = false, hidden = false }: Omit<TeamRunApprovalsProps, 'approvals'> & {
  approval: TeamApprovalRecord;
  showReviewer?: boolean;
  inDialog?: boolean;
  previewing?: boolean;
  hidden?: boolean;
}) {
  const { t, i18n } = useTranslation('teams');
  const drafts = useContext(TeamApprovalDraftsContext);
  if (!drafts) throw new Error('TeamApprovalDrafts is required');
  const title = approval.content?.title ?? t(`run.approvalSubject.${approval.subject}`);
  const requestedAction = approval.subject === 'human_decision' && approval.requestedAction === 'continue_node' ? ''
    : t(`workspace.approvalActions.${approval.requestedAction}`, { defaultValue: approval.requestedAction });
  const reason = ['Human decision required.', 'Agent requested approval.'].includes(approval.reason) ? '' : approval.reason;
  const risk = approval.content === null && ['Review this decision before continuing.', 'Agent supplied no public risk summary.'].includes(approval.risk) ? '' : approval.risk;
  const materials = artifacts.filter((artifact) => artifact.runId === approval.runId && approval.content?.artifactIds.includes(artifact.artifactId));
  const noteId = useId();
  const note = drafts.notes[approval.approvalId] ?? approval.note ?? '';
  const setNote = (value: string) => drafts.setNotes((notes) => ({ ...notes, [approval.approvalId]: value }));
  const [pendingDecision, setPendingDecision] = useState<TeamApprovalResolutionDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lifetimeRef = useRef<{ pending: boolean } | null>(null);
  useLayoutEffect(() => {
    lifetimeRef.current = { pending: false };
    return () => { lifetimeRef.current = null; };
  }, []);
  const canResolve = canEdit && isTeamApprovalActionable(approval, runEligibility);
  const pending = pendingDecision !== null || pendingAction === `approval:${approval.approvalId}`;
  const submit = async (decision: TeamApprovalResolutionDecision): Promise<void> => {
    const lifetime = lifetimeRef.current;
    if (!canResolve || !canMutate || !lifetime || lifetime.pending) return;
    lifetime.pending = true;
    setPendingDecision(decision);
    setError(null);
    try {
      await onResolve(approval.approvalId, decision, note || undefined);
    } catch (cause) {
      if (lifetimeRef.current === lifetime) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lifetime.pending = false;
      if (lifetimeRef.current === lifetime) setPendingDecision(null);
    }
  };
  const runCancelled = approval.status === 'pending' && runEligibility === 'cancelled';
  const statusTone = runCancelled ? 'text-muted-foreground' : approval.status === 'pending' ? 'text-amber-700 dark:text-amber-400'
    : approval.status === 'approved' ? 'text-emerald-700 dark:text-emerald-400'
      : approval.status === 'denied' ? 'text-destructive' : 'text-muted-foreground';

  const StatusIcon = runCancelled ? XCircle : approval.status === 'pending' ? Clock3 : approval.status === 'approved' ? CheckCircle2 : XCircle;

  const content = <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        {showReviewer ? <p className="mb-1 text-xs text-muted-foreground">{t('workspace.humanReview')}</p> : null}
        <p className="break-words text-sm font-medium">{title}</p>
      </div>
      <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] ${statusTone}`}><StatusIcon aria-hidden="true" className="h-3 w-3" />{t(approval.cause === 'run_cancelled' ? 'workspace.approvalRunCancelled' : runCancelled ? 'run.graphCanvas.statusValues.cancelled' : `workspace.approvalStatus.${approval.status}`)}</span>
    </div>
    <dl className="space-y-4 text-xs leading-7">
      {approval.content?.body ? <div>
        <dt className="mb-1 text-xs text-muted-foreground">{t('workspace.approvalContent')}</dt>
        <dd className="whitespace-pre-wrap break-words text-sm">{approval.content.body}</dd>
      </div> : null}
      {requestedAction ? <div>
        <dt className="mb-1 text-xs text-muted-foreground">{t('workspace.requestedAction')}</dt>
        <dd className="whitespace-pre-wrap break-words">{requestedAction}</dd>
      </div> : null}
      {reason ? <div>
        <dt className="mb-1 text-xs text-muted-foreground">{t('workspace.reason')}</dt>
        <dd className="whitespace-pre-wrap break-words">{reason}</dd>
      </div> : null}
      {risk ? <div>
        <dt className="mb-1 text-xs font-medium text-amber-700 dark:text-amber-400">{t('workspace.risk')}</dt>
        <dd className="whitespace-pre-wrap break-words">{risk}</dd>
      </div> : null}
      {approval.note && !canResolve ? <div>
        <dt className="mb-1 text-xs text-muted-foreground">{t('workspace.note')}</dt>
        <dd className="whitespace-pre-wrap break-words">{approval.note}</dd>
      </div> : null}
    </dl>
    {materials.length > 0 ? <div className="space-y-3">
      <h3 className="text-xs text-muted-foreground">{t('workspace.approvalMaterials')}</h3>
      <TeamNodeDeliveries artifacts={materials} loading={false} roles={roles} disabled={disabled || pending} onReveal={onReveal} omitDeliveredAt={new Date(approval.createdAt).toLocaleString(i18n.language)} previewOwnerId={approval.approvalId} />
    </div> : null}
    <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      <div className="flex flex-wrap gap-x-2"><dt>{t('workspace.created')}</dt><dd><time dateTime={new Date(approval.createdAt).toISOString()}>{new Date(approval.createdAt).toLocaleString(i18n.language)}</time></dd></div>
      {approval.resolvedAt !== null ? <div className="flex flex-wrap gap-x-2"><dt>{t('workspace.resolved')}</dt><dd><time dateTime={new Date(approval.resolvedAt).toISOString()}>{new Date(approval.resolvedAt).toLocaleString(i18n.language)}</time></dd></div> : null}
    </dl>
  </div>;

  const actions = <>
    {canResolve ? <div className={inDialog || previewing ? 'shrink-0 space-y-2 border-t border-border bg-muted/30 px-6 py-4 sm:px-7' : 'space-y-2'}>
      <label htmlFor={noteId} className="block text-xs text-muted-foreground">{t('run.note')}</label>
      <Textarea id={noteId} rows={2} className={`${inDialog || previewing ? 'max-h-24 resize-none' : 'resize-y'} min-h-[70px] rounded-lg bg-card px-3 py-2 text-xs shadow-none`} placeholder={t('run.notePlaceholder')} value={note} disabled={!canMutate || pending} onChange={(event) => setNote(event.target.value)} />
      <div className="flex flex-wrap justify-end gap-2">
        {(['deny', 'abort', 'approve'] as const).map((decision) => <Button key={decision} type="button" size="sm" className="h-[34px] rounded-lg px-3 text-xs" variant={decision === 'approve' ? 'default' : 'outline'} disabled={!canMutate || pending} onClick={() => void submit(decision)}>
          {pendingDecision === decision ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 motion-safe:animate-spin" /> : null}
          {t(`run.approvalDecision.${decision}`)}
        </Button>)}
      </div>
    </div> : approval.status === 'pending' && approval.subject === 'stage' ? <p className={`text-xs text-muted-foreground ${inDialog ? 'shrink-0 px-6 py-4 sm:px-7' : ''}`}>{t('run.approvalStageUnavailable')}</p> : null}
    {error ? <p role="alert" className={`whitespace-pre-wrap break-words text-sm text-destructive ${inDialog || previewing ? 'max-h-24 shrink-0 overflow-y-auto px-6 py-3 sm:px-7' : ''}`}>{error}</p> : null}
  </>;

  return <li hidden={hidden} className={inDialog ? 'flex min-h-0 flex-1 flex-col' : previewing ? 'contents' : 'space-y-4 py-5 first:pt-0 last:pb-0'} aria-busy={pending}>
    {inDialog ? <div className="flex min-h-0 flex-1 flex-col px-6 py-5 sm:px-7">
      <TeamFilePreview artifacts={materials} fileScope={fileScope} workspaceStatus={workspaceStatus} disabled={disabled || pending}>{content}</TeamFilePreview>
    </div> : <div hidden={previewing}>{content}</div>}
    {actions}
  </li>;
}

export function TeamRunApprovals({ approvals, ...props }: TeamRunApprovalsProps) {
  const { t } = useTranslation('teams');
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const pendingApprovals = useMemo(() => approvals.filter((row) => isTeamApprovalActionable(row, props.runEligibility)), [approvals, props.runEligibility]);
  const selectableApprovals = useMemo(() => approvals.filter((row) => row.approvalId === selectedApprovalId || isTeamApprovalActionable(row, props.runEligibility)), [approvals, props.runEligibility, selectedApprovalId]);
  const approval = selectedApprovalId === null ? pendingApprovals[0] : approvals.find((row) => row.approvalId === selectedApprovalId);
  const title = approval ? approval.content?.title ?? t(`run.approvalSubject.${approval.subject}`) : t('run.approvals');
  const close = () => { if (!props.pendingAction) setSelectedApprovalId(null); };
  return <DialogPrimitive.Root open={selectedApprovalId !== null && Boolean(approval)} onOpenChange={(open) => {
    if (!props.pendingAction) setSelectedApprovalId(open ? pendingApprovals[0]?.approvalId ?? null : null);
  }}>
    {pendingApprovals.length > 0 ? <DialogPrimitive.Trigger asChild>
      <button type="button" className="mx-5 flex h-[52px] min-w-0 shrink-0 items-center gap-2 border-y border-border text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:mx-8">
        <UserCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-amber-700 dark:text-amber-400" />
        <span className="shrink-0 font-medium">{t('workspace.pendingApprovals', { count: pendingApprovals.length })}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{pendingApprovals[0].content?.title}</span>
        <span className="shrink-0">{t('run.approvals')}</span>
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
    </DialogPrimitive.Trigger> : null}
    {approval ? <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[hsl(var(--shell-scrim))] backdrop-blur-[3px]" />
      <DialogPrimitive.Content aria-describedby={undefined} aria-busy={Boolean(props.pendingAction)}
        onOpenAutoFocus={(event) => { event.preventDefault(); titleRef.current?.focus(); }}
        onEscapeKeyDown={(event) => { if (props.pendingAction) event.preventDefault(); }}
        onInteractOutside={(event) => { if (props.pendingAction) event.preventDefault(); }}
        className="fixed left-1/2 top-1/2 z-50 flex h-[min(800px,calc(100dvh-72px))] w-[calc(100vw-48px)] max-w-[760px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[18px] border border-[hsl(var(--shell-border-strong))] bg-[hsl(var(--shell-surface))] text-foreground shadow-[var(--shell-shadow-overlay)] outline-none dark:bg-[hsl(var(--shell-surface-muted))] max-[780px]:h-[calc(100dvh-20px)] max-[780px]:w-[calc(100vw-20px)]">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-5 sm:px-7">
          <UserCheck aria-hidden="true" className="h-5 w-5 shrink-0 text-amber-700 dark:text-amber-400" />
          <DialogPrimitive.Title ref={titleRef} tabIndex={-1} className="min-w-0 flex-1 break-words text-lg font-semibold leading-6 outline-none">{pendingApprovals.length > 0 ? t('workspace.pendingApprovals', { count: pendingApprovals.length }) : t('run.approvals')}</DialogPrimitive.Title>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0 rounded-lg" aria-label={t('common:actions.close')} title={t('common:actions.close')} disabled={Boolean(props.pendingAction)} onClick={close}>
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </header>
        {selectableApprovals.length > 1 ? <label className="flex shrink-0 items-center gap-3 border-b border-border px-6 py-3 text-xs sm:px-7">
          <span className="shrink-0">{t('run.approvals')}</span>
          <select className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={approval.approvalId} disabled={Boolean(props.pendingAction)} onChange={(event) => setSelectedApprovalId(event.target.value)}>
            {selectableApprovals.map((row) => <option key={row.approvalId} value={row.approvalId}>{row.content?.title ?? t(`run.approvalSubject.${row.subject}`)}</option>)}
          </select>
        </label> : null}
        <ol aria-label={title} className="flex min-h-0 flex-1 flex-col">
          <ApprovalRecord key={JSON.stringify([approval.runId, approval.approvalId])} approval={approval} {...props} inDialog
            onReveal={() => { close(); props.onReveal(); }} />
        </ol>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal> : null}
  </DialogPrimitive.Root>;
}
