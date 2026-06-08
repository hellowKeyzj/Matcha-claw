import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useGatewayStore } from '@/stores/gateway';
import { useTeamsStore } from '@/stores/teams';
import { useTranslation } from 'react-i18next';
import { isGatewayOperational } from '@/lib/gateway-status';
const EMPTY_STAGES: ReturnType<typeof useTeamsStore.getState>['stagesByTeamId'][string] = [];
const EMPTY_ROLES: ReturnType<typeof useTeamsStore.getState>['rolesByTeamId'][string] = [];
const EMPTY_APPROVALS: ReturnType<typeof useTeamsStore.getState>['approvalsByTeamId'][string] = [];
const EMPTY_ARTIFACTS: ReturnType<typeof useTeamsStore.getState>['artifactsByTeamId'][string] = [];
const EMPTY_MESSAGES: ReturnType<typeof useTeamsStore.getState>['messagesByTeamId'][string] = [];
const EMPTY_DISPATCHES: ReturnType<typeof useTeamsStore.getState>['dispatchesByTeamId'][string] = [];
const EMPTY_DISPATCH_EXECUTIONS: ReturnType<typeof useTeamsStore.getState>['dispatchExecutionsByTeamId'][string] = [];
const EMPTY_GATES: ReturnType<typeof useTeamsStore.getState>['gatesByTeamId'][string] = [];
const EMPTY_KICKBACKS: ReturnType<typeof useTeamsStore.getState>['kickbacksByTeamId'][string] = [];
const EMPTY_DECISIONS: ReturnType<typeof useTeamsStore.getState>['decisionsByTeamId'][string] = [];
const EMPTY_EVENTS: ReturnType<typeof useTeamsStore.getState>['eventsByTeamId'][string] = [];

type StageStatus = 'pending' | 'running' | 'waiting_for_user' | 'passed' | 'failed' | 'skipped' | 'cancelled';

type StageSummary = {
  stagesByStatus: Record<StageStatus, typeof EMPTY_STAGES>;
  roleStageCountByRoleId: Record<string, number>;
};

function buildStageSummary(stages: typeof EMPTY_STAGES): StageSummary {
  const stagesByStatus: Record<StageStatus, typeof EMPTY_STAGES> = {
    pending: [],
    running: [],
    waiting_for_user: [],
    passed: [],
    failed: [],
    skipped: [],
    cancelled: [],
  };
  const roleStageCountByRoleId: Record<string, number> = {};
  for (const stage of stages) {
    stagesByStatus[stage.status].push(stage);
    if (stage.roleId) {
      roleStageCountByRoleId[stage.roleId] = (roleStageCountByRoleId[stage.roleId] ?? 0) + 1;
    }
  }
  return { stagesByStatus, roleStageCountByRoleId };
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '-';
  }
  return new Date(value).toLocaleString();
}

