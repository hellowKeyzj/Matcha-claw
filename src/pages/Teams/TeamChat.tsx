import { useEffect, useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { invokeIpc } from '@/lib/api-client';
import { pickLocalSkillSource } from '@/services/local-path-picker';
import type { TeamSkillDependencyEntry } from '@/services/openclaw/team-runtime-client';
import {
  isClawHubDependencySource,
  isLocalDependencySource,
  isOpenableDependencySource,
  normalizeDependencySource,
  readClawHubSkillSlug,
} from './dependency-source';
import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { useTeamsStore } from '@/stores/teams';
import { useTranslation } from 'react-i18next';
import { isGatewayOperational } from '@/lib/gateway-status';
const EMPTY_ROLES: ReturnType<typeof useTeamsStore.getState>['rolesByTeamId'][string] = [];
const EMPTY_DISPATCH_GROUPS: ReturnType<typeof useTeamsStore.getState>['dispatchGroupsByTeamId'][string] = [];
const EMPTY_DISPATCH_TASKS: ReturnType<typeof useTeamsStore.getState>['dispatchTasksByTeamId'][string] = [];
const EMPTY_APPROVALS: ReturnType<typeof useTeamsStore.getState>['approvalsByTeamId'][string] = [];
const EMPTY_ARTIFACTS: ReturnType<typeof useTeamsStore.getState>['artifactsByTeamId'][string] = [];
const EMPTY_MESSAGES: ReturnType<typeof useTeamsStore.getState>['messagesByTeamId'][string] = [];
const EMPTY_DISPATCHES: ReturnType<typeof useTeamsStore.getState>['dispatchesByTeamId'][string] = [];
const EMPTY_DISPATCH_EXECUTIONS: ReturnType<typeof useTeamsStore.getState>['dispatchExecutionsByTeamId'][string] = [];
const EMPTY_GATES: ReturnType<typeof useTeamsStore.getState>['gatesByTeamId'][string] = [];
const EMPTY_KICKBACKS: ReturnType<typeof useTeamsStore.getState>['kickbacksByTeamId'][string] = [];
const EMPTY_DECISIONS: ReturnType<typeof useTeamsStore.getState>['decisionsByTeamId'][string] = [];
const EMPTY_EVENTS: ReturnType<typeof useTeamsStore.getState>['eventsByTeamId'][string] = [];

function countDispatchTasksByRoleId(tasks: typeof EMPTY_DISPATCH_TASKS): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.roleId] = (counts[task.roleId] ?? 0) + 1;
  }
  return counts;
}

function formatTimestamp(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '-';
  }
  return new Date(value).toLocaleString();
}

const EVENT_PAYLOAD_SUMMARY_FIELDS = ['reason', 'error', 'message', 'workflowPlanId'] as const;

function isDisplayableEventPayloadValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function formatEventPayloadSummary(payload: Record<string, unknown>): string | undefined {
  const summaryParts = EVENT_PAYLOAD_SUMMARY_FIELDS.flatMap((field) => {
    const value = payload[field];
    return isDisplayableEventPayloadValue(value) ? [`${field}: ${String(value)}`] : [];
  });
  return summaryParts.length > 0 ? summaryParts.join(' · ') : undefined;
}

type DependencyMissingDetails = {
  stageId: string;
  missingRequiredSkills: TeamSkillDependencyEntry[];
  missingOptionalSkills: TeamSkillDependencyEntry[];
  missingRequiredTools: TeamSkillDependencyEntry[];
  missingOptionalTools: TeamSkillDependencyEntry[];
};

function isDependencyEntry(value: unknown): value is TeamSkillDependencyEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.name === 'string'
    && typeof entry.required === 'boolean'
    && typeof entry.purpose === 'string'
    && (entry.source === undefined || typeof entry.source === 'string');
}

function readDependencyEntries(payload: Record<string, unknown>, field: string): TeamSkillDependencyEntry[] {
  const value = payload[field];
  return Array.isArray(value) ? value.filter(isDependencyEntry) : [];
}

