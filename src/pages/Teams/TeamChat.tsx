import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { Download, GitBranch, MessageCircle, Minus, Plus, Upload } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useTeamsStore } from '@/stores/teams';
import { useTranslation } from 'react-i18next';
import { isGatewayOperational } from '@/lib/gateway-status';
import { readTeamWebhookAuth, type TeamWebhookAuthProjection } from '@/services/openclaw/team-runtime-client';
import { TeamRunGraphCanvas } from './TeamRunGraphCanvas';
import { TeamDesignDialog } from './TeamDesignDialog';
import { useTeamGraphLabels } from './team-graph-labels';
import { toast } from 'sonner';
import type { TeamDesignSnapshot, TeamDesignTarget } from '@/types/team-design';

const EMPTY_ROLES: TeamDesignSnapshot['roles'] = [];

type TeamGraphProjection = TeamDesignSnapshot['graph'];

function hasExportableGraph(graph: TeamGraphProjection | null | undefined): graph is TeamGraphProjection {
  return Boolean(graph && (graph.nodes.length > 0 || graph.edges.length > 0));
}

function sanitizeYamlDownloadFileName(fileName: string): string {
  const sanitizedBaseName = fileName
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')
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

export function TeamChat({ teamId }: { teamId?: string }) {
  const { t } = useTranslation('teams');
  const graphLabels = useTeamGraphLabels();
  const navigate = useNavigate();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const isGatewayRunning = isGatewayOperational(gatewayStatus);

  const teams = useTeamsStore((state) => state.teams);
  const activeTeamId = useTeamsStore((state) => state.activeTeamId);
  const setActiveTeam = useTeamsStore((state) => state.setActiveTeam);
  const setActiveRun = useTeamsStore((state) => state.setActiveRun);
  const createRun = useTeamsStore((state) => state.createRun);
  const resumeRun = useTeamsStore((state) => state.resumeRun);
  const deleteRun = useTeamsStore((state) => state.deleteRun);
  const refreshSnapshot = useTeamsStore((state) => state.refreshSnapshot);
  const syncRunList = useTeamsStore((state) => state.syncRunList);
  const cancelRun = useTeamsStore((state) => state.cancelRun);
  const confirmProposal = useTeamsStore((state) => state.confirmProposal);
  const continueProposal = useTeamsStore((state) => state.continueProposal);
  const cancelProposal = useTeamsStore((state) => state.cancelProposal);
  const submitRunGraphPatch = useTeamsStore((state) => state.submitRunGraphPatch);
  const observeTeamDesign = useTeamsStore((state) => state.observeTeamDesign);
  const refreshDesignSnapshot = useTeamsStore((state) => state.refreshDesignSnapshot);
  const startDesign = useTeamsStore((state) => state.startDesign);
  const continueDesign = useTeamsStore((state) => state.continueDesign);
  const confirmDesign = useTeamsStore((state) => state.confirmDesign);
  const continueDesignDiscussion = useTeamsStore((state) => state.continueDesignDiscussion);
  const exportGraphYaml = useTeamsStore((state) => state.exportGraphYaml);
  const importGraphYaml = useTeamsStore((state) => state.importGraphYaml);
  const openSessionIdentity = useChatStore((state) => state.openSessionIdentity);

  const yamlFileInputRef = useRef<HTMLInputElement | null>(null);
  const resolvedTeamId = teamId ?? activeTeamId ?? undefined;
  const team = teams.find((row) => row.id === resolvedTeamId);
  const run = useTeamsStore((state) => (resolvedTeamId ? state.runByTeamId[resolvedTeamId] : undefined));
  const runList = useTeamsStore((state) => (resolvedTeamId ? (state.runListByTeamId[resolvedTeamId] ?? []) : []));
  const designRecord = useTeamsStore((state) => run ? state.designByRunId[run.runId] : undefined);
  const designSnapshot = designRecord?.snapshot && designRecord.snapshot.teamId === resolvedTeamId && designRecord.snapshot.runId === run?.runId ? designRecord.snapshot : null;
  const graph = designSnapshot?.graph;
  const roles = designSnapshot?.roles ?? EMPTY_ROLES;
  const startGate = designSnapshot?.startGate;
  const designActive = startGate?.status === 'designing' || startGate?.status === 'design_proposal_pending';
  const designProposal = startGate?.status === 'design_proposal_pending' ? startGate.proposal : null;
  const currentDesignTargetKey = JSON.stringify([resolvedTeamId, run?.runId]);
  const currentDesignTargetRef = useRef(currentDesignTargetKey);
  currentDesignTargetRef.current = currentDesignTargetKey;
  const loading = useTeamsStore((state) => (resolvedTeamId ? Boolean(state.loadingByTeamId[resolvedTeamId]) : false));
  const error = useTeamsStore((state) => (resolvedTeamId ? state.errorByTeamId[resolvedTeamId] : undefined));

  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [webhookAuth, setWebhookAuth] = useState<TeamWebhookAuthProjection | null>(null);

  useEffect(() => {
    if (!team || !resolvedTeamId || !isGatewayRunning) {
      return;
    }
    setActiveTeam(team.id);
    void (async () => {
      await syncRunList(team.id);
      await refreshSnapshot(team.id);
    })();
  }, [isGatewayRunning, team, resolvedTeamId, setActiveTeam, syncRunList, refreshSnapshot]);

  useEffect(() => {
    if (!resolvedTeamId || !run?.runId || !isGatewayRunning) return;
    return observeTeamDesign({ teamId: resolvedTeamId, runId: run.runId });
  }, [resolvedTeamId, run?.runId, isGatewayRunning, observeTeamDesign]);

  useEffect(() => {
    if (!isGatewayRunning) {
      setWebhookAuth(null);
      return;
    }
    let cancelled = false;
    void readTeamWebhookAuth()
      .then((auth) => {
        if (!cancelled) setWebhookAuth(auth);
      })
      .catch(() => {
        if (!cancelled) setWebhookAuth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isGatewayRunning]);

  const runUiAction = async (actionId: string, action: () => Promise<void>): Promise<void> => {
    if (pendingActionId) {
      return;
    }
    setPendingActionId(actionId);
    try {
      await action();
    } finally {
      setPendingActionId(null);
    }
  };

  const exportCurrentGraphYaml = async (teamId: string): Promise<void> => {
    const result = await exportGraphYaml(teamId);
    downloadYamlFile(result.fileName, result.yaml);
  };

  const importCurrentGraphYaml = async (teamId: string, event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    const yaml = await file.text();
    await importGraphYaml(teamId, yaml);
  };

  const createNewRun = async (): Promise<void> => {
    if (!team) {
      return;
    }
    const nextTeamId = team.id;
    await runUiAction(`create-run:${nextTeamId}`, async () => {
      await createRun(nextTeamId);
    });
  };

  const openLeaderDiscussion = (openDesignGraph = false): void => {
    const leader = roles.find((role) => role.roleId === 'leader' && role.runId === run?.runId);
    if (!leader || !team) {
      return;
    }
    if (team.activeRunId !== leader.runId) setActiveRun(team.id, leader.runId);
    openSessionIdentity({ sessionIdentity: leader.sessionIdentity });
    navigate('/', openDesignGraph ? { state: { teamDesignSurface: {
      kind: 'team-graph', sourceSessionIdentity: leader.sessionIdentity, teamId: team.id, runId: leader.runId,
    } } } : undefined);
  };

  const runDesignUiAction = async (action: (target: TeamDesignTarget) => Promise<void>, openDiscussion = false): Promise<void> => {
    if (!team || !run) return;
    const target = { teamId: team.id, runId: run.runId };
    const targetKey = currentDesignTargetKey;
    try {
      await action(target);
      if (openDiscussion && currentDesignTargetRef.current === targetKey) openLeaderDiscussion(true);
    } catch (error) {
      toast.error(t('design.actionFailed', { error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const continuePendingProposal = async (): Promise<void> => {
    if (!team) {
      return;
    }
    await runUiAction(`proposal-continue:${team.id}:${run?.runId ?? 'none'}`, () => continueProposal(team.id));
    openLeaderDiscussion();
  };

  const cancelPendingProposal = async (): Promise<void> => {
    if (!team) {
      return;
    }
    await runUiAction(`proposal-cancel:${team.id}:${run?.runId ?? 'none'}`, () => cancelProposal(team.id));
  };

  const confirmPendingProposal = async (): Promise<void> => {
    if (!team) {
      return;
    }
    await runUiAction(`proposal-confirm:${team.id}:${run?.runId ?? 'none'}`, () => confirmProposal(team.id));
  };

  const runs = [...runList];

  if (!team || !resolvedTeamId) {
    return (
      <Card>
        <CardContent className="py-6">
          <div className="text-sm text-muted-foreground">{t('chat.teamNotFound')}</div>
          <Button className="mt-3" onClick={() => navigate('/teams')}>
            {t('chat.backToList')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const canAct = Boolean(run) && !loading && !pendingActionId;
  const canCreateRun = !loading && !pendingActionId;
  const canCancel = canAct && (run?.status === 'provisioning' || run?.status === 'running' || run?.status === 'waiting_for_user' || run?.status === 'paused');
  const canDeleteRun = canAct;
  const canImportGraphYaml = canAct && Boolean(designSnapshot) && !designActive && !designRecord?.mutationPending;
  const hasGraphToExport = hasExportableGraph(graph);
  const canExportGraphYaml = canAct && hasGraphToExport;
  const exportGraphYamlTitle = hasGraphToExport ? t('run.exportYaml') : t('run.exportYamlNoGraph');
  const proposal = startGate?.status === 'proposal_pending' ? startGate.proposal : null;
  const proposalSummary = proposal?.taskSummary?.trim() ?? '';
  const canActOnProposal = Boolean(proposal?.proposalId && run) && !loading && !pendingActionId;
  const canStartDesign = Boolean(run) && isGatewayRunning && Boolean(designSnapshot) && !designRecord?.loading && !designRecord?.mutationPending
    && roles.some((role) => role.roleId === 'leader' && role.runId === run?.runId);

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{team.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!designActive && startGate?.status !== 'started' ? (
            <Button
              variant="outline"
              disabled={!canStartDesign}
              onClick={() => { void runDesignUiAction(startDesign, true); }}
            >
              <GitBranch aria-hidden="true" className="mr-2 h-4 w-4" />
              {t('design.start')}
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => openLeaderDiscussion(designActive)}
            disabled={!canAct || !roles.some((role) => role.roleId === 'leader' && role.runId === run?.runId)}
          >
            <MessageCircle aria-hidden="true" className="mr-2 h-4 w-4" />
            {t('design.discussion')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void runUiAction(`resume:${team.id}:${run?.runId ?? 'none'}`, () => resumeRun(team.id))}
            disabled={!canAct}
          >
            {t('run.resume')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void runUiAction(`cancel:${team.id}:${run?.runId ?? 'none'}`, () => cancelRun(team.id))}
            disabled={!canCancel}
          >
            {t('run.stop')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void runUiAction(`refresh:${team.id}:${run?.runId ?? 'none'}`, async () => {
              await Promise.all([
                refreshSnapshot(team.id),
                ...(run ? [refreshDesignSnapshot({ teamId: team.id, runId: run.runId }, { invalidate: true })] : []),
              ]);
            })}
            disabled={loading || Boolean(pendingActionId) || !run}
          >
            {t('chat.refresh')}
          </Button>
          <Button variant="outline" onClick={() => navigate('/teams')}>
            {t('chat.backToList')}
          </Button>
        </div>
      </header>

      {designActive ? (
        <div role="status" className="flex items-center gap-2 rounded-md border border-primary/25 bg-primary/5 p-3 text-sm text-primary">
          <GitBranch aria-hidden="true" className="h-4 w-4 shrink-0" />
          {t('design.active')}
        </div>
      ) : null}
      {designProposal ? (
        <TeamDesignDialog
          summary={designProposal.taskSummary}
          busy={Boolean(designRecord?.mutationPending) || Boolean(designRecord?.loading)}
          error={designRecord?.error ?? undefined}
          onConfirm={() => { void runDesignUiAction(confirmDesign); }}
          onReturnDiscussion={() => { void runDesignUiAction(continueDesignDiscussion, true); }}
          onContinueDesign={() => { void runDesignUiAction(continueDesign, true); }}
        />
      ) : null}
      {designRecord?.error && !designProposal ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {designRecord.error}
        </div>
      ) : null}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!run ? (
        <div className="rounded-md border border-border bg-muted/25 p-3 text-sm text-muted-foreground">
          {t('run.createFirstRunHint')}
        </div>
      ) : null}

      {proposal ? (
        <Card className="border-primary/25 bg-primary/5">
          <CardContent className="space-y-3 py-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-primary/10 p-2 text-primary">
                <MessageCircle className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">{t('run.proposalPending.title')}</div>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                  {proposalSummary || t('run.proposalPending.emptySummary')}
                </p>
                {proposal.detail ? (
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-muted-foreground/80">{proposal.detail}</p>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => { void continuePendingProposal(); }}
                disabled={!canActOnProposal || !roles.some((role) => role.roleId === 'leader')}
              >
                {t('run.proposalPending.discuss')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => { void cancelPendingProposal(); }}
                disabled={!canActOnProposal || !roles.some((role) => role.roleId === 'leader')}
              >
                {t('run.proposalPending.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => { void confirmPendingProposal(); }}
                disabled={!canActOnProposal}
              >
                {t('run.proposalPending.confirm')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="min-w-0">
        <CardContent className="pt-6">
          {run && !designSnapshot && !designRecord?.error ? (
            <div role="status" className="mb-3 text-sm text-muted-foreground">{t('common:status.loading')}</div>
          ) : null}
          <TeamRunGraphCanvas
            mode={designSnapshot ? 'editable' : 'readonly'}
            mutationPending={Boolean(designRecord?.mutationPending) || Boolean(designRecord?.loading)}
            graph={graph}
            runStatus={run?.status}
            roles={roles}
            headerActions={(
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-foreground">{t('run.history')}</span>
                {runs.length === 0 ? (
                  <span className="rounded border px-2 py-1 text-muted-foreground">{t('run.emptyRuns')}</span>
                ) : (
                  <select
                    aria-label={t('run.history')}
                    className="max-w-[18rem] rounded border bg-background px-2 py-1 text-foreground"
                    value={run?.runId ?? ''}
                    onChange={(event) => {
                      setActiveRun(team.id, event.target.value);
                      void runUiAction(`switch-run:${team.id}:${event.target.value}`, () => refreshSnapshot(team.id));
                    }}
                    disabled={loading || Boolean(pendingActionId)}
                  >
                    {runs.map((teamRun) => <option key={teamRun.runId} value={teamRun.runId}>{teamRun.runId}</option>)}
                  </select>
                )}
                <input
                  ref={yamlFileInputRef}
                  type="file"
                  accept=".yaml,.yml,application/yaml,text/yaml,text/plain"
                  className="hidden"
                  aria-label={t('run.importYamlFile')}
                  onChange={(event) => void runUiAction(`import-yaml:${team.id}:${run?.runId ?? 'none'}`, () => importCurrentGraphYaml(team.id, event))}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('run.importYaml')}
                  title={t('run.importYaml')}
                  onClick={() => yamlFileInputRef.current?.click()}
                  disabled={!canImportGraphYaml}
                >
                  <Upload className="mr-1 h-4 w-4" />
                  {t('run.importYaml')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('run.exportYaml')}
                  title={exportGraphYamlTitle}
                  onClick={() => void runUiAction(`export-yaml:${team.id}:${run?.runId ?? 'none'}`, () => exportCurrentGraphYaml(team.id))}
                  disabled={!canExportGraphYaml}
                >
                  <Download className="mr-1 h-4 w-4" />
                  {t('run.exportYaml')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('run.create')}
                  className="h-8 w-8 p-0"
                  onClick={() => { void createNewRun(); }}
                  disabled={!canCreateRun}
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={t('run.delete')}
                  className="h-8 w-8 p-0"
                  onClick={() => void runUiAction(`delete-run:${team.id}:${run?.runId ?? 'none'}`, () => deleteRun(team.id))}
                  disabled={!canDeleteRun}
                >
                  <Minus className="h-4 w-4" />
                </Button>
              </div>
            )}
            emptyLabel={t('run.emptyWorkflow')}
            titleLabel={t('run.graph')}
            executorLabel={t('run.executor')}
            webhookAuth={webhookAuth}
            labels={graphLabels}
            onPatchGraph={run && designSnapshot ? (operations) => submitRunGraphPatch({ teamId: team.id, runId: run.runId }, operations) : undefined}
          />
        </CardContent>
      </Card>
    </section>
  );
}

export function TeamChatPage() {
  const { teamId } = useParams();
  return <TeamChat teamId={teamId} />;
}

export default TeamChatPage;
