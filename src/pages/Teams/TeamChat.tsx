import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { Download, Minus, Plus, Upload } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useGatewayStore } from '@/stores/gateway';
import { useTeamsStore } from '@/stores/teams';
import { useTranslation } from 'react-i18next';
import { isGatewayOperational } from '@/lib/gateway-status';
import { readTeamWebhookAuth, type TeamWebhookAuthProjection } from '@/services/openclaw/team-runtime-client';
import { TeamRunGraphCanvas } from './TeamRunGraphCanvas';

const EMPTY_ROLES: ReturnType<typeof useTeamsStore.getState>['rolesByTeamId'][string] = [];

type TeamGraphProjection = NonNullable<ReturnType<typeof useTeamsStore.getState>['graphByTeamId'][string]>;

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
  const saveGraph = useTeamsStore((state) => state.saveGraph);
  const exportGraphYaml = useTeamsStore((state) => state.exportGraphYaml);
  const importGraphYaml = useTeamsStore((state) => state.importGraphYaml);

  const yamlFileInputRef = useRef<HTMLInputElement | null>(null);
  const resolvedTeamId = teamId ?? activeTeamId ?? undefined;
  const team = teams.find((row) => row.id === resolvedTeamId);
  const run = useTeamsStore((state) => (resolvedTeamId ? state.runByTeamId[resolvedTeamId] : undefined));
  const runList = useTeamsStore((state) => (resolvedTeamId ? (state.runListByTeamId[resolvedTeamId] ?? []) : []));
  const graph = useTeamsStore((state) => (resolvedTeamId ? state.graphByTeamId[resolvedTeamId] : undefined));
  const roles = useTeamsStore((state) => (resolvedTeamId ? (state.rolesByTeamId[resolvedTeamId] ?? EMPTY_ROLES) : EMPTY_ROLES));
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

  const runs = [...runList].sort((left, right) => right.updatedAt - left.updatedAt);

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
  const canImportGraphYaml = canAct;
  const hasGraphToExport = hasExportableGraph(graph);
  const canExportGraphYaml = canAct && hasGraphToExport;
  const exportGraphYamlTitle = hasGraphToExport ? t('run.exportYaml') : t('run.exportYamlNoGraph');

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{team.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
            onClick={() => void runUiAction(`refresh:${team.id}:${run?.runId ?? 'none'}`, () => refreshSnapshot(team.id))}
            disabled={loading || Boolean(pendingActionId) || !run}
          >
            {t('chat.refresh')}
          </Button>
          <Button variant="outline" onClick={() => navigate('/teams')}>
            {t('chat.backToList')}
          </Button>
        </div>
      </header>

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

      <Card className="min-w-0">
        <CardContent className="pt-6">
          <TeamRunGraphCanvas
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
            labels={{
              workflowCanvas: t('run.graphCanvas.workflowCanvas'),
              workflowEdges: t('run.graphCanvas.workflowEdges'),
              nodePalette: t('run.graphCanvas.nodePalette'),
              nodeConfiguration: t('run.graphCanvas.nodeConfiguration'),
              nodeConfigurationDescription: t('run.graphCanvas.nodeConfigurationDescription'),
              edgeConfiguration: t('run.graphCanvas.edgeConfiguration'),
              edgeConfigurationDescription: t('run.graphCanvas.edgeConfigurationDescription'),
              configureHint: t('run.graphCanvas.configureHint'),
              clickNodeToEdit: t('run.graphCanvas.clickNodeToEdit'),
              saveNode: t('run.graphCanvas.saveNode'),
              saveEdge: t('run.graphCanvas.saveEdge'),
              deleteNode: t('run.graphCanvas.deleteNode'),
              deleteEdge: t('run.graphCanvas.deleteEdge'),
              addEdge: t('run.graphCanvas.addEdge'),
              sourceNode: t('run.graphCanvas.sourceNode'),
              targetNode: t('run.graphCanvas.targetNode'),
              sourcePort: t('run.graphCanvas.sourcePort'),
              targetPort: t('run.graphCanvas.targetPort'),
              edgeType: t('run.graphCanvas.edgeType'),
              edgeAction: t('run.graphCanvas.edgeAction'),
              edgeActionOptions: {
                activate: t('run.graphCanvas.edgeActionOptions.activate'),
                rework: t('run.graphCanvas.edgeActionOptions.rework'),
                gate: t('run.graphCanvas.edgeActionOptions.gate'),
                finish: t('run.graphCanvas.edgeActionOptions.finish'),
              },
              includeUpstreamResult: t('run.graphCanvas.includeUpstreamResult'),
              edgeLabel: t('run.graphCanvas.edgeLabel'),
              edgeConnection: t('run.graphCanvas.edgeConnection'),
              edgeTriggerCondition: t('run.graphCanvas.edgeTriggerCondition'),
              edgeDataTransfer: t('run.graphCanvas.edgeDataTransfer'),
              edgeAdvancedFields: t('run.graphCanvas.edgeAdvancedFields'),
              edgeJoinGateHint: t('run.graphCanvas.edgeJoinGateHint'),
              edgeFallback: t('run.graphCanvas.edgeFallback'),
              canvasMinimap: t('run.graphCanvas.canvasMinimap'),
              nodeTitle: t('run.graphCanvas.nodeTitle'),
              roleId: t('run.graphCanvas.roleId'),
              executorJson: t('run.graphCanvas.executorJson'),
              prompt: t('run.graphCanvas.prompt'),
              workPrompt: t('run.graphCanvas.workPrompt'),
              reviewPrompt: t('run.graphCanvas.reviewPrompt'),
              outputArtifactKind: t('run.graphCanvas.outputArtifactKind'),
              reviewExecutorKind: t('run.graphCanvas.reviewExecutorKind'),
              reviewExecutorTeamRole: t('run.graphCanvas.reviewExecutorTeamRole'),
              reviewExecutorHuman: t('run.graphCanvas.reviewExecutorHuman'),
              humanDecisionReason: t('run.graphCanvas.humanDecisionReason'),
              humanDecisionRequestedAction: t('run.graphCanvas.humanDecisionRequestedAction'),
              humanDecisionRisk: t('run.graphCanvas.humanDecisionRisk'),
              scriptReviewRule: t('run.graphCanvas.scriptReviewRule'),
              scriptReviewRules: {
                passThrough: t('run.graphCanvas.scriptReviewRules.passThrough'),
                assertAllUpstreamCompleted: t('run.graphCanvas.scriptReviewRules.assertAllUpstreamCompleted'),
                assertNoBlockingGate: t('run.graphCanvas.scriptReviewRules.assertNoBlockingGate'),
                assertArtifactExists: t('run.graphCanvas.scriptReviewRules.assertArtifactExists'),
              },
              scriptReviewArtifactKind: t('run.graphCanvas.scriptReviewArtifactKind'),
              joinConfigurationHint: t('run.graphCanvas.joinConfigurationHint'),
              endConfigurationHint: t('run.graphCanvas.endConfigurationHint'),
              advancedJson: t('run.graphCanvas.advancedJson'),
              roleIdRequired: t('run.graphCanvas.roleIdRequired'),
              configJson: t('run.graphCanvas.configJson'),
              invalidJson: t('run.graphCanvas.invalidJson'),
              saveGraphUnavailable: t('run.graphCanvas.saveGraphUnavailable'),
              connectionDraft: t('run.graphCanvas.connectionDraft'),
              runStatusLabel: t('run.graphCanvas.runStatusLabel'),
              graphStatusLabel: t('run.graphCanvas.graphStatusLabel'),
              statusValues: {
                created: t('run.graphCanvas.statusValues.created'),
                provisioning: t('run.graphCanvas.statusValues.provisioning'),
                waiting_for_user: t('run.graphCanvas.statusValues.waitingForUser'),
                running: t('run.graphCanvas.statusValues.running'),
                paused: t('run.graphCanvas.statusValues.paused'),
                cancelling: t('run.graphCanvas.statusValues.cancelling'),
                completed: t('run.graphCanvas.statusValues.completed'),
                failed: t('run.graphCanvas.statusValues.failed'),
                cancelled: t('run.graphCanvas.statusValues.cancelled'),
                draft: t('run.graphCanvas.statusValues.draft'),
                ready: t('run.graphCanvas.statusValues.ready'),
                passed: t('run.graphCanvas.statusValues.passed'),
              },
              teamRoles: t('run.graphCanvas.teamRoles'),
              connectToNode: t('run.graphCanvas.connectToNode'),
              connectFromNode: t('run.graphCanvas.connectFromNode'),
              nodeCount: t('run.graphCanvas.nodeCount'),
              edgeCount: t('run.graphCanvas.edgeCount'),
              startTriggerMode: t('run.graphCanvas.startTriggerMode'),
              startTriggerWebhook: t('run.graphCanvas.startTriggerWebhook'),
              startTriggerCron: t('run.graphCanvas.startTriggerCron'),
              startWebhookPath: t('run.graphCanvas.startWebhookPath'),
              startWebhookPublicBaseUrl: t('run.graphCanvas.startWebhookPublicBaseUrl'),
              startWebhookPublicBaseUrlHint: t('run.graphCanvas.startWebhookPublicBaseUrlHint'),
              startWebhookPublicBaseUrlInvalid: t('run.graphCanvas.startWebhookPublicBaseUrlInvalid'),
              startWebhookPublicUrl: t('run.graphCanvas.startWebhookPublicUrl'),
              startWebhookPublicUrlUnavailable: t('run.graphCanvas.startWebhookPublicUrlUnavailable'),
              startWebhookPathPreview: t('run.graphCanvas.startWebhookPathPreview'),
              startWebhookPathPreviewHint: t('run.graphCanvas.startWebhookPathPreviewHint'),
              startWebhookToken: t('run.graphCanvas.startWebhookToken'),
              startWebhookTokenUnavailable: t('run.graphCanvas.startWebhookTokenUnavailable'),
              copyWebhookToken: t('run.graphCanvas.copyWebhookToken'),
              copiedWebhookToken: t('run.graphCanvas.copiedWebhookToken'),
              copyWebhookPublicUrl: t('run.graphCanvas.copyWebhookPublicUrl'),
              copiedWebhookPublicUrl: t('run.graphCanvas.copiedWebhookPublicUrl'),
              startWebhookPathRequired: t('run.graphCanvas.startWebhookPathRequired'),
              startWebhookPathInvalid: t('run.graphCanvas.startWebhookPathInvalid'),
              startCronSchedule: t('run.graphCanvas.startCronSchedule'),
              startCronSchedules: {
                every10Minutes: t('run.graphCanvas.startCronSchedules.every10Minutes'),
                every30Minutes: t('run.graphCanvas.startCronSchedules.every30Minutes'),
                hourly: t('run.graphCanvas.startCronSchedules.hourly'),
                dailyAt9: t('run.graphCanvas.startCronSchedules.dailyAt9'),
                custom: t('run.graphCanvas.startCronSchedules.custom'),
              },
              startCronCustomKind: t('run.graphCanvas.startCronCustomKind'),
              startCronCustomKinds: {
                intervalMinutes: t('run.graphCanvas.startCronCustomKinds.intervalMinutes'),
                intervalHours: t('run.graphCanvas.startCronCustomKinds.intervalHours'),
                dailyAt: t('run.graphCanvas.startCronCustomKinds.dailyAt'),
              },
              startCronCustomIntervalMinutes: t('run.graphCanvas.startCronCustomIntervalMinutes'),
              startCronCustomIntervalHours: t('run.graphCanvas.startCronCustomIntervalHours'),
              startCronCustomTime: t('run.graphCanvas.startCronCustomTime'),
              startCronCustomValueRequired: t('run.graphCanvas.startCronCustomValueRequired'),
              startTriggerHint: t('run.graphCanvas.startTriggerHint'),
              defaultOutputPort: t('run.graphCanvas.defaultOutputPort'),
              edges: t('run.graphCanvas.edges'),
              noEdges: t('run.graphCanvas.noEdges'),
              nodePaletteDescriptions: {
                start: t('run.graphCanvas.nodePaletteDescriptions.start'),
                work: t('run.graphCanvas.nodePaletteDescriptions.work'),
                review: t('run.graphCanvas.nodePaletteDescriptions.review'),
                human_decision: t('run.graphCanvas.nodePaletteDescriptions.humanDecision'),
                script_review: t('run.graphCanvas.nodePaletteDescriptions.scriptReview'),
                join: t('run.graphCanvas.nodePaletteDescriptions.join'),
                end: t('run.graphCanvas.nodePaletteDescriptions.end'),
              },
            }}
            onSaveGraph={(nextGraph) => saveGraph(team.id, nextGraph)}
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
