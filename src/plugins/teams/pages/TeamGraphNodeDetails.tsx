import { Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarkdownPreview } from '@/plugins/files/MarkdownPreview';
import { useTeamsStore } from '../store';
import type { TeamGraphEdgeRecord, TeamGraphNodeRecord, TeamRoleBindingRecord } from '@/types/team-design';
import type { RunWorkspaceProjection, TeamArtifactRecord } from '@/types/team-workspace';
import type { TeamRunScope } from '@/types/desktop/runtime-address';
import type { TeamMessageRecord } from '../services/team-runtime-client';
import { TeamNodeDeliveries } from './TeamNodeDeliveries';
import { TeamFilePreview } from './TeamFilePreview';
import type { TeamGraphNodeDetailTab, TeamNodeDeliverySelection } from './team-node-editor-types';

function FullResponse({ message }: { message: TeamMessageRecord }) {
  const { t, i18n } = useTranslation('teams');
  const [open, setOpen] = useState(false);
  const complete = message.bodyComplete && message.bodyOffset === 0;

  return <section className="min-w-0 space-y-2 border-t border-[hsl(var(--shell-border))] pt-5 first:border-0 first:pt-0">
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer break-words rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]">
        {t('workspace.fullResponse')}
        {message.createdAt > 0 ? <time className="ml-3 text-xs font-normal text-muted-foreground" dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString(i18n.language)}</time> : null}
      </summary>
      {open && complete ? <div className="mt-3 min-h-16"><Suspense fallback={<p role="status" className="py-4 text-sm text-muted-foreground">{t('workspace.loading')}</p>}><MarkdownPreview filePath={`team-result:${message.messageId}`} markdown={message.body} /></Suspense></div> : null}
    </details>
    {!complete ? <p role="status" className="text-sm text-muted-foreground">{t('workspace.partialOutput')}</p> : null}
  </section>;
}