export function TeamChat({ teamId }: { teamId?: string }) {
  const { t } = useTranslation('teams');
  const navigate = useNavigate();
  const gatewayStatus = useGatewayStore((state) => state.status);

  const teams = useTeamsStore((state) => state.teams);
  const activeTeamId = useTeamsStore((state) => state.activeTeamId);
  const setActiveTeam = useTeamsStore((state) => state.setActiveTeam);
  const startRun = useTeamsStore((state) => state.startRun);
  const refreshSnapshot = useTeamsStore((state) => state.refreshSnapshot);
  const tickRun = useTeamsStore((state) => state.tickRun);
  const cancelRun = useTeamsStore((state) => state.cancelRun);
  const resolveApproval = useTeamsStore((state) => state.resolveApproval);
  const submitDecision = useTeamsStore((state) => state.submitDecision);

  const resolvedTeamId = teamId ?? activeTeamId ?? undefined;
  const team = teams.find((row) => row.id === resolvedTeamId);
  const run = useTeamsStore((state) => (resolvedTeamId ? state.runByTeamId[resolvedTeamId] : undefined));
  const stages = useTeamsStore((state) => (resolvedTeamId ? (state.stagesByTeamId[resolvedTeamId] ?? EMPTY_STAGES) : EMPTY_STAGES));
  const roles = useTeamsStore((state) => (resolvedTeamId ? (state.rolesByTeamId[resolvedTeamId] ?? EMPTY_ROLES) : EMPTY_ROLES));
  const approvals = useTeamsStore((state) => (resolvedTeamId ? (state.approvalsByTeamId[resolvedTeamId] ?? EMPTY_APPROVALS) : EMPTY_APPROVALS));
  const artifacts = useTeamsStore((state) => (resolvedTeamId ? (state.artifactsByTeamId[resolvedTeamId] ?? EMPTY_ARTIFACTS) : EMPTY_ARTIFACTS));
  const messages = useTeamsStore((state) => (resolvedTeamId ? (state.messagesByTeamId[resolvedTeamId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES));
  const dispatches = useTeamsStore((state) => (resolvedTeamId ? (state.dispatchesByTeamId[resolvedTeamId] ?? EMPTY_DISPATCHES) : EMPTY_DISPATCHES));
  const dispatchExecutions = useTeamsStore((state) => (resolvedTeamId ? (state.dispatchExecutionsByTeamId[resolvedTeamId] ?? EMPTY_DISPATCH_EXECUTIONS) : EMPTY_DISPATCH_EXECUTIONS));
  const gates = useTeamsStore((state) => (resolvedTeamId ? (state.gatesByTeamId[resolvedTeamId] ?? EMPTY_GATES) : EMPTY_GATES));
  const kickbacks = useTeamsStore((state) => (resolvedTeamId ? (state.kickbacksByTeamId[resolvedTeamId] ?? EMPTY_KICKBACKS) : EMPTY_KICKBACKS));
  const decisions = useTeamsStore((state) => (resolvedTeamId ? (state.decisionsByTeamId[resolvedTeamId] ?? EMPTY_DECISIONS) : EMPTY_DECISIONS));
  const events = useTeamsStore((state) => (resolvedTeamId ? (state.eventsByTeamId[resolvedTeamId] ?? EMPTY_EVENTS) : EMPTY_EVENTS));
  const loading = useTeamsStore((state) => (resolvedTeamId ? Boolean(state.loadingByTeamId[resolvedTeamId]) : false));
  const error = useTeamsStore((state) => (resolvedTeamId ? state.errorByTeamId[resolvedTeamId] : undefined));

  const [approvalNoteById, setApprovalNoteById] = useState<Record<string, string>>({});
  const [decisionType, setDecisionType] = useState<'retry' | 'proceed_degraded' | 'abort'>('retry');
  const [decisionNote, setDecisionNote] = useState('');
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);

  useEffect(() => {
    if (!team || !resolvedTeamId || !isGatewayOperational(gatewayStatus)) {
      return;
    }
    setActiveTeam(team.id);
    void refreshSnapshot(team.id);
  }, [gatewayStatus, team, resolvedTeamId, setActiveTeam, refreshSnapshot]);

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

  const stageSummary = useMemo(() => buildStageSummary(stages), [stages]);
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');

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
  const canStart = !loading && !pendingActionId && (!run || run.status === 'created' || run.status === 'paused');
  const canCancel = canAct && (run?.status === 'provisioning' || run?.status === 'running' || run?.status === 'waiting_for_user' || run?.status === 'paused');
  const canSubmitDecision = canAct && run?.status === 'waiting_for_user';

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{team.name}</h1>
          <p className="text-sm text-muted-foreground">
            {t('chat.runStatus')}: {run?.status ?? t('run.notStarted')} · rev {run?.revision ?? 0}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('create.packagePath')}: {team.packagePath}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => void runUiAction(`refresh:${team.id}`, () => refreshSnapshot(team.id))}
            disabled={loading || Boolean(pendingActionId)}
          >
            {t('chat.refresh')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void runUiAction(`start:${team.id}`, () => startRun(team.id))}
            disabled={!canStart}
          >
            {t('run.start')}
          </Button>
          <Button
            variant="outline"
            onClick={() => void runUiAction(`cancel:${team.id}`, () => cancelRun(team.id))}
            disabled={!canCancel}
          >
            {t('run.cancel')}
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

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('run.stages')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {(['pending', 'running', 'waiting_for_user', 'passed', 'failed', 'skipped'] as const).map((status) => (
                <Card key={status}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">
                      {t(`run.stageStatus.${status}`)} ({stageSummary.stagesByStatus[status].length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {stageSummary.stagesByStatus[status].length === 0 ? (
                      <div className="text-xs text-muted-foreground">{t('run.emptyStages')}</div>
                    ) : (
                      stageSummary.stagesByStatus[status].map((stage) => (
                        <div key={stage.stageId} className="rounded border p-2">
                          <div className="text-sm font-medium">{stage.title}</div>
                          <div className="text-xs text-muted-foreground">{stage.stageId}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {t('run.executor')}: {stage.roleId ?? stage.executor}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {t('run.attempt')}: {stage.attempt}/{stage.maxAttempts}
                          </div>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('run.approvals')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingApprovals.length === 0 ? (
              <div className="rounded border p-3 text-xs text-muted-foreground">{t('run.emptyApprovals')}</div>
            ) : (
              pendingApprovals.map((approval) => (
                <div key={approval.approvalId} className="rounded border p-3 text-sm">
                  <div className="font-medium">{approval.requestedAction}</div>
                  <div className="text-xs text-muted-foreground">{approval.stageId} · {approval.roleId}</div>
                  <div className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{approval.reason}</div>
                  <div className="mt-2 text-xs text-muted-foreground">{approval.risk}</div>
                  <div className="mt-3 space-y-2">
                    <Label htmlFor={`approval-note-${approval.approvalId}`}>{t('run.note')}</Label>
                    <Input
                      id={`approval-note-${approval.approvalId}`}
                      value={approvalNoteById[approval.approvalId] ?? ''}
                      onChange={(event) => setApprovalNoteById((current) => ({
                        ...current,
                        [approval.approvalId]: event.target.value,
                      }))}
                      placeholder={t('run.notePlaceholder')}
                    />
                    <div className="flex flex-wrap gap-2">
                      {(['approve', 'deny', 'abort'] as const).map((decision) => (
                        <Button
                          key={decision}
                          size="sm"
                          variant="outline"
                          onClick={() => void runUiAction(
                            `approval:${team.id}:${approval.approvalId}:${decision}`,
                            () => resolveApproval(
                              team.id,
                              approval.approvalId,
                              decision,
                              approvalNoteById[approval.approvalId]?.trim() || undefined,
                            ),
                          )}
                          disabled={loading || Boolean(pendingActionId)}
                        >
                          {t(`run.approvalDecision.${decision}`)}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              ))
            )}

            {run?.status === 'waiting_for_user' ? (
              <div className="rounded border p-3 text-sm">
                <div className="font-medium">{t('run.waitingDecision')}</div>
                <div className="mt-2 grid gap-2 sm:grid-cols-[11rem_1fr]">
                  <Select value={decisionType} onChange={(event) => setDecisionType(event.target.value as typeof decisionType)}>
                    <option value="retry">{t('run.runDecision.retry')}</option>
                    <option value="proceed_degraded">{t('run.runDecision.proceed_degraded')}</option>
                    <option value="abort">{t('run.runDecision.abort')}</option>
                  </Select>
                  <Input
                    value={decisionNote}
                    onChange={(event) => setDecisionNote(event.target.value)}
                    placeholder={t('run.notePlaceholder')}
                  />
                </div>
                <Button
                  className="mt-2"
                  size="sm"
                  variant="outline"
                  onClick={() => void runUiAction(`decision:${team.id}:${decisionType}`, async () => {
                    await submitDecision(team.id, decisionType, decisionNote.trim() || undefined);
                    setDecisionNote('');
                  })}
                  disabled={!canSubmitDecision}
                >
                  {t('run.submitDecision')}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('run.roles')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {roles.length === 0 ? (
              <div className="rounded border p-3 text-xs text-muted-foreground">{t('run.emptyRoles')}</div>
            ) : roles.map((role) => (
              <div key={role.roleId} className="rounded border p-2">
                <div className="text-sm font-medium">{role.roleId}</div>
                <div className="text-xs text-muted-foreground">{role.agentName} · {role.status}</div>
                <div className="mt-1 text-xs text-muted-foreground">{t('run.roleStages')}: {stageSummary.roleStageCountByRoleId[role.roleId] ?? 0}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('run.artifacts')}</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[360px] space-y-2 overflow-y-auto">
            {artifacts.length === 0 ? (
              <div className="rounded border p-3 text-xs text-muted-foreground">{t('run.emptyArtifacts')}</div>
            ) : artifacts.map((artifact) => (
              <div key={artifact.artifactId} className="rounded border p-2 text-sm">
                <div className="font-medium">{artifact.title}</div>
                <div className="text-xs text-muted-foreground">{artifact.kind} · {artifact.stageId} · {artifact.roleId}</div>
                {artifact.summary ? <div className="mt-1 text-xs text-muted-foreground">{artifact.summary}</div> : null}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('run.gates')}</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[360px] space-y-2 overflow-y-auto">
            {gates.length === 0 ? (
              <div className="rounded border p-3 text-xs text-muted-foreground">{t('run.emptyGates')}</div>
            ) : gates.map((gate) => (
              <div key={gate.gateId} className="rounded border p-2 text-sm">
                <div className="font-medium">{gate.gateType}: {gate.verdict}</div>
                <div className="text-xs text-muted-foreground">{gate.stageId} · {gate.passed ? t('run.gatePassed') : t('run.gateFailed')}</div>
                {gate.failureItems.length > 0 ? (
                  <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                    {gate.failureItems.map((item) => <li key={`${gate.gateId}:${item.code}`}>{item.code}: {item.message}</li>)}
                  </ul>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('run.kickbacks')}</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[360px] space-y-2 overflow-y-auto">
            {kickbacks.length === 0 ? (
              <div className="rounded border p-3 text-xs text-muted-foreground">{t('run.emptyKickbacks')}</div>
            ) : kickbacks.map((kickback) => (
              <div key={kickback.kickbackId} className="rounded border p-2 text-sm">
                <div className="font-medium">{kickback.stageId}</div>
                <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                  {kickback.failureItems.map((item) => <li key={`${kickback.kickbackId}:${item.code}`}>{item.code}: {item.message}</li>)}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('run.messages')}</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[360px] space-y-2 overflow-y-auto">
            {messages.length === 0 ? (
              <div className="rounded border p-3 text-xs text-muted-foreground">{t('run.emptyMessages')}</div>
            ) : messages.map((message) => (
              <div key={message.messageId} className="rounded border p-2 text-sm">
                <div className="text-xs text-muted-foreground">{message.fromRoleId} {'->'} {message.toRoleId} · {formatTimestamp(message.createdAt)}</div>
                <div className="mt-1 font-medium">{message.summary}</div>
                <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{message.body}</div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('run.dispatches')}</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[360px] space-y-2 overflow-y-auto">
            {dispatches.length === 0 && dispatchExecutions.length === 0 ? (
              <div className="rounded border p-3 text-xs text-muted-foreground">{t('run.emptyDispatches')}</div>
            ) : (
              <>
                {dispatches.map((dispatch) => (
                  <div key={dispatch.dispatchId} className="rounded border p-2 text-sm">
                    <div className="font-medium">{dispatch.stageId}</div>
                    <div className="text-xs text-muted-foreground">{dispatch.roleId} · {dispatch.dispatchId}</div>
                  </div>
                ))}
                {dispatchExecutions.map((execution) => (
                  <div key={execution.executionRecordId} className="rounded border p-2 text-sm">
                    <div className="font-medium">{execution.status}</div>
                    <div className="text-xs text-muted-foreground">{execution.roleId} · {execution.childSessionKey ?? execution.executionId}</div>
                  </div>
                ))}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('run.decisions')}</CardTitle>
          </CardHeader>
          <CardContent className="max-h-[360px] space-y-2 overflow-y-auto">
            {decisions.length === 0 ? (
              <div className="rounded border p-3 text-xs text-muted-foreground">{t('run.emptyDecisions')}</div>
            ) : decisions.map((decision) => (
              <div key={decision.decisionId} className="rounded border p-2 text-sm">
                <div className="font-medium">{t(`run.runDecision.${decision.decision}`)}</div>
                <div className="text-xs text-muted-foreground">{decision.stageId} · {formatTimestamp(decision.createdAt)}</div>
                {decision.note ? <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{decision.note}</div> : null}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">{t('run.events')}</CardTitle>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void runUiAction(`tick:${team.id}`, () => tickRun(team.id))}
                disabled={!canAct}
              >
                {t('run.tick')}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="max-h-[360px] space-y-2 overflow-y-auto">
            {events.length === 0 ? (
              <div className="rounded border p-3 text-xs text-muted-foreground">{t('run.emptyEvents')}</div>
            ) : events.map((event) => (
              <div key={event.eventId} className="rounded border p-2 text-sm">
                <div className="font-medium">{event.type}</div>
                <div className="text-xs text-muted-foreground">rev {event.revision} · {formatTimestamp(event.createdAt)}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

export function TeamChatPage() {
  const { teamId } = useParams();
  return <TeamChat teamId={teamId} />;
}

export default TeamChatPage;
