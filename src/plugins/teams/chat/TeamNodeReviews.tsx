import { Suspense, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { CheckCircle2, Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { MarkdownPreview } from '@/plugins/files/MarkdownPreview';
import type { RuntimeScope } from '@/types/desktop/runtime-address';
import type { TeamNodeReviewCursor, TeamNodeReviewHistory, TeamNodeReviewMessages, TeamNodeReviewRecord, TeamRunMessagePage } from '@/types/team-workspace';
import { useTeamsStore } from '../store';
import { listTeamNodeReviews, readTeamNodeReviewMessages } from '../services/team-runtime-client';
import { mergeTeamMessageFragments } from '../services/team-message-pages';
import { ApprovalRecord, TeamRunApprovals } from './TeamRunApprovals';
import { TeamFilePreview } from '../pages/TeamFilePreview';

type ReviewTarget = Pick<Parameters<typeof listTeamNodeReviews>[0], 'scope' | 'teamId' | 'runId' | 'nodeId'>;
type MessageCursor = NonNullable<TeamRunMessagePage['nextCursor']>;

function ReviewMessages({ target, review }: { target: ReviewTarget; review: TeamNodeReviewRecord }) {
  const { t } = useTranslation('teams');
  const [request, setRequest] = useState<{ cursor?: MessageCursor }>({});
  const [response, setResponse] = useState<TeamNodeReviewMessages | null>(null);
  const responseRef = useRef<TeamNodeReviewMessages | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const loadPage = (cursor?: MessageCursor) => {
    setLoading(true);
    setError(null);
    setRequest({ cursor });
  };

  useEffect(() => {
    let current = true;
    const previous = responseRef.current;
    const cursor = request.cursor;
    void readTeamNodeReviewMessages({ ...target, query: {
      kind: 'messages', nodeExecutionId: review.nodeExecutionId, attemptId: review.attemptId,
      ...(cursor ? { cursor } : {}),
    } }).then((page) => {
      if (!current) return;
      if (page.messagePage.status === 'stale' || cursor && page.messagePage.revision !== cursor.revision) {
        responseRef.current = null;
        setResponse(null);
        setStale(true);
        return;
      }
      const first = page.messages[0];
      const next = page.messagePage.nextCursor;
      if (cursor && (!previous || previous.messagePage.revision !== page.messagePage.revision
        || !first || first.messageId !== cursor.messageId || first.bodyOffset !== cursor.bodyOffset
        || next && next.messageId === cursor.messageId && next.bodyOffset === cursor.bodyOffset)) {
        setError('workspace.reviewPageInvalid');
        return;
      }
      try {
        const merged = { ...page, messages: mergeTeamMessageFragments(cursor ? previous!.messages : [], page.messages) };
        responseRef.current = merged;
        setResponse(merged);
        setStale(false);
      } catch {
        setError('workspace.reviewPageInvalid');
      }
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [target, review.nodeExecutionId, review.attemptId, request]);

  return <div className="mt-3 min-w-0 space-y-3" aria-busy={loading}>
    {response?.messages.map((message) => <div key={message.messageId} className="min-w-0 space-y-2 border-t border-border pt-3 first:border-0 first:pt-0">
      {!message.bodyComplete ? <p role="status" className="text-xs text-muted-foreground">{t('workspace.partialOutput')}</p> : null}
      <Suspense fallback={<p role="status" className="py-4 text-sm text-muted-foreground">{t('workspace.loading')}</p>}>
        <MarkdownPreview filePath={`team-review:${JSON.stringify([target.runId, target.nodeId, review.nodeExecutionId, review.attemptId, message.messageId])}`} markdown={message.body} />
      </Suspense>
    </div>)}
    {loading ? <p role="status" className="flex items-center gap-2 py-3 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />{t('workspace.loading')}</p> : null}
    {error ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
      <p className="min-w-0 break-words text-destructive">{t('workspace.loadFailed')}: {error === 'workspace.reviewPageInvalid' ? t('workspace.reviewPageInvalid') : error}</p>
      <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => loadPage(request.cursor)}>{t('workspace.retry')}</Button>
    </div> : null}
    {stale ? <div role="status" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      <p>{t('workspace.reviewHistoryChanged')}</p>
      <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => loadPage()}>{t('workspace.reloadReviews')}</Button>
    </div> : null}
    {response?.messagePage.status === 'incomplete' && !response.messagePage.nextCursor ? <p role="status" className="text-sm text-muted-foreground">{t('workspace.reviewResponseIncomplete')}</p> : null}
    {response && (response.messagePage.status === 'unavailable' || response.messagePage.status === 'complete' && response.messages.length === 0) ? <p role="status" className="text-sm text-muted-foreground">{t('workspace.reviewResponseUnavailable')}</p> : null}
    {response?.messagePage.nextCursor && !error && !stale ? <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => loadPage(response.messagePage.nextCursor!)}>{t('workspace.loadMoreResponse')}</Button> : null}
  </div>;
}

function AgentReviewRecord({ target, review, hidden }: { target: ReviewTarget; review: TeamNodeReviewRecord; hidden: boolean }) {
  const { t, i18n } = useTranslation('teams');
  const [open, setOpen] = useState(false);
  const passed = review.outputPort === 'completed';
  const StatusIcon = passed ? CheckCircle2 : RotateCcw;

  return <li hidden={hidden} className="min-w-0 space-y-4 py-5 first:pt-0 last:pb-0">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h3 className="break-words text-sm font-medium">{t('workspace.agentReviewAttempt', { number: review.attemptNumber })}</h3>
      <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] ${passed ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}><StatusIcon aria-hidden="true" className="h-3 w-3" />{t(passed ? 'workspace.reviewApproved' : 'workspace.reviewRework')}</span>
    </div>
    {review.summary?.trim() ? <p className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]">{review.summary}</p> : <p role="status" className="text-sm text-muted-foreground">{t('workspace.reviewSummaryUnavailable')}</p>}
    <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
      {review.resolvedAt !== null ? <div className="flex flex-wrap gap-x-2"><dt>{t('workspace.resolved')}</dt><dd><time dateTime={new Date(review.resolvedAt).toISOString()}>{new Date(review.resolvedAt).toLocaleString(i18n.language)}</time></dd></div> : null}
      <div><dt className="sr-only">{t('workspace.attempt', { count: review.attemptNumber })}</dt><dd>{t(review.currentAttempt ? 'workspace.currentAttempt' : 'workspace.previousAttempt')}</dd></div>
    </dl>
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer break-words rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('workspace.fullResponse')}</summary>
      {open ? review.bodyStatus === 'available' ? <ReviewMessages target={target} review={review} /> : <p role="status" className="mt-3 text-sm text-muted-foreground">{t('workspace.reviewResponseUnavailable')}</p> : null}
    </details>
  </li>;
}

export function TeamNodeReviews({ teamId, runId, nodeId, scope, approvals, ...approvalProps }: ComponentProps<typeof TeamRunApprovals> & Omit<ReviewTarget, 'scope'> & { scope: RuntimeScope | null }) {
  const { t } = useTranslation('teams');
  const [target] = useState(() => scope ? { scope, teamId, runId, nodeId } : null);
  const [request, setRequest] = useState<{ cursor?: TeamNodeReviewCursor }>({});
  const [history, setHistory] = useState<TeamNodeReviewHistory | null>(null);
  const [loading, setLoading] = useState(Boolean(target));
  const [error, setError] = useState<string | null>(null);
  const loadPageRef = useRef<((cursor?: TeamNodeReviewCursor) => void) | null>(null);
  const loadPage = (cursor?: TeamNodeReviewCursor) => { loadPageRef.current?.(cursor); };

  useEffect(() => {
    if (!target) return;
    let current = true;
    let reading = false;
    let dirty = false;
    let cursor: TeamNodeReviewCursor | undefined;
    const readPage = async () => {
      if (reading) {
        dirty = true;
        return;
      }
      reading = true;
      try {
        do {
          dirty = false;
          const requestedCursor = cursor;
          try {
            const page = await listTeamNodeReviews({ ...target, cursor: requestedCursor });
            if (!current) return;
            if (dirty) continue;
            const first = page.entries[0];
            const next = page.page.nextCursor;
            if (page.page.status !== 'stale' && requestedCursor && (page.page.revision !== requestedCursor.revision
              || !first || first.nodeExecutionId !== requestedCursor.nodeExecutionId || first.attemptId !== requestedCursor.attemptId
              || next && next.nodeExecutionId === requestedCursor.nodeExecutionId && next.attemptId === requestedCursor.attemptId)) {
              setError('workspace.reviewPageInvalid');
              return;
            }
            setHistory(page);
          } catch (cause) {
            if (!current) return;
            if (dirty) continue;
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        } while (current && dirty);
      } finally {
        reading = false;
        if (current) setLoading(false);
      }
    };
    const load = (nextCursor?: TeamNodeReviewCursor) => {
      if (!current) return;
      cursor = nextCursor;
      setLoading(true);
      setError(null);
      setRequest({ cursor });
      void readPage();
    };
    loadPageRef.current = load;
    const unsubscribe = useTeamsStore.subscribe((state, previousState) => {
      const record = state.runSnapshotsByRunId[target.runId];
      const previous = previousState.runSnapshotsByRunId[target.runId];
      if (record?.teamId !== target.teamId || !record.snapshot
        || previous?.teamId === target.teamId && record.snapshot === previous.snapshot) return;
      load(cursor);
    });
    void readPage();
    return () => {
      current = false;
      unsubscribe();
      loadPageRef.current = null;
    };
  }, [target]);

  const rows = useMemo(() => [
    ...approvals.map((approval) => ({ kind: 'human' as const, key: JSON.stringify(['human', approval.runId, approval.approvalId]), createdAt: approval.createdAt, approval })),
    ...(history?.entries ?? []).map((review) => ({ kind: 'agent' as const, key: JSON.stringify(['agent', runId, nodeId, review.nodeExecutionId, review.attemptId]), createdAt: review.createdAt, review })),
  ].sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key)), [approvals, history, runId, nodeId]);

  const materials = approvalProps.artifacts.filter((artifact) => artifact.runId === runId && approvals.some((approval) => approval.content?.artifactIds.includes(artifact.artifactId)));
  return <TeamFilePreview artifacts={materials} fileScope={approvalProps.fileScope} workspaceStatus={approvalProps.workspaceStatus} disabled={approvalProps.disabled || Boolean(approvalProps.pendingAction)}>{(previewOwnerId) => {
    const previewing = previewOwnerId !== undefined;
    return <div className={previewing ? 'contents' : 'min-h-0 flex-1 space-y-4 overflow-y-auto [scrollbar-gutter:stable]'} aria-busy={loading}>
    {rows.length > 0 ? <ol aria-label={t('workspace.approval')} className={previewing ? 'contents' : 'divide-y divide-border'}>
      {rows.map((row) => row.kind === 'human' ? <ApprovalRecord key={row.key} approval={row.approval} {...approvalProps} showReviewer
        previewing={previewOwnerId === row.approval.approvalId} hidden={previewing && previewOwnerId !== row.approval.approvalId} />
        : target ? <AgentReviewRecord key={row.key} target={target} review={row.review} hidden={previewing} /> : null)}
    </ol> : null}
    <div hidden={previewing} className="space-y-4">
    {!target ? <p role="status" className="py-4 text-sm text-muted-foreground">{t('run.runtimeUnavailable')}</p> : null}
    {loading ? <p role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />{t('workspace.loading')}</p> : null}
    {error ? <div role="alert" className="flex flex-wrap items-center gap-3 py-4 text-sm">
      <p className="min-w-0 break-words text-destructive">{t('workspace.loadFailed')}: {error === 'workspace.reviewPageInvalid' ? t('workspace.reviewPageInvalid') : error}</p>
      <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => loadPage(request.cursor)}>{t('workspace.retry')}</Button>
    </div> : null}
    {history?.page.status === 'stale' ? <div role="status" className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      <p>{t('workspace.reviewHistoryChanged')}</p>
      <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => loadPage()}>{t('workspace.reloadReviews')}</Button>
    </div> : null}
    {history && history.page.status !== 'stale' && !loading && !error && rows.length === 0 ? <p role="status" className="py-4 text-sm text-muted-foreground">{t('workspace.emptyApprovals')}</p> : null}
    {history && history.page.status !== 'stale' && !error && (request.cursor || history.page.nextCursor) ? <div className="flex flex-wrap gap-2">
      {request.cursor ? <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => loadPage()}>{t('workspace.firstReviews')}</Button> : null}
      {history.page.nextCursor ? <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => loadPage(history.page.nextCursor!)}>{t('workspace.nextReviews')}</Button> : null}
    </div> : null}
    </div>
    </div>;
  }}</TeamFilePreview>;
}