function readDependencyMissingDetails(
  events: typeof EMPTY_EVENTS,
  currentStageId: string | undefined,
): DependencyMissingDetails | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== 'dependency:missing') {
      continue;
    }
    const stageId = typeof event.payload.stageId === 'string' ? event.payload.stageId : undefined;
    if (!stageId || (currentStageId && stageId !== currentStageId)) {
      continue;
    }
    return {
      stageId,
      missingRequiredSkills: readDependencyEntries(event.payload, 'missingRequiredSkills'),
      missingOptionalSkills: readDependencyEntries(event.payload, 'missingOptionalSkills'),
      missingRequiredTools: readDependencyEntries(event.payload, 'missingRequiredTools'),
      missingOptionalTools: readDependencyEntries(event.payload, 'missingOptionalTools'),
    };
  }
  return null;
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
  const tickRun = useTeamsStore((state) => state.tickRun);
  const cancelRun = useTeamsStore((state) => state.cancelRun);
  const resolveApproval = useTeamsStore((state) => state.resolveApproval);
  const submitDecision = useTeamsStore((state) => state.submitDecision);
  const installSkill = useSkillsStore((state) => state.installSkill);
  const importLocalSkill = useSkillsStore((state) => state.importLocalSkill);
  const fetchSkills = useSkillsStore((state) => state.fetchSkills);

  const resolvedTeamId = teamId ?? activeTeamId ?? undefined;
  const team = teams.find((row) => row.id === resolvedTeamId);
  const run = useTeamsStore((state) => (resolvedTeamId ? state.runByTeamId[resolvedTeamId] : undefined));
  const runList = useTeamsStore((state) => (resolvedTeamId ? (state.runListByTeamId[resolvedTeamId] ?? []) : []));
  const workflowPlan = useTeamsStore((state) => (resolvedTeamId ? state.workflowPlanByTeamId[resolvedTeamId] : undefined));
  const dispatchGroups = useTeamsStore((state) => (resolvedTeamId ? (state.dispatchGroupsByTeamId[resolvedTeamId] ?? EMPTY_DISPATCH_GROUPS) : EMPTY_DISPATCH_GROUPS));
  const dispatchTasks = useTeamsStore((state) => (resolvedTeamId ? (state.dispatchTasksByTeamId[resolvedTeamId] ?? EMPTY_DISPATCH_TASKS) : EMPTY_DISPATCH_TASKS));
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
    if (!team || !resolvedTeamId || !isGatewayRunning) {
      return;
    }
    setActiveTeam(team.id);
    void (async () => {
      await syncRunList(team.id);
      await refreshSnapshot(team.id);
    })();
  }, [isGatewayRunning, team, resolvedTeamId, setActiveTeam, syncRunList, refreshSnapshot]);

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

  const roleDispatchTaskCountByRoleId = useMemo(() => countDispatchTasksByRoleId(dispatchTasks), [dispatchTasks]);
  const dispatchTasksByTaskId = useMemo(() => new Map(dispatchTasks.map((task) => [task.taskId, task])), [dispatchTasks]);
  const dispatchGroupsByGroupId = useMemo(() => new Map(dispatchGroups.map((group) => [group.groupId, group])), [dispatchGroups]);
  const dependencyMissingDetails = useMemo(
    () => readDependencyMissingDetails(events, run?.currentStageId),
    [events, run?.currentStageId],
  );
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
  const runs = [...runList].sort((left, right) => right.updatedAt - left.updatedAt);

  const retryDependencyPreflightAfterSkillChange = async (): Promise<void> => {
    if (!team) {
      return;
    }
    await fetchSkills({ force: true, fresh: true });
    await submitDecision(team.id, 'retry', t('run.dependencyMissing.retryAfterInstall'));
    await tickRun(team.id);
  };

  const handleInstallMissingSkill = async (entry: TeamSkillDependencyEntry): Promise<void> => {
    if (!team || !isClawHubDependencySource(entry.source)) {
      return;
    }
    await runUiAction(`dependency-skill-install:${team.id}:${entry.name}`, async () => {
      await installSkill(readClawHubSkillSlug(entry.name, entry.source));
      await retryDependencyPreflightAfterSkillChange();
    });
  };

  const handleImportMissingSkillFromDeclaredSource = async (entry: TeamSkillDependencyEntry): Promise<void> => {
    if (!team || !isLocalDependencySource(entry.source)) {
      return;
    }
    await runUiAction(`dependency-skill-import:${team.id}:${entry.name}`, async () => {
      await importLocalSkill(normalizeDependencySource(entry.source));
      await retryDependencyPreflightAfterSkillChange();
    });
  };

  const handleImportMissingSkillFromLocalPicker = async (entry: TeamSkillDependencyEntry): Promise<void> => {
    if (!team) {
      return;
    }
    await runUiAction(`dependency-skill-import:${team.id}:${entry.name}`, async () => {
      const selectedPath = await pickLocalSkillSource({
        title: t('run.dependencyMissing.importLocalSkill'),
        buttonLabel: t('run.dependencyMissing.importLocalSkill'),
      });
      if (!selectedPath) {
        return;
      }
      await importLocalSkill(selectedPath);
      await retryDependencyPreflightAfterSkillChange();
    });
  };

  const handleOpenDependencySource = async (source: string | undefined): Promise<void> => {
    const value = normalizeDependencySource(source);
    if (!isOpenableDependencySource(value)) {
      return;
    }
    await invokeIpc('shell:openExternal', value);
  };

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
  const canSubmitDecision = canAct && run?.status === 'waiting_for_user';

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

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">{t('run.history')}</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={t('run.create')}
              className="h-8 w-8 p-0"
              onClick={() => void runUiAction(`create-run:${team.id}`, async () => { await createRun(team.id); })}
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
        </CardHeader>
        <CardContent className="space-y-2">
          {runs.length === 0 ? (
            <div className="rounded border p-3 text-xs text-muted-foreground">{t('run.emptyRuns')}</div>
          ) : runs.map((teamRun) => {
            const isActiveRun = teamRun.runId === run?.runId;
            return (
              <button
                key={teamRun.runId}
                type="button"
                className={`flex w-full items-center justify-between gap-3 rounded border px-3 py-2 text-left text-sm ${isActiveRun ? 'border-primary bg-primary/10' : 'bg-background'}`}
                onClick={() => {
                  setActiveRun(team.id, teamRun.runId);
                  void runUiAction(`switch-run:${team.id}:${teamRun.runId}`, () => refreshSnapshot(team.id));
                }}
                disabled={loading || Boolean(pendingActionId) || isActiveRun}
              >
                <span className="min-w-0 truncate">{teamRun.runId}</span>
              </button>
            );
          })}
        </CardContent>
      </Card>

      {!run ? (
        <div className="rounded-md border border-border bg-muted/25 p-3 text-sm text-muted-foreground">
          {t('run.createFirstRunHint')}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('run.workflow')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!workflowPlan ? (
              <div className="rounded border p-3 text-xs text-muted-foreground">{t('run.emptyWorkflow')}</div>
            ) : (
              <>
                <div className="rounded border p-3">
                  <div className="text-sm font-medium">{workflowPlan.title}</div>
                  <div className="text-xs text-muted-foreground">{workflowPlan.workflowPlanId} · {workflowPlan.status}</div>
                  {workflowPlan.summary ? <div className="mt-1 text-xs text-muted-foreground">{workflowPlan.summary}</div> : null}
                </div>
                <div className="space-y-3">
                  {workflowPlan.groups.map((group) => {
                    const dispatchGroup = dispatchGroupsByGroupId.get(group.groupId);
                    return (
                      <div key={group.groupId} className="rounded border p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium">{group.title}</div>
                            <div className="text-xs text-muted-foreground">{group.groupId}</div>
                          </div>
                          <div className="text-xs text-muted-foreground">{dispatchGroup?.status ?? t('run.workflowNotDispatched')}</div>
                        </div>
                        <div className="mt-3 grid gap-2 lg:grid-cols-2">
                          {group.taskIds.map((taskId) => {
                            const plannedTask = workflowPlan.tasks.find((task) => task.taskId === taskId);
                            const dispatchTask = dispatchTasksByTaskId.get(taskId);
                            if (!plannedTask) {
                              return null;
                            }
                            return (
                              <div key={taskId} className="rounded border bg-background/70 p-2">
                                <div className="text-sm font-medium">{plannedTask.title}</div>
                                <div className="text-xs text-muted-foreground">{plannedTask.taskId} · {plannedTask.roleId}</div>
                                <div className="mt-1 text-xs text-muted-foreground">{dispatchTask?.status ?? t('run.workflowTaskPending')}</div>
                                {dispatchTask?.statusReason ? <div className="mt-1 text-xs text-destructive">{dispatchTask.statusReason}</div> : null}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
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

            {run?.status === 'waiting_for_user' && dependencyMissingDetails ? (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <div className="font-medium">{t('run.dependencyMissing.title')}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t('run.dependencyMissing.description')}
                </div>

                {dependencyMissingDetails.missingRequiredSkills.length > 0 || dependencyMissingDetails.missingOptionalSkills.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs font-medium text-muted-foreground">{t('run.dependencyMissing.skills')}</div>
                    {[...dependencyMissingDetails.missingRequiredSkills, ...dependencyMissingDetails.missingOptionalSkills].map((entry) => {
                      const canInstallFromClawHub = isClawHubDependencySource(entry.source);
                      const canImportFromDeclaredSource = isLocalDependencySource(entry.source);
                      const canImportFromPicker = !canImportFromDeclaredSource;
                      const canOpenSource = isOpenableDependencySource(entry.source);
                      const isImportingThisSkill = pendingActionId === `dependency-skill-import:${team.id}:${entry.name}`;
                      return (
                        <div key={`skill:${entry.name}`} className="rounded border bg-background/70 p-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-medium">{entry.name}</div>
                              <div className="mt-1 text-xs text-muted-foreground">{entry.purpose}</div>
                              {entry.source ? <div className="mt-1 truncate text-xs text-muted-foreground">{entry.source}</div> : null}
                              {!canInstallFromClawHub ? (
                                <div className="mt-1 text-xs text-muted-foreground">{t('run.dependencyMissing.noAutomaticInstallSource')}</div>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 flex-wrap justify-end gap-2">
                              {canOpenSource ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleOpenDependencySource(entry.source)}
                                  disabled={loading || Boolean(pendingActionId)}
                                >
                                  {t('run.dependencyMissing.openSource')}
                                </Button>
                              ) : null}
                              {canInstallFromClawHub ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleInstallMissingSkill(entry)}
                                  disabled={loading || Boolean(pendingActionId)}
                                >
                                  {t('run.dependencyMissing.installSkill')}
                                </Button>
                              ) : null}
                              {canImportFromDeclaredSource ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleImportMissingSkillFromDeclaredSource(entry)}
                                  disabled={loading || Boolean(pendingActionId)}
                                >
                                  {isImportingThisSkill ? t('run.dependencyMissing.importingLocalSkill') : t('run.dependencyMissing.importLocalSkill')}
                                </Button>
                              ) : null}
                              {canImportFromPicker ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void handleImportMissingSkillFromLocalPicker(entry)}
                                  disabled={loading || Boolean(pendingActionId)}
                                >
                                  {isImportingThisSkill ? t('run.dependencyMissing.importingLocalSkill') : t('run.dependencyMissing.importLocalSkill')}
                                </Button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {dependencyMissingDetails.missingRequiredTools.length > 0 || dependencyMissingDetails.missingOptionalTools.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs font-medium text-muted-foreground">{t('run.dependencyMissing.tools')}</div>
                    {[...dependencyMissingDetails.missingRequiredTools, ...dependencyMissingDetails.missingOptionalTools].map((entry) => (
                      <div key={`tool:${entry.name}`} className="rounded border bg-background/70 p-2">
                        <div className="font-medium">{entry.name}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{entry.purpose}</div>
                        {entry.source ? <div className="mt-1 truncate text-xs text-muted-foreground">{entry.source}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {dependencyMissingDetails.missingRequiredTools.length > 0 ? (
                  <div className="mt-3 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">
                    {t('run.dependencyMissing.requiredToolBlocker')}
                  </div>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void runUiAction(`decision:${team.id}:dependency-retry`, async () => {
                      await submitDecision(team.id, 'retry', t('run.dependencyMissing.retryNote'));
                      await tickRun(team.id);
                    })}
                    disabled={!canSubmitDecision}
                  >
                    {t('run.runDecision.retry')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void runUiAction(
                      `decision:${team.id}:dependency-abort`,
                      () => submitDecision(team.id, 'abort', t('run.dependencyMissing.abortNote')),
                    )}
                    disabled={!canSubmitDecision}
                  >
                    {t('run.runDecision.abort')}
                  </Button>
                </div>
              </div>
            ) : run?.status === 'waiting_for_user' ? (
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
                <div className="text-xs text-muted-foreground">{role.agentId}</div>
                <div className="mt-1 text-xs text-muted-foreground">{t('run.roleTasks')}: {roleDispatchTaskCountByRoleId[role.roleId] ?? 0}</div>
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
            ) : events.map((event) => {
              const payloadSummary = formatEventPayloadSummary(event.payload);
              return (
                <div key={event.eventId} className="rounded border p-2 text-sm">
                  <div className="font-medium">{event.type}</div>
                  <div className="text-xs text-muted-foreground">rev {event.revision} · {formatTimestamp(event.createdAt)}</div>
                  {payloadSummary ? <div className="mt-1 text-xs text-muted-foreground">{payloadSummary}</div> : null}
                </div>
              );
            })}
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
