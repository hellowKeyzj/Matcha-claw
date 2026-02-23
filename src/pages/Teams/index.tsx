import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { TeamDeleteDialog } from '@/pages/Teams/components/TeamDeleteDialog';
import { deleteTeamArtifactsLayout } from '@/pages/Teams/lib/team-artifacts';
import { deleteTeamSessions } from '@/pages/Teams/lib/orchestrator';
import { SubagentFormDialog } from '@/pages/SubAgents/components/SubagentFormDialog';
import { toast } from 'sonner';
import {
  checkTeamControllerReadiness,
  DEFAULT_TEAM_CONTROLLER_PROMPT,
  TEAM_CONTROLLER_EMOJI,
  TEAM_CONTROLLER_ID,
  TEAM_CONTROLLER_NAME,
  TEAM_CONTROLLER_PROMPT_STORAGE_KEY,
} from '@/lib/team/controller';
import { normalizeSubagentNameToSlug } from '@/lib/subagent/workspace';
import { useTeamsStore } from '@/stores/teams';
import { useSubagentsStore } from '@/stores/subagents';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) {
    return '-';
  }
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) {
    return 'just now';
  }
  if (deltaMs < 3_600_000) {
    return `${Math.floor(deltaMs / 60_000)}m ago`;
  }
  if (deltaMs < 86_400_000) {
    return `${Math.floor(deltaMs / 3_600_000)}h ago`;
  }
  return `${Math.floor(deltaMs / 86_400_000)}d ago`;
}