export function TeamGraphNodeDetails({ teamId, runId, node, nodes, edges, roles, artifacts, loading, fileScope, workspaceStatus, tab, initialSelection, disabled, onReveal }: {
  teamId: string;
  runId: string;
  node: TeamGraphNodeRecord;
  nodes: TeamGraphNodeRecord[];
  edges: TeamGraphEdgeRecord[];
  roles: TeamRoleBindingRecord[];
  artifacts: TeamArtifactRecord[];
  loading: boolean;
  fileScope?: TeamRunScope;
  workspaceStatus?: RunWorkspaceProjection['status'];
  tab: Exclude<TeamGraphNodeDetailTab, 'approval'>;
  initialSelection?: TeamNodeDeliverySelection;
  disabled: boolean;
  onReveal: () => void;
}) {
  const { t, i18n } = useTranslation('teams');
  const record = useTeamsStore((store) => {
    const candidate = store.runSnapshotsByRunId[runId];
    return candidate?.teamId === teamId ? candidate : undefined;
  });
  const refreshSnapshot = useTeamsStore((store) => store.refreshSnapshot);
  const snapshot = record?.snapshot?.run?.runId === runId ? record.snapshot : null;
  const nodeArtifacts = useMemo(() => artifacts.filter((artifact) => artifact.runId === runId && artifact.nodeId === node.nodeId), [artifacts, runId, node.nodeId]);

  useEffect(() => {
    if (tab === 'input' || record?.loading || record?.error) return;
    if (record && (tab !== 'output' || !snapshot?.messagePage.nextCursor)) return;
    // Read failures stay visible in the Store-owned record.
    void refreshSnapshot(teamId, { runId, errorFeedback: 'caller', ...(record ? { completeMessages: true } : {}) }).catch(() => {});
  }, [teamId, runId, tab, record, snapshot, refreshSnapshot]);

  const executions = snapshot?.nodeExecutions.filter((execution) => execution.runId === runId && execution.nodeId === node.nodeId) ?? [];
  const results = snapshot?.messages.filter((message) => message.runId === runId && message.nodeId === node.nodeId
    && executions.some((execution) => execution.nodeExecutionId === message.nodeExecutionId && execution.attemptId === message.attemptId)) ?? [];
  const messagePage = snapshot?.messagePage;
  const date = (value: number) => new Date(value).toLocaleString(i18n.language);
  const statusLabel = (status: string) => t(`run.graphCanvas.statusValues.${status === 'waiting_for_user' ? 'waitingForUser' : status}`, { defaultValue: status });
  const readStatus = record?.error ? <div role="alert" className="flex flex-wrap items-center gap-3 py-4 text-sm"><span className="break-words text-destructive">{t('workspace.loadFailed')}: {record.error}</span><Button type="button" size="sm" variant="outline" disabled={record.loading} onClick={() => {
    void refreshSnapshot(teamId, { runId, errorFeedback: 'caller', ...(tab === 'output' ? { completeMessages: true } : {}) }).catch(() => {});
  }}>{t('workspace.retry')}</Button></div>
    : !record || record.loading ? <p role="status" className="flex items-center justify-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="h-4 w-4 motion-safe:animate-spin" />{t('workspace.loading')}</p> : null;
  const deliveryProps = { roles, disabled, onReveal };

  if (tab === 'output') return <TeamFilePreview key={tab} artifacts={nodeArtifacts} fileScope={fileScope} workspaceStatus={workspaceStatus} initialSelection={initialSelection} disabled={disabled}>
    <div className="space-y-6">
    {nodeArtifacts.length > 0 || loading ? <TeamNodeDeliveries artifacts={nodeArtifacts} loading={loading} contextTitle={node.title} {...deliveryProps} /> : null}
    {readStatus}
    {messagePage && messagePage.status !== 'complete' ? <p role="status" className="text-sm text-muted-foreground">{t(messagePage.status === 'incomplete' ? 'workspace.messagePageIncomplete' : 'workspace.messageUnavailable')}</p> : null}
    {results.map((message) => <FullResponse key={message.messageId} message={message} />)}
    {snapshot && nodeArtifacts.length === 0 && results.length === 0 ? <div className="space-y-3 py-4">
      {executions.flatMap((execution) => typeof execution.outputSummary?.outputPort === 'string' ? [<p key={execution.nodeExecutionId ?? execution.attemptId} className="text-sm"><span className="text-muted-foreground">{t('workspace.outputPort')}: </span>{t(`run.graphCanvas.portLabels.${execution.outputSummary.outputPort}`, { defaultValue: execution.outputSummary.outputPort })}</p>] : [])}
      {node.kind === 'work' || node.kind === 'review' || !executions.some((execution) => typeof execution.outputSummary?.outputPort === 'string') ? <p role="status" className="text-sm text-muted-foreground">{t(node.kind === 'work' || node.kind === 'review' ? 'workspace.outputUnavailable' : 'workspace.noOutput')}</p> : null}
    </div> : null}
    </div>
  </TeamFilePreview>;

  if (tab === 'input') {
    const incoming = edges.filter((edge) => edge.targetNodeId === node.nodeId);
    const inputArtifacts = artifacts.filter((artifact) => artifact.runId === runId && incoming.some((edge) => edge.sourceNodeId === artifact.nodeId && edge.payload?.includeUpstreamResult !== false));
    return <TeamFilePreview key={tab} artifacts={inputArtifacts} fileScope={fileScope} workspaceStatus={workspaceStatus} disabled={disabled}>
      <section className="space-y-4">
        <h3 className="text-sm font-semibold">{t('workspace.configuredInputs')}</h3>
        {incoming.length === 0 ? <p className="text-sm text-muted-foreground">{t('workspace.noUpstreamNodes')}</p> : <ul className="divide-y">
          {incoming.map((edge) => {
            const source = nodes.find((candidate) => candidate.nodeId === edge.sourceNodeId);
            const sourceArtifacts = edge.payload?.includeUpstreamResult !== false ? inputArtifacts.filter((artifact) => artifact.nodeId === edge.sourceNodeId) : [];
            return <li key={edge.edgeId} className="min-w-0 space-y-3 py-4 first:pt-0 last:pb-0">
              <h4 className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]"><span className="mr-2 font-normal text-muted-foreground">{t('workspace.source')}</span>{source?.title || edge.sourceNodeId}</h4>
              {sourceArtifacts.length > 0 ? <TeamNodeDeliveries artifacts={sourceArtifacts} loading={false} contextTitle={source?.title} variant="input" {...deliveryProps} /> : null}
            </li>;
          })}
        </ul>}
      </section>
    </TeamFilePreview>;
  }

  return <div className="space-y-4">
    {readStatus}
    {snapshot && executions.length === 0 ? <p role="status" className="py-8 text-center text-sm text-muted-foreground">{t('workspace.emptyActivity')}</p> : null}
    <ol className="divide-y">
      {[...executions].reverse().map((execution, index) => <li key={execution.nodeExecutionId ?? execution.attemptId ?? index} className="space-y-4 py-5 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('workspace.attempt', { count: execution.attemptNumber ?? executions.length - index })}</h3><span className="text-xs text-muted-foreground">{statusLabel(execution.status)}</span></div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
          {execution.reason ? <><dt className="text-muted-foreground">{t('workspace.executionReason')}</dt><dd className="break-words">{t(`workspace.executionReasons.${execution.reason}`, { defaultValue: execution.reason })}</dd></> : null}
          {execution.createdAt ? <><dt className="text-muted-foreground">{t('workspace.created')}</dt><dd>{date(execution.createdAt)}</dd></> : null}
          {execution.startedAt ? <><dt className="text-muted-foreground">{t('workspace.started')}</dt><dd>{date(execution.startedAt)}</dd></> : null}
          {execution.completedAt ? <><dt className="text-muted-foreground">{t('workspace.finished')}</dt><dd>{date(execution.completedAt)}</dd></> : null}
          {execution.updatedAt ? <><dt className="text-muted-foreground">{t('workspace.updated')}</dt><dd>{date(execution.updatedAt)}</dd></> : null}
          {typeof execution.outputSummary?.outputPort === 'string' ? <><dt className="text-muted-foreground">{t('workspace.outputPort')}</dt><dd>{t(`run.graphCanvas.portLabels.${execution.outputSummary.outputPort}`, { defaultValue: execution.outputSummary.outputPort })}</dd></> : null}
        </dl>
        {execution.statusReason ? <p className="whitespace-pre-wrap break-words text-sm text-destructive">{execution.statusReason}</p> : null}
        {execution.summary ? <p className="whitespace-pre-wrap break-words text-sm">{execution.summary}</p> : null}
        <details className="text-xs"><summary className="cursor-pointer rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('workspace.rawRecord')}</summary><pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-4">{JSON.stringify(execution, null, 2)}</pre></details>
      </li>)}
    </ol>
  </div>;
}
