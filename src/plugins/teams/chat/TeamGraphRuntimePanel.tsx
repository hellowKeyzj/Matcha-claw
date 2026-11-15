import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CheckCircle2, Circle, Clock3, Copy, Download, FolderOpen, Loader2, MoreHorizontal, Play, RefreshCw, Square, Trash2, Upload, XCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useChatStore } from '@/plugins/chat/store';
import { isRuntimeEndpointReady, supportsRuntimeEndpointCapabilityFamily, useRuntimeEndpointsStore } from '@/plugins/runtime/directory';
import { isTeamReworkLimit, type TeamGraphEditBase, type TeamDesignSnapshot, type TeamGraphPatchOperation, type TeamGraphReworkBlocked, type TeamRunReworkContinueInput } from '@/types/team-design';
import { runtimeEndpointsEqual, sessionIdentitiesEqual, teamRunScope, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { TeamArtifactRecord } from '@/types/team-workspace';
import { useWorkspace } from '@/plugins/workspace/context';
import { openFileWorkspaceSection } from '@/plugins/files/workspace';
import { reworkContinuationKey, selectTeamRuntimeScope, useTeamsStore, type TeamReworkContinuation } from '../store';
import { selectTeamApprovalRunEligibility } from '../approval-projection';
import { useTeamRunLabels } from '../hooks/use-team-run-labels';
import { readTeamWebhookAuth, type TeamApprovalRecord, type TeamApprovalResolutionDecision, type TeamWebhookAuthProjection } from '../services/team-runtime-client';
import { TeamApprovalDrafts, TeamRunApprovals } from './TeamRunApprovals';
import { TeamNodeReviews } from './TeamNodeReviews';
import { TeamRunGraphCanvas } from '../pages/TeamRunGraphCanvas';
import { useTeamGraphLabels } from '../pages/team-graph-labels';
import { openTeamRun } from '../session-navigation';
import type { TeamGraphSurface } from './runtime-surface';
import { useTeamRunStartEligibility } from './use-team-run-start-eligibility';

const EMPTY_APPROVALS: TeamApprovalRecord[] = [];
const EMPTY_ARTIFACTS: TeamArtifactRecord[] = [];

function sanitizeYamlDownloadFileName(fileName: string): string {
  const sanitizedBaseName = fileName
    .trim()
    .replace(/[\\/:*?"<>|\p{Cc}]+/gu, '-')
    .replace(/^\.+/, '')
    .replace(/\.ya?ml$/i, '')
    .replace(/[.\s-]+$/g, '') || 'team-run-graph';
  return `${sanitizedBaseName}.yaml`;
}

function downloadYamlFile(fileName: string, yaml: string): void {
  const blob = new Blob([yaml], { type: 'application/yaml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sanitizeYamlDownloadFileName(fileName);
  anchor.rel = 'noopener';
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

function BlockedRework({ snapshot, blocked, continuation, disabled, onContinue }: {
  snapshot: TeamDesignSnapshot;
  blocked: TeamGraphReworkBlocked | null;
  continuation?: TeamReworkContinuation;
  disabled: boolean;
  onContinue?: (input: TeamRunReworkContinueInput) => Promise<void>;
}) {
  const { t } = useTranslation('teams');
  const id = useId();
  const nodeId = blocked?.sourceNodeId ?? continuation!.input.nodeId;
  const sourcePort = blocked?.sourcePort ?? continuation!.input.sourcePort;
  const [limit, setLimit] = useState(blocked && isTeamReworkLimit(blocked.maxReworks + 1) ? String(blocked.maxReworks + 1) : '');
  const request = continuation?.input;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetimeRef = useRef<{ pending: boolean } | null>(null);
  useLayoutEffect(() => {
    lifetimeRef.current = { pending: false };
    return () => { lifetimeRef.current = null; };
  }, []);
  const maxReworks = request?.maxReworks ?? Number(limit);
  const valid = Boolean(request) || Boolean(blocked && limit.trim() !== '' && isTeamReworkLimit(maxReworks) && maxReworks > blocked.maxReworks && maxReworks > blocked.used);
  const source = snapshot.graph.nodes.find((node) => node.nodeId === nodeId);
  const port = t(`run.graphCanvas.portLabels.${sourcePort}`);
  const submit = async (): Promise<void> => {
    const lifetime = lifetimeRef.current;
    if (!onContinue || disabled || !lifetime || lifetime.pending || !request && (!blocked || !valid)) return;
    const commandId = request?.commandId ?? crypto.randomUUID();
    const input = request ?? {
      teamId: snapshot.teamId, runId: snapshot.runId, nodeId, sourcePort,
      batchId: blocked!.batchId, sourceNodeExecutionId: blocked!.sourceNodeExecutionId, maxReworks,
      expectedGraphVersion: snapshot.graphVersion, commandId, idempotencyKey: commandId,
    };
    lifetime.pending = true;
    setPending(true);
    setError(null);
    try {
      await onContinue(input);
    } catch (cause) {
      if (lifetimeRef.current === lifetime) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      lifetime.pending = false;
      if (lifetimeRef.current === lifetime) setPending(false);
    }
  };
  const failure = continuation?.error ?? error;
  const invalid = limit !== '' && !valid;
  const minimumLimit = blocked ? Math.max(blocked.maxReworks, blocked.used) + 1 : 0;
  return <div className="py-2.5 text-xs">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-0 basis-32 grow break-words font-medium">{source?.title || nodeId} · {port}</p>
      {blocked ? <span className="shrink-0 tabular-nums text-muted-foreground" title={t('run.graphCanvas.reworkLimitExceeded')}>
        {t('run.graphCanvas.reworkUsage', { batch: blocked.batchId, used: blocked.used, max: blocked.maxReworks })}
      </span> : null}
      {onContinue ? <form className="ml-auto flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="flex items-center gap-2 text-muted-foreground">
          {t('run.graphCanvas.reworkNewLimit')}
          <input type="number" min={request ? 0 : minimumLimit} max={0xffff_ffff} step={1}
            className="h-8 w-20 min-w-0 rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            aria-describedby={invalid ? `${id}-error` : undefined} aria-invalid={invalid}
            disabled={disabled || pending || Boolean(request)} value={request ? String(request.maxReworks) : limit} onChange={(event) => setLimit(event.target.value)} />
        </label>
        <Button type="submit" size="sm" className="h-8 px-2.5 text-xs" disabled={disabled || pending || !request && !valid}>
          {pending ? <Loader2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5 motion-safe:animate-spin" /> : null}
          {t(continuation?.status === 'acknowledged' ? 'run.graphCanvas.reworkRefreshContinue' : request && !pending ? 'run.graphCanvas.reworkRetryContinue' : 'run.graphCanvas.reworkContinue')}
        </Button>
      </form> : null}
    </div>
    {continuation && (!blocked || failure) ? <p role="status" className="mt-2 text-amber-700 dark:text-amber-400">{t(continuation.status === 'acknowledged' ? 'run.graphCanvas.reworkContinueReadback' : 'run.graphCanvas.reworkContinueUnconfirmed')}</p> : null}
    {onContinue && invalid ? <p id={`${id}-error`} role="alert" className="mt-2 text-destructive">{t('run.graphCanvas.reworkContinueInvalid', { min: minimumLimit })}</p> : null}
    {failure ? <p role="alert" className="mt-2 break-words text-destructive">{failure}</p> : null}
  </div>;
}

function ReworkContinuations({ snapshot, leaderIdentity, disabled }: {
  snapshot: TeamDesignSnapshot;
  leaderIdentity: SessionIdentity | null;
  disabled: boolean;
}) {
  const { t } = useTranslation('teams');
  const requests = useTeamsStore(useShallow((state) => Object.values(state.reworkContinuations)
    .filter((request): request is TeamReworkContinuation => request?.input.teamId === snapshot.teamId && request.input.runId === snapshot.runId)));
  const onContinue = useTeamsStore((state) => state.continueRework);
  const rows = new Map(snapshot.graph.rework.blocked.map((blocked) => [reworkContinuationKey({ ...snapshot, ...blocked, nodeId: blocked.sourceNodeId }), { blocked: blocked as TeamGraphReworkBlocked | null, continuation: undefined as TeamReworkContinuation | undefined }]));
  for (const continuation of requests) {
    const key = reworkContinuationKey(continuation.input);
    rows.set(key, { blocked: rows.get(key)?.blocked ?? null, continuation });
  }
  if (rows.size === 0) return null;
  return <section aria-label={t('run.graphCanvas.reworkWaiting')} className="max-h-40 shrink-0 divide-y divide-border overflow-y-auto border-b px-4">
    {[...rows].map(([key, { blocked, continuation }]) => <BlockedRework key={key} snapshot={snapshot} blocked={blocked} continuation={continuation}
      disabled={disabled} onContinue={leaderIdentity && (!continuation || sessionIdentitiesEqual(leaderIdentity, continuation.leaderIdentity)) ? onContinue : undefined} />)}
  </section>;
}

export function TeamGraphRuntimePanel({ surface }: { surface: TeamGraphSurface }) {
  const { teamId, runId } = surface;
  const { t } = useTranslation('teams');
  const graphLabels = useTeamGraphLabels();
  const runLabels = useTeamRunLabels();
  const runTitle = runLabels[runId] ?? t('run.unnamed');
  const navigate = useNavigate();
  const workspace = useWorkspace();
  const leaderIdentity = useChatStore((state) => {
    const conversation = state.currentConversation;
    if (conversation?.kind !== 'session') return null;
    const meta = state.loadedSessions[conversation.sessionRecordKey]?.meta;
    const ownership = meta?.ownership;
    return meta?.sessionIdentity && sessionIdentitiesEqual(meta.sessionIdentity, conversation.sessionIdentity)
      && ownership?.kind === 'team' && ownership.roleId === 'leader'
      && ownership.teamId === teamId && ownership.teamRunId === runId ? conversation.sessionIdentity : null;
  });
  const canEdit = leaderIdentity !== null;
  const { canStartRun, canStartRunNow } = useTeamRunStartEligibility(teamId, runId, leaderIdentity);
  const endpoints = useRuntimeEndpointsStore((state) => state.endpoints);
  const team = useTeamsStore((state) => state.teams.find((row) => row.id === teamId));
  const run = useTeamsStore((state) => state.runsById[runId]);
  const runtimeScope = useTeamsStore(useShallow((state) => selectTeamRuntimeScope(state, teamId, runId)));
  const runtime = endpoints.find((entry) => runtimeScope && runtimeEndpointsEqual(entry.endpointRef, runtimeScope.endpoint));
  const runtimeReady = Boolean(runtime && isRuntimeEndpointReady(runtime) && supportsRuntimeEndpointCapabilityFamily(runtime, 'team'));
  const record = useTeamsStore((state) => state.designByRunId[runId]);
  const runSnapshotRecord = useTeamsStore((state) => {
    const candidate = state.runSnapshotsByRunId[runId];
    return candidate?.teamId === teamId ? candidate : undefined;
  });
  const snapshot = record?.snapshot?.teamId === teamId && record.snapshot.runId === runId ? record.snapshot : null;
  const artifacts = useTeamsStore((state) => state.artifactsByRunId[runId]);
  const fileEndpoint = runtime?.endpointRef ?? runtimeScope?.endpoint;
  const fileScope = useMemo(() => fileEndpoint ? teamRunScope(fileEndpoint, runId, teamId) : undefined, [fileEndpoint, runId, teamId]);
  const approvals = useTeamsStore((state) => state.approvalsByRunId[runId] ?? EMPTY_APPROVALS);
  const runApprovals = useMemo(() => approvals.filter((approval) => approval.runId === runId), [approvals, runId]);
  const approvalRunEligibility = useTeamsStore((state) => selectTeamApprovalRunEligibility(state, teamId, runId));
  const status = run?.status ?? snapshot?.graph.status;
  const statusLabel = status ? graphLabels.statusValues[status] ?? status : '';
  const StatusIcon = status === 'completed' ? CheckCircle2 : status === 'failed' || status === 'cancelled' ? XCircle
    : status === 'running' || status === 'provisioning' ? Loader2 : status === 'waiting_for_user' || status === 'waiting' || status === 'paused' ? Clock3 : Circle;
  const statusTone = status === 'completed' ? 'text-emerald-700 dark:text-emerald-400'
    : status === 'failed' || status === 'cancelled' ? 'text-destructive'
      : status === 'waiting_for_user' || status === 'waiting' || status === 'paused' ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground';
  const refreshSnapshot = useTeamsStore((state) => state.refreshSnapshot);
  const observeTeamDesign = useTeamsStore((state) => state.observeTeamDesign);
  const refreshDesignSnapshot = useTeamsStore((state) => state.refreshDesignSnapshot);
  const submitRunGraphPatch = useTeamsStore((state) => state.submitRunGraphPatch);
  const retryRunLayoutSave = useTeamsStore((state) => state.retryRunLayoutSave);
  const createRoleSession = useTeamsStore((state) => state.createRoleSession);
  const startRun = useTeamsStore((state) => state.startRun);
  const resumeRun = useTeamsStore((state) => state.resumeRun);
  const cancelRun = useTeamsStore((state) => state.cancelRun);
  const deleteRun = useTeamsStore((state) => state.deleteRun);
  const resolveApproval = useTeamsStore((state) => state.resolveApproval);
  const exportGraphYaml = useTeamsStore((state) => state.exportGraphYaml);
  const importGraphYaml = useTeamsStore((state) => state.importGraphYaml);
  const patchGraph = useCallback((operations: TeamGraphPatchOperation[], base?: TeamGraphEditBase) => submitRunGraphPatch({ teamId, runId }, operations, base), [submitRunGraphPatch, teamId, runId]);
  const retryLayoutSave = useCallback(() => retryRunLayoutSave({ teamId, runId }), [retryRunLayoutSave, teamId, runId]);
  const createSession = useCallback((roleId: string, requestId: string) => createRoleSession({ teamId, runId }, roleId, requestId), [createRoleSession, teamId, runId]);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [webhookAuth, setWebhookAuth] = useState<TeamWebhookAuthProjection | null>(null);
  const yamlFileInputRef = useRef<HTMLInputElement>(null);
  const approvalRequestRef = useRef<{ pending: boolean } | null>(null);
  useLayoutEffect(() => {
    approvalRequestRef.current = { pending: false };
    return () => { approvalRequestRef.current = null; };
  }, [teamId, runId]);
  const teamKnown = Boolean(team);

  useEffect(() => {
    if (!teamKnown || !runtimeReady) return;
    void refreshSnapshot(teamId, { force: true, runId, errorFeedback: 'caller' }).catch(() => {});
    return observeTeamDesign({ teamId, runId });
  }, [teamKnown, runtimeReady, teamId, runId, refreshSnapshot, observeTeamDesign]);

  useEffect(() => {
    if (!runtimeReady) return;
    let cancelled = false;
    void readTeamWebhookAuth().then((auth) => {
      if (!cancelled) setWebhookAuth(auth);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [runtimeReady]);

  const mutationPending = Boolean(record?.mutationPending) || Boolean(pendingAction);
  const canMutate = canEdit && runtimeReady && Boolean(snapshot) && !mutationPending;
  const isRunLeader = Boolean(leaderIdentity && snapshot?.roles.some((role) => role.roleId === 'leader' && role.runId === runId
    && sessionIdentitiesEqual(role.sessionIdentity, leaderIdentity)));
  const canCancel = canMutate && (run?.status === 'provisioning' || run?.status === 'running' || run?.status === 'waiting_for_user' || run?.status === 'paused');
  const canCreateSession = canMutate && (snapshot?.startGate.status === 'intake' || snapshot?.startGate.status === 'designing')
    && run?.status !== 'cancelling' && run?.status !== 'cancelled';
  const canExport = runtimeReady && !mutationPending && Boolean(snapshot && (snapshot.graph.nodes.length || snapshot.graph.edges.length));
  const refreshing = Boolean(record?.loading || runSnapshotRecord?.loading);
  const error = record?.error || runSnapshotRecord?.error;
  const onResolveApproval = useCallback(async (approvalId: string, decision: TeamApprovalResolutionDecision, note?: string): Promise<void> => {
    const request = approvalRequestRef.current;
    if (!canMutate || !isRunLeader || !request || request.pending) return;
    request.pending = true;
    setPendingAction(`approval:${approvalId}`);
    try {
      await resolveApproval({ teamId, runId }, approvalId, decision, note);
    } finally {
      request.pending = false;
      if (approvalRequestRef.current === request) setPendingAction(null);
    }
  }, [canMutate, isRunLeader, resolveApproval, teamId, runId]);
  const roles = snapshot?.roles;
  const workspaceStatus = snapshot?.workspace.status;
  const renderNodeApprovals = useCallback((nodeId: string, onReveal: () => void) => <TeamNodeReviews
    key={JSON.stringify([teamId, runId, nodeId, runtimeReady ? runtimeScope : null])}
    teamId={teamId} runId={runId} nodeId={nodeId} scope={runtimeReady ? runtimeScope : null}
    approvals={runApprovals.filter((approval) => approval.nodeId === nodeId)} artifacts={artifacts ?? EMPTY_ARTIFACTS}
    roles={roles ?? []} fileScope={runtimeReady ? fileScope : undefined} workspaceStatus={workspaceStatus}
    disabled={!runtimeReady || mutationPending} onReveal={onReveal}
    canEdit={isRunLeader} canMutate={canMutate} runEligibility={approvalRunEligibility} pendingAction={pendingAction} onResolve={onResolveApproval}
  />, [teamId, runId, runtimeScope, runApprovals, artifacts, roles, runtimeReady, fileScope, workspaceStatus, mutationPending, isRunLeader, canMutate, approvalRunEligibility, pendingAction, onResolveApproval]);

  const runAction = async (actionId: string, action: () => Promise<void>): Promise<void> => {
    if (!canMutate || actionId === 'start' && !canStartRunNow()) return;
    setPendingAction(actionId);
    try {
      await action();
    } catch (error) {
      toast.error(t('design.actionFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setPendingAction(null);
    }
  };
  const refreshGraph = async (): Promise<void> => {
    if (!runtimeReady || refreshing || mutationPending) return;
    await Promise.allSettled([
      refreshSnapshot(teamId, { force: true, runId, errorFeedback: 'caller' }),
      refreshDesignSnapshot({ teamId, runId }, { invalidate: true }),
    ]);
  };
  const copyRunId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(runId);
      toast.success(t('run.idCopied'));
    } catch {
      toast.error(t('run.copyIdFailed'));
    }
  };
  const exportYaml = async (): Promise<void> => {
    if (!canExport) return;
    try {
      const result = await exportGraphYaml(teamId, runId);
      downloadYamlFile(result.fileName, result.yaml);
    } catch (error) {
      toast.error(t('design.actionFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };
  const importYaml = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await runAction('import', async () => {
      await importGraphYaml(teamId, await file.text(), runId);
    });
  };

  if (!team) return <p role="alert" className="p-4 text-sm text-muted-foreground">{t('chat.teamNotFound')}</p>;

  return <TeamApprovalDrafts key={JSON.stringify([teamId, runId])}><section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-[13px] leading-normal" style={{ fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif' }}>
    <header className="shrink-0 px-5 py-4 max-[780px]:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 min-[781px]:flex-nowrap">
        <h1 className="min-w-0 truncate text-[15px] font-semibold leading-6" title={`${team.name} / ${runTitle}`}>{runTitle}</h1>
        {statusLabel ? <span className={`inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap rounded-md px-2 py-[5px] text-[11px] ${status === 'waiting_for_user' || status === 'waiting' || status === 'paused' ? 'bg-amber-100/70 dark:bg-amber-300/10' : 'bg-card/70'} ${statusTone}`}><StatusIcon aria-hidden="true" className={`h-[13px] w-[13px] ${status === 'running' || status === 'provisioning' ? 'motion-safe:animate-spin' : ''}`} />{statusLabel}</span> : null}
        <div className="ml-auto flex shrink-0 items-center gap-[5px]">
          <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 rounded-lg px-2 text-xs" disabled={!runtimeReady || !fileScope || snapshot?.workspace.status !== 'ready'}
            title={t(snapshot?.workspace.status === 'legacy' ? 'delivery.legacyWorkspace' : snapshot?.workspace.status === 'preparing' ? 'delivery.preparingWorkspace' : 'delivery.sharedFiles')}
            onClick={() => { if (runtimeReady && fileScope && snapshot?.workspace.status === 'ready') openFileWorkspaceSection(workspace, 'workspace', { scope: fileScope }); }}>
            <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />{t('delivery.sharedFiles')}
          </Button>
          {canEdit && snapshot?.startGate.status !== 'started' ? <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 rounded-lg text-xs" disabled={!canMutate || !canStartRun}
            onClick={() => void runAction('start', () => startRun({ teamId, runId }))}>
            {pendingAction === 'start' ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 motion-safe:animate-spin" /> : <Play aria-hidden="true" className="h-3.5 w-3.5" />}{t(pendingAction === 'start' ? 'design.starting' : 'design.run')}
          </Button> : null}
          {canEdit && snapshot?.startGate.status === 'started' && (run?.status === 'provisioning' || run?.status === 'running' || run?.status === 'waiting_for_user' || run?.status === 'paused') ? <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 rounded-lg px-2 text-xs" disabled={!canCancel}
            onClick={() => void runAction('stop', () => cancelRun(teamId, undefined, runId))}><Square aria-hidden="true" className="h-3.5 w-3.5" />{t('run.stop')}</Button> : null}
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-lg" aria-label={t('chat.refresh')} title={t('chat.refresh')} disabled={!runtimeReady || refreshing || mutationPending}
            onClick={() => void refreshGraph()}>
            <RefreshCw aria-hidden="true" className={`h-4 w-4 ${refreshing ? 'motion-safe:animate-spin' : ''}`} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" className="h-8 w-8 rounded-lg" aria-label={t('run.actions')} title={t('run.actions')}><MoreHorizontal aria-hidden="true" className="h-4 w-4" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void copyRunId()}><Copy className="h-4 w-4" />{t('run.copyId')}</DropdownMenuItem>
              {canEdit ? <DropdownMenuItem disabled={!canMutate || !snapshot || snapshot.startGate.status === 'designing'} onSelect={() => yamlFileInputRef.current?.click()}><Upload className="h-4 w-4" />{t('run.importYaml')}</DropdownMenuItem> : null}
              <DropdownMenuItem disabled={!canExport} onSelect={() => void exportYaml()}><Download className="h-4 w-4" />{t('run.exportYaml')}</DropdownMenuItem>
              {canEdit ? <>
                <DropdownMenuItem disabled={!canMutate} onSelect={() => void runAction('resume', async () => {
                  const conversation = useChatStore.getState().currentConversation;
                  await resumeRun(teamId);
                  if (useChatStore.getState().currentConversation !== conversation) return;
                  const resumedRunId = useTeamsStore.getState().teams.find((team) => team.id === teamId)?.activeRunId;
                  if (resumedRunId && resumedRunId !== runId) await openTeamRun(navigate, teamId, resumedRunId);
                })}><Play className="h-4 w-4" />{t('run.resumeTeam')}</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" disabled={!canMutate} onSelect={() => setConfirmDelete(true)}><Trash2 className="h-4 w-4" />{t('run.delete')}</DropdownMenuItem>
              </> : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
    <input ref={yamlFileInputRef} type="file" accept=".yaml,.yml,application/yaml,text/yaml,text/plain" className="hidden" aria-label={t('run.importYamlFile')} onChange={(event) => void importYaml(event)} />
    {error ? <p role="alert" className="shrink-0 whitespace-pre-wrap break-words px-4 py-2 text-xs text-destructive">{error}</p> : null}
    {!runtimeReady ? <p role="status" className="shrink-0 px-4 py-2 text-xs text-muted-foreground">{t(runtimeScope ? 'run.runtimeUnavailable' : 'chat.runtimeScopeUnavailable')}</p> : null}
    {snapshot && snapshot.workspace.status !== 'ready' ? <p role="status" className="shrink-0 px-4 py-2 text-xs text-muted-foreground">{t(snapshot.workspace.status === 'legacy' ? 'delivery.legacyWorkspace' : 'delivery.preparingWorkspace')}</p> : null}
    <TeamRunApprovals key={JSON.stringify(['approvals', teamId, runId])}
      approvals={runApprovals} runEligibility={approvalRunEligibility} artifacts={artifacts ?? EMPTY_ARTIFACTS}
      roles={roles ?? []} fileScope={runtimeReady ? fileScope : undefined} workspaceStatus={workspaceStatus}
      disabled={!runtimeReady || mutationPending} onReveal={workspace.showChat} canEdit={isRunLeader}
      canMutate={canMutate} pendingAction={pendingAction} onResolve={onResolveApproval} />
    {snapshot && status !== 'cancelling' && status !== 'cancelled' ? <ReworkContinuations snapshot={snapshot} leaderIdentity={isRunLeader ? leaderIdentity : null}
      disabled={!canMutate || snapshot.startGate.status !== 'started'} /> : null}
    {snapshot ? <TeamRunGraphCanvas
      key={JSON.stringify([teamId, runId])}
      teamId={teamId}
      renderNodeApprovals={renderNodeApprovals}
      mode={canEdit ? 'editable' : 'readonly'}
      compact
      mutationPending={mutationPending}
      mutationDisabled={!runtimeReady}
      layoutSave={record?.layoutSave}
      graph={snapshot.graph}
      graphVersion={snapshot.graphVersion}
      runtimeError={snapshot.runtimeError}
      roles={snapshot.roles}
      artifacts={artifacts ?? EMPTY_ARTIFACTS}
      deliveriesLoading={artifacts === undefined}
      fileScope={runtimeReady ? fileScope : undefined}
      workspaceStatus={snapshot.workspace.status}
      emptyLabel={t('run.emptyWorkflow')}
      titleLabel={t('run.graph')}
      executorLabel={t('run.executor')}
      webhookAuth={runtimeReady ? webhookAuth : null}
      labels={graphLabels}
      onPatchGraph={canEdit ? patchGraph : undefined}
      onRetryLayoutSave={canEdit ? retryLayoutSave : undefined}
      onCreateSession={canCreateSession ? createSession : undefined}
      createSessionDisabledReason={snapshot.startGate.status === 'started' ? t('run.graphCanvas.createSessionBeforeStart') : undefined}
    /> : runtimeReady && !error ? record?.loading || !record ? <div role="status" className="flex min-h-0 flex-1 items-center justify-center"><Loader2 className="h-5 w-5 motion-safe:animate-spin text-muted-foreground" aria-label={t('common:status.loading')} /></div>
      : <p role="alert" className="text-sm text-destructive">{t('run.graphUnavailable')}</p> : null}
    <ConfirmDialog open={confirmDelete && canEdit} title={t('run.delete')} message={t('run.deleteConfirm', { name: runTitle })} confirmLabel={t('common:actions.delete')} cancelLabel={t('common:actions.cancel')} variant="destructive"
      onCancel={() => setConfirmDelete(false)} onConfirm={() => runAction('delete', async () => {
        await deleteRun(teamId, runId);
        setConfirmDelete(false);
      })} />
  </section></TeamApprovalDrafts>;
}