export function TeamsPage() {
  const { t } = useTranslation('teams');
  const [createOpen, setCreateOpen] = useState(false);
  const [teamName, setTeamName] = useState('');
  const [controllerId, setControllerId] = useState('');
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [controllerChecking, setControllerChecking] = useState(true);
  const [controllerReady, setControllerReady] = useState(false);
  const [controllerReason, setControllerReason] = useState<string | null>(null);
  const [controllerMissingFiles, setControllerMissingFiles] = useState<string[]>([]);
  const [controllerDialogOpen, setControllerDialogOpen] = useState(false);
  const [deleteTeamId, setDeleteTeamId] = useState<string | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deletingTeam, setDeletingTeam] = useState(false);
  const [controllerPromptTemplate, setControllerPromptTemplate] = useState(() => {
    try {
      const saved = window.localStorage.getItem(TEAM_CONTROLLER_PROMPT_STORAGE_KEY);
      return saved?.trim() || DEFAULT_TEAM_CONTROLLER_PROMPT;
    } catch {
      return DEFAULT_TEAM_CONTROLLER_PROMPT;
    }
  });

  const teams = useTeamsStore((state) => state.teams);
  const teamPhaseById = useTeamsStore((state) => state.teamPhaseById);
  const teamMemberRuntimeById = useTeamsStore((state) => state.teamMemberRuntimeById);
  const teamSessionKeys = useTeamsStore((state) => state.teamSessionKeys);
  const createTeam = useTeamsStore((state) => state.createTeam);
  const deleteTeam = useTeamsStore((state) => state.deleteTeam);
  const setActiveTeam = useTeamsStore((state) => state.setActiveTeam);
  const agents = useSubagentsStore((state) => state.agents);
  const availableModels = useSubagentsStore((state) => state.availableModels);
  const modelsLoading = useSubagentsStore((state) => state.modelsLoading);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);
  const loadAvailableModels = useSubagentsStore((state) => state.loadAvailableModels);
  const createAgent = useSubagentsStore((state) => state.createAgent);
  const setDraftPromptForAgent = useSubagentsStore((state) => state.setDraftPromptForAgent);
  const setManagedAgentId = useSubagentsStore((state) => state.setManagedAgentId);
  const navigate = useNavigate();

  const agentById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents]
  );
  const defaultControllerModel = availableModels[0]?.id ?? agents[0]?.model ?? '';
  const controllerMissingText = controllerMissingFiles.join(', ');
  const deletingTargetTeam = deleteTeamId ? teams.find((team) => team.id === deleteTeamId) : null;

  const refreshControllerStatus = useCallback(async () => {
    setControllerChecking(true);
    try {
      const status = await checkTeamControllerReadiness(TEAM_CONTROLLER_ID);
      setControllerReady(status.ready);
      setControllerReason(status.reason ?? null);
      setControllerMissingFiles(status.missingFiles);
      if (!status.ready && status.reason === 'missing-agent') {
        setControllerDialogOpen(true);
      }
      return status;
    } catch {
      setControllerReady(false);
      setControllerReason('check-failed');
      setControllerMissingFiles([]);
      return null;
    } finally {
      setControllerChecking(false);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
    void loadAvailableModels();
    void refreshControllerStatus();
  }, [loadAgents, loadAvailableModels, refreshControllerStatus]);

  useEffect(() => {
    if (!createOpen || agents.length === 0) {
      return;
    }
    setTeamName(t('actions.defaultTeamName', { count: teams.length + 1 }));
    setControllerId(agents[0].id);
    setSelectedMemberIds(agents.map((agent) => agent.id));
  }, [createOpen, agents, teams.length, t]);

  const handleSubmitCreateTeam = () => {
    if (agents.length === 0) {
      return;
    }
    const trimmedName = teamName.trim();
    const members = selectedMemberIds.filter((id) => agentById.has(id));
    if (!trimmedName || !controllerId || members.length === 0) {
      return;
    }
    const memberIds = members.includes(controllerId) ? members : [controllerId, ...members];
    const teamId = createTeam({
      name: trimmedName,
      controllerId,
      memberIds,
    });
    setActiveTeam(teamId);
    setCreateOpen(false);
    navigate(`/teams/${teamId}`);
  };

  const toggleMember = (agentId: string) => {
    setSelectedMemberIds((prev) => {
      if (prev.includes(agentId)) {
        if (agentId === controllerId) {
          return prev;
        }
        return prev.filter((id) => id !== agentId);
      }
      return [...prev, agentId];
    });
  };

  const handleCreateController = async (values: {
    name: string;
    workspace: string;
    model: string;
    emoji: string;
    prompt: string;
  }) => {
    const prompt = values.prompt.trim();
    setControllerPromptTemplate(prompt || DEFAULT_TEAM_CONTROLLER_PROMPT);
    try {
      window.localStorage.setItem(
        TEAM_CONTROLLER_PROMPT_STORAGE_KEY,
        prompt || DEFAULT_TEAM_CONTROLLER_PROMPT
      );
    } catch {
      // Ignore persistence failures and keep in-memory template.
    }

    const beforeCreate = await checkTeamControllerReadiness(TEAM_CONTROLLER_ID);
    if (!beforeCreate.exists) {
      await createAgent({
        name: TEAM_CONTROLLER_NAME,
        workspace: values.workspace,
        model: values.model,
        emoji: values.emoji || TEAM_CONTROLLER_EMOJI,
      });
    }
    const createdControllerId = normalizeSubagentNameToSlug(TEAM_CONTROLLER_NAME);
    setDraftPromptForAgent(createdControllerId, prompt || DEFAULT_TEAM_CONTROLLER_PROMPT);
    setManagedAgentId(createdControllerId);
    await loadAgents();
    const status = await refreshControllerStatus();
    if (status?.ready) {
      setControllerDialogOpen(false);
      return;
    }
    setControllerDialogOpen(false);
    navigate('/subagents');
  };

  const openControllerInSubagents = () => {
    setManagedAgentId(TEAM_CONTROLLER_ID);
    setDraftPromptForAgent(TEAM_CONTROLLER_ID, controllerPromptTemplate || DEFAULT_TEAM_CONTROLLER_PROMPT);
    navigate('/subagents');
  };

  const handleRequestDeleteTeam = (teamId: string) => {
    setDeleteTeamId(teamId);
    setDeleteConfirmText('');
  };

  const handleConfirmDeleteTeam = async () => {
    if (!deletingTargetTeam) {
      return;
    }
    if (deleteConfirmText.trim() !== deletingTargetTeam.name) {
      return;
    }
    setDeletingTeam(true);
    const cleanupErrors: string[] = [];
    try {
      const sessionMap = teamSessionKeys[deletingTargetTeam.id] ?? {};
      const sessionKeys = deletingTargetTeam.memberIds.map((agentId) => (
        sessionMap[agentId] ?? `agent:${agentId}:team:${deletingTargetTeam.id}`
      ));
      try {
        await deleteTeamSessions(sessionKeys);
      } catch (error) {
        cleanupErrors.push(`sessions: ${error instanceof Error ? error.message : String(error)}`);
      }

      const workspaceByAgent = deletingTargetTeam.memberIds.reduce<Record<string, string>>((acc, agentId) => {
        const workspace = agents.find((agent) => agent.id === agentId)?.workspace?.trim();
        if (workspace) {
          acc[agentId] = workspace;
        }
        return acc;
      }, {});
      try {
        await deleteTeamArtifactsLayout({
          teamId: deletingTargetTeam.id,
          controllerId: deletingTargetTeam.controllerId,
          workspaceByAgent,
        });
      } catch (error) {
        cleanupErrors.push(`artifacts: ${error instanceof Error ? error.message : String(error)}`);
      }

      deleteTeam(deletingTargetTeam.id);
      if (cleanupErrors.length > 0) {
        toast.error(t('flow.teamDeletePartial', { error: cleanupErrors.join(' | ') }));
      } else {
        toast.success(t('flow.teamDeleteSuccess', { name: deletingTargetTeam.name }));
      }
      setDeleteTeamId(null);
      setDeleteConfirmText('');
    } catch (error) {
      toast.error(t('flow.teamDeleteFailed', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setDeletingTeam(false);
    }
  };

  if (controllerChecking) {
    return (
      <section className="space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
        </header>
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            {t('bootstrap.checking')}
          </CardContent>
        </Card>
      </section>
    );
  }

  if (!controllerReady) {
    return (
      <section className="space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
        </header>
        <Card>
          <CardContent className="space-y-3 py-4">
            <div className="text-sm font-medium">{t('bootstrap.blockedTitle')}</div>
            <div className="text-sm text-muted-foreground">
              {controllerReason === 'missing-agent' && t('bootstrap.missingAgent')}
              {controllerReason === 'missing-files' && t('bootstrap.missingFiles', { files: controllerMissingText })}
              {controllerReason === 'agents-md-empty' && t('bootstrap.agentsMdEmpty')}
              {controllerReason === 'check-failed' && t('bootstrap.checkFailed')}
            </div>
            <div className="flex flex-wrap gap-2">
              {controllerReason === 'missing-agent' && (
                <Button onClick={() => setControllerDialogOpen(true)}>
                  {t('bootstrap.createController')}
                </Button>
              )}
              <Button variant="outline" onClick={openControllerInSubagents}>
                {t('bootstrap.goSubagents')}
              </Button>
              <Button variant="outline" onClick={() => { void refreshControllerStatus(); }}>
                {t('bootstrap.recheck')}
              </Button>
            </div>
          </CardContent>
        </Card>
        <SubagentFormDialog
          open={controllerDialogOpen}
          title={t('bootstrap.dialogTitle')}
          mode="create"
          existingAgents={agents}
          modelOptions={availableModels}
          modelsLoading={modelsLoading}
          initialValues={{
            name: TEAM_CONTROLLER_NAME,
            model: defaultControllerModel,
            emoji: TEAM_CONTROLLER_EMOJI,
            prompt: controllerPromptTemplate,
          }}
          onSubmit={handleCreateController}
          onClose={() => setControllerDialogOpen(false)}
        />
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <Button onClick={() => setCreateOpen(true)} disabled={agents.length === 0}>
          {t('actions.newTeam')}
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">{t('lists.teams')}</h2>
          <div className="space-y-3">
            {teams.length === 0 ? (
              <Card>
                <CardContent className="py-4 text-sm text-muted-foreground">
                  {t('lists.emptyTeams')}
                </CardContent>
              </Card>
            ) : (
              teams.map((team) => (
                <Card
                  key={team.id}
                  className="cursor-pointer hover:border-primary/40 transition-colors"
                  onClick={() => {
                    setActiveTeam(team.id);
                    navigate(`/teams/${team.id}`);
                  }}
                >
                  <CardContent className="py-4 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-medium">{team.name}</div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label={t('deleteDialog.trigger')}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRequestDeleteTeam(team.id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('card.memberCount', { count: team.memberIds.length })}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('card.phase')}: {t(`phase.${teamPhaseById[team.id] ?? 'discussion'}`)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('card.lastActive')}: {formatRelativeTime(team.updatedAt)}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">{t('lists.agents')}</h2>
          <div className="space-y-3">
            {agents.length === 0 ? (
              <Card>
                <CardContent className="py-4 text-sm text-muted-foreground">
                  {t('lists.emptyAgents')}
                </CardContent>
              </Card>
            ) : (
              agents.map((agent) => (
                <Card
                  key={agent.id}
                  className="cursor-pointer hover:border-primary/40 transition-colors"
                  onClick={() => {
                    setManagedAgentId(agent.id);
                    navigate('/subagents');
                  }}
                >
                  <CardContent className="py-4 space-y-1">
                    <div className="text-sm font-medium">{agent.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {t('card.roleTag')}: {agent.id}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {agent.model ?? t('card.modelFallback')}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('card.statusLabel')}: {(() => {
                        const allRuntime = Object.values(teamMemberRuntimeById)
                          .map((members) => members?.[agent.id])
                          .filter(Boolean);
                        if (allRuntime.length === 0) {
                          return t('panel.status.idle');
                        }
                        const latest = [...allRuntime].sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))[0];
                        return t(`panel.status.${latest?.status ?? 'idle'}`);
                      })()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('card.lastActive')}: {(() => {
                        const allRuntime = Object.values(teamMemberRuntimeById)
                          .map((members) => members?.[agent.id])
                          .filter(Boolean);
                        const latestUpdatedAt = allRuntime.reduce<number | undefined>((acc, item) => {
                          const value = item?.updatedAt;
                          if (!value) {
                            return acc;
                          }
                          if (!acc || value > acc) {
                            return value;
                          }
                          return acc;
                        }, undefined);
                        return formatRelativeTime(latestUpdatedAt);
                      })()}
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </div>
      </div>

      {createOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
          <section className="w-full max-w-md rounded-lg border bg-background p-4 shadow-lg">
            <header className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">{t('createDialog.title')}</h2>
              <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>
                {t('createDialog.close')}
              </Button>
            </header>

            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="team-name">{t('createDialog.teamName')}</Label>
                <Input
                  id="team-name"
                  value={teamName}
                  onChange={(event) => setTeamName(event.target.value)}
                />
              </div>

              <div className="space-y-1">
                <Label htmlFor="controller-id">{t('createDialog.controller')}</Label>
                <Select
                  id="controller-id"
                  value={controllerId}
                  onChange={(event) => {
                    const nextControllerId = event.target.value;
                    setControllerId(nextControllerId);
                    if (!selectedMemberIds.includes(nextControllerId)) {
                      setSelectedMemberIds((prev) => [...prev, nextControllerId]);
                    }
                  }}
                >
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name} ({agent.id})
                    </option>
                  ))}
                </Select>
              </div>

              <div className="space-y-1">
                <Label>{t('createDialog.members')}</Label>
                <div className="max-h-36 space-y-1 overflow-auto rounded border p-2">
                  {agents.map((agent) => (
                    <label key={agent.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selectedMemberIds.includes(agent.id)}
                        onChange={() => toggleMember(agent.id)}
                        disabled={agent.id === controllerId}
                      />
                      <span>{agent.name}</span>
                      <span className="text-xs text-muted-foreground">({agent.id})</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCreateOpen(false)}>
                {t('createDialog.cancel')}
              </Button>
              <Button
                onClick={handleSubmitCreateTeam}
                disabled={!teamName.trim() || !controllerId || selectedMemberIds.length === 0}
              >
                {t('createDialog.confirm')}
              </Button>
            </div>
          </section>
        </div>
      )}
      <TeamDeleteDialog
        open={!!deletingTargetTeam}
        teamName={deletingTargetTeam?.name ?? null}
        confirmValue={deleteConfirmText}
        deleting={deletingTeam}
        onConfirmValueChange={setDeleteConfirmText}
        onClose={() => {
          if (deletingTeam) {
            return;
          }
          setDeleteTeamId(null);
          setDeleteConfirmText('');
        }}
        onConfirm={handleConfirmDeleteTeam}
      />
    </section>
  );
}

export default TeamsPage;
