import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useGatewayStore } from '@/stores/gateway';
import { useTeamsStore } from '@/stores/teams';
import { useTeamsRunnerStore } from '@/stores/teams-runner';
import { useTranslation } from 'react-i18next';
import type { TeamMailboxMessage, TeamTask } from '@/features/teams/api/runtime-client';

const DEFAULT_LEASE_MS = 60_000;
const EMPTY_TASKS: TeamTask[] = [];
const EMPTY_MESSAGES: TeamMailboxMessage[] = [];

function sessionKey(agentId: string, teamId: string): string {
  return `agent:${agentId}:team:${teamId}:exec`;
}

function buildTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function TeamChat({ teamId }: { teamId?: string }) {
  const { t } = useTranslation('teams');
  const navigate = useNavigate();
  const gatewayState = useGatewayStore((state) => state.status.state);

  const teams = useTeamsStore((state) => state.teams);
  const activeTeamId = useTeamsStore((state) => state.activeTeamId);
  const setActiveTeam = useTeamsStore((state) => state.setActiveTeam);
  const initRuntime = useTeamsStore((state) => state.initRuntime);
  const refreshSnapshot = useTeamsStore((state) => state.refreshSnapshot);
  const planUpsert = useTeamsStore((state) => state.planUpsert);
  const claimNext = useTeamsStore((state) => state.claimNext);
  const heartbeat = useTeamsStore((state) => state.heartbeat);
  const updateTaskStatus = useTeamsStore((state) => state.updateTaskStatus);
  const releaseClaim = useTeamsStore((state) => state.releaseClaim);
  const postMailbox = useTeamsStore((state) => state.postMailbox);
  const pullMailbox = useTeamsStore((state) => state.pullMailbox);

  const resolvedTeamId = teamId ?? activeTeamId ?? undefined;
  const team = teams.find((row) => row.id === resolvedTeamId);
  const tasks = useTeamsStore((state) => (
    resolvedTeamId ? (state.tasksByTeamId[resolvedTeamId] ?? EMPTY_TASKS) : EMPTY_TASKS
  ));
  const messages = useTeamsStore((state) => (
    resolvedTeamId ? (state.mailboxByTeamId[resolvedTeamId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  ));
  const runMeta = useTeamsStore((state) => (resolvedTeamId ? state.runMetaByTeamId[resolvedTeamId] : undefined));
  const loading = useTeamsStore((state) => (resolvedTeamId ? Boolean(state.loadingByTeamId[resolvedTeamId]) : false));
  const error = useTeamsStore((state) => (resolvedTeamId ? state.errorByTeamId[resolvedTeamId] : undefined));

  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskInstruction, setNewTaskInstruction] = useState('');
  const [newTaskDependsOn, setNewTaskDependsOn] = useState('');
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [messageText, setMessageText] = useState('');
  const [messageTo, setMessageTo] = useState<'broadcast' | string>('broadcast');
  const enabledByTeamId = useTeamsRunnerStore((state) => state.enabledByTeamId);
  const activeAgentIdsByTeamId = useTeamsRunnerStore((state) => state.activeAgentIdsByTeamId);
  const activeTaskByAgentByTeamId = useTeamsRunnerStore((state) => state.activeTaskByAgentByTeamId);
  const lastErrorByTeamId = useTeamsRunnerStore((state) => state.lastErrorByTeamId);
  const setTeamEnabled = useTeamsRunnerStore((state) => state.setTeamEnabled);

  const effectiveSelectedAgentId = useMemo(() => {
    if (!team) {
      return '';
    }
    if (selectedAgentId && team.memberIds.includes(selectedAgentId)) {
      return selectedAgentId;
    }
    return team.memberIds[0] ?? '';
  }, [selectedAgentId, team]);

  useEffect(() => {
    if (!team || !resolvedTeamId) {
      return;
    }
    setActiveTeam(team.id);
    void initRuntime(team.id).then(() => refreshSnapshot(team.id));
    const timer = window.setInterval(() => {
      void refreshSnapshot(team.id);
      void pullMailbox(team.id, 50);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [team, resolvedTeamId, setActiveTeam, initRuntime, refreshSnapshot, pullMailbox]);

  const tasksByStatus = useMemo(() => {
    const groups: Record<string, typeof tasks> = {
      todo: [],
      claimed: [],
      running: [],
      blocked: [],
      done: [],
      failed: [],
    };
    for (const task of tasks) {
      groups[task.status] = [...(groups[task.status] ?? []), task];
    }
    return groups;
  }, [tasks]);

  const teamAutoRunnerEnabled = resolvedTeamId ? (enabledByTeamId[resolvedTeamId] ?? true) : true;
  const teamActiveAgentIds = useMemo(
    () => (resolvedTeamId ? (activeAgentIdsByTeamId[resolvedTeamId] ?? []) : []),
    [activeAgentIdsByTeamId, resolvedTeamId],
  );
  const teamActiveTaskByAgent = useMemo(
    () => (resolvedTeamId ? (activeTaskByAgentByTeamId[resolvedTeamId] ?? {}) : {}),
    [activeTaskByAgentByTeamId, resolvedTeamId],
  );
  const autoRunnerVisibleActiveCount = useMemo(() => {
    const ids = new Set(teamActiveAgentIds);
    for (const task of tasks) {
      if ((task.status === 'claimed' || task.status === 'running') && task.ownerAgentId) {
        ids.add(task.ownerAgentId);
      }
    }
    return ids.size;
  }, [teamActiveAgentIds, tasks]);

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

  const leadSession = effectiveSelectedAgentId ? sessionKey(effectiveSelectedAgentId, team.id) : '';
  const autoRunnerState = teamAutoRunnerEnabled && gatewayState === 'running'
    ? t('chat.autoRunnerOn')
    : t('chat.autoRunnerOff');
  const autoRunnerError = resolvedTeamId ? lastErrorByTeamId[resolvedTeamId] : undefined;

  const handleAddTask = async () => {
    const instruction = newTaskInstruction.trim();
    if (!instruction) {
      return;
    }
    const title = newTaskTitle.trim() || instruction.split(/\r?\n/, 1)[0].trim();
    const dependsOn = newTaskDependsOn
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const nextTask = {
      taskId: buildTaskId(),
      title,
      instruction,
      dependsOn,
    };
    const merged = [...tasks.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      instruction: task.instruction,
      dependsOn: task.dependsOn,
    })), nextTask];
    await planUpsert(team.id, merged);
    setNewTaskTitle('');
    setNewTaskInstruction('');
    setNewTaskDependsOn('');
  };

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{team.name}</h1>
          <p className="text-sm text-muted-foreground">
            {t('chat.runStatus')}: {runMeta?.status ?? 'initializing'} · rev {runMeta?.revision ?? 0}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={teamAutoRunnerEnabled ? 'default' : 'outline'}
            onClick={() => {
              if (!team) {
                return;
              }
              setTeamEnabled(team.id, !teamAutoRunnerEnabled);
            }}
          >
            {teamAutoRunnerEnabled ? t('chat.autoRunnerStop') : t('chat.autoRunnerStart')}
          </Button>
          <Button variant="outline" onClick={() => void refreshSnapshot(team.id)}>
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

      <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
        {t('chat.autoRunnerStatus', { state: autoRunnerState, count: autoRunnerVisibleActiveCount })}
      </div>

      {autoRunnerError && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          {t('chat.autoRunnerError', { error: autoRunnerError })}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1.2fr_0.9fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('board.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <Label htmlFor="task-title">{t('board.newTaskTitle')}</Label>
                <Input
                  id="task-title"
                  value={newTaskTitle}
                  onChange={(event) => setNewTaskTitle(event.target.value)}
                  placeholder={t('board.newTaskTitlePlaceholder')}
                />
              </div>
              <div>
                <Label htmlFor="task-instruction">{t('board.newTaskInstruction')}</Label>
                <Input
                  id="task-instruction"
                  value={newTaskInstruction}
                  onChange={(event) => setNewTaskInstruction(event.target.value)}
                  placeholder={t('board.newTaskInstructionPlaceholder')}
                />
              </div>
              <div>
                <Label htmlFor="task-deps">{t('board.newTaskDeps')}</Label>
                <Input
                  id="task-deps"
                  value={newTaskDependsOn}
                  onChange={(event) => setNewTaskDependsOn(event.target.value)}
                  placeholder={t('board.newTaskDepsPlaceholder')}
                />
              </div>
            </div>
            <Button onClick={() => void handleAddTask()} disabled={!newTaskInstruction.trim()}>
              {t('board.addTask')}
            </Button>

            <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {(['todo', 'claimed', 'running', 'blocked', 'done', 'failed'] as const).map((status) => (
                <Card key={status}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">
                      {t(`board.columns.${status}`)} ({tasksByStatus[status].length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {tasksByStatus[status].length === 0 ? (
                      <div className="text-xs text-muted-foreground">{t('board.emptyColumn')}</div>
                    ) : (
                      tasksByStatus[status].map((task) => (
                        <div key={task.taskId} className="rounded border p-2">
                          <div className="text-sm font-medium">{task.title}</div>
                          <div className="text-xs text-muted-foreground">{task.taskId}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {task.ownerAgentId ? `${t('board.owner')}: ${task.ownerAgentId}` : t('board.unclaimed')}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-1">
                            {status === 'todo' && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  if (!effectiveSelectedAgentId) return;
                                  void claimNext(
                                    team.id,
                                    effectiveSelectedAgentId,
                                    sessionKey(effectiveSelectedAgentId, team.id),
                                  );
                                }}
                              >
                                {t('board.claimNext')}
                              </Button>
                            )}
                            {(status === 'claimed' || status === 'blocked') && task.ownerAgentId && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void updateTaskStatus(team.id, task.taskId, 'running')}
                              >
                                {t('board.markRunning')}
                              </Button>
                            )}
                            {status === 'running' && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void updateTaskStatus(team.id, task.taskId, 'done')}
                                >
                                  {t('board.markDone')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void updateTaskStatus(team.id, task.taskId, 'blocked')}
                                >
                                  {t('board.markBlocked')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void updateTaskStatus(team.id, task.taskId, 'failed')}
                                >
                                  {t('board.markFailed')}
                                </Button>
                              </>
                            )}
                            {task.ownerAgentId && task.claimSessionKey && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void heartbeat(
                                    team.id,
                                    task.taskId,
                                    task.ownerAgentId!,
                                    task.claimSessionKey!,
                                  )}
                                >
                                  {t('board.heartbeat')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => void releaseClaim(
                                    team.id,
                                    task.taskId,
                                    task.ownerAgentId!,
                                    task.claimSessionKey!,
                                  )}
                                >
                                  {t('board.release')}
                                </Button>
                              </>
                            )}
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
            <CardTitle className="text-base">{t('mailbox.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="mailbox-target">{t('mailbox.target')}</Label>
              <Select
                id="mailbox-target"
                value={messageTo}
                onChange={(event) => setMessageTo(event.target.value)}
              >
                <option value="broadcast">{t('mailbox.broadcast')}</option>
                {team.memberIds.map((agentId) => (
                  <option key={agentId} value={agentId}>
                    {agentId}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="mailbox-message">{t('mailbox.message')}</Label>
              <Input
                id="mailbox-message"
                value={messageText}
                onChange={(event) => setMessageText(event.target.value)}
                placeholder={t('mailbox.messagePlaceholder')}
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={async () => {
                  if (!effectiveSelectedAgentId || !messageText.trim()) return;
                  const normalizedTo = messageTo || 'broadcast';
                  await postMailbox(team.id, {
                    msgId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    fromAgentId: effectiveSelectedAgentId,
                    to: normalizedTo,
                    kind: 'question',
                    content: messageText.trim(),
                    createdAt: Date.now(),
                  });
                  setMessageText('');
                }}
                disabled={!effectiveSelectedAgentId || !messageText.trim()}
              >
                {t('mailbox.send')}
              </Button>
              <Button variant="outline" onClick={() => void pullMailbox(team.id, 100)}>
                {t('mailbox.pull')}
              </Button>
            </div>
            <div className="max-h-[420px] space-y-2 overflow-y-auto rounded border p-2">
              {messages.length === 0 ? (
                <div className="text-xs text-muted-foreground">{t('mailbox.empty')}</div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.msgId} className="rounded border p-2 text-sm">
                    <div className="text-xs text-muted-foreground">
                      {msg.fromAgentId} {'->'} {msg.to}
                      {msg.relatedTaskId ? ` · ${msg.relatedTaskId}` : ''}
                    </div>
                    <div className="mt-1 whitespace-pre-wrap">{msg.content}</div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('agents.title')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="selected-agent">{t('agents.active')}</Label>
              <Select
                id="selected-agent"
                value={effectiveSelectedAgentId}
                onChange={(event) => setSelectedAgentId(event.target.value)}
              >
                <option value="">{t('agents.select')}</option>
                {team.memberIds.map((agentId) => (
                  <option key={agentId} value={agentId}>
                    {agentId}
                  </option>
                ))}
              </Select>
            </div>
            <div className="rounded border p-2 text-xs text-muted-foreground">
              {t('agents.sessionKey')}: {leadSession || '-'}
            </div>
            <div className="space-y-2">
              {team.memberIds.map((agentId) => {
                const ownedTasks = tasks.filter((task) => task.ownerAgentId === agentId);
                const runningCount = ownedTasks.filter((task) => task.status === 'running').length;
                const activeTaskId = teamActiveTaskByAgent[agentId];
                return (
                  <div key={agentId} className="rounded border p-2">
                    <div className="text-sm font-medium">{agentId}</div>
                    <div className="text-xs text-muted-foreground">
                      {t('agents.ownedTasks')}: {ownedTasks.length} · {t('agents.runningTasks')}: {runningCount}
                    </div>
                    {activeTaskId && (
                      <div className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
                        {t('agents.autoRunningTask')}: {activeTaskId}
                      </div>
                    )}
                    <div className="mt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void claimNext(team.id, agentId, sessionKey(agentId, team.id))}
                        disabled={loading}
                      >
                        {t('agents.claimForAgent')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="rounded border p-2 text-xs text-muted-foreground">
              lease: {DEFAULT_LEASE_MS}ms
            </div>
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
