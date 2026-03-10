import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useSubagentsStore } from '@/stores/subagents';
import { useTeamsStore } from '@/stores/teams';
import { useTranslation } from 'react-i18next';

export function TeamsPage() {
  const { t } = useTranslation('teams');
  const subtitle = t('subtitle');
  const navigate = useNavigate();
  const agents = useSubagentsStore((state) => state.agents);
  const loadAgents = useSubagentsStore((state) => state.loadAgents);

  const teams = useTeamsStore((state) => state.teams);
  const createTeam = useTeamsStore((state) => state.createTeam);
  const setActiveTeam = useTeamsStore((state) => state.setActiveTeam);
  const deleteTeam = useTeamsStore((state) => state.deleteTeam);
  const initRuntime = useTeamsStore((state) => state.initRuntime);
  const loadingByTeamId = useTeamsStore((state) => state.loadingByTeamId);

  const [teamName, setTeamName] = useState('');
  const [leadAgentId, setLeadAgentId] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const effectiveLeadAgentId = useMemo(() => {
    if (!leadAgentId) {
      return agents[0]?.id ?? '';
    }
    return agents.some((agent) => agent.id === leadAgentId)
      ? leadAgentId
      : (agents[0]?.id ?? '');
  }, [agents, leadAgentId]);

  const effectiveMemberIds = useMemo(() => {
    const validMembers = memberIds.filter((id) => agents.some((agent) => agent.id === id));
    const fallback = effectiveLeadAgentId ? [effectiveLeadAgentId] : [];
    const base = validMembers.length > 0 ? validMembers : fallback;
    if (effectiveLeadAgentId && !base.includes(effectiveLeadAgentId)) {
      return [effectiveLeadAgentId, ...base];
    }
    return base;
  }, [agents, effectiveLeadAgentId, memberIds]);

  const availableMembers = useMemo(
    () => agents.map((agent) => ({ id: agent.id, label: agent.name ?? agent.id })),
    [agents],
  );

  const toggleMember = (agentId: string) => {
    setMemberIds((prev) => {
      if (prev.includes(agentId)) {
        if (agentId === effectiveLeadAgentId) {
          return prev;
        }
        return prev.filter((id) => id !== agentId);
      }
      return [...prev, agentId];
    });
  };

  const handleCreate = async () => {
    if (!effectiveLeadAgentId) {
      return;
    }
    const name = teamName.trim() || t('defaultValues.teamName', 'New Team');
    const members = effectiveMemberIds.includes(effectiveLeadAgentId)
      ? effectiveMemberIds
      : [effectiveLeadAgentId, ...effectiveMemberIds];
    const teamId = createTeam({
      name,
      leadAgentId: effectiveLeadAgentId,
      memberIds: members,
    });
    setActiveTeam(teamId);
    await initRuntime(teamId);
    navigate(`/teams/${teamId}`);
  };

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('create.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="team-name">{t('create.teamName')}</Label>
            <Input
              id="team-name"
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
              placeholder={t('create.teamNamePlaceholder')}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lead-agent">{t('create.leadAgent')}</Label>
            <Select
              id="lead-agent"
              value={effectiveLeadAgentId}
              onChange={(event) => {
                const nextLead = event.target.value;
                setLeadAgentId(nextLead);
                setMemberIds((prev) => (prev.includes(nextLead) ? prev : [...prev, nextLead]));
              }}
            >
              <option value="">{t('create.selectLead')}</option>
              {availableMembers.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t('create.members')}</Label>
            <div className="max-h-32 space-y-1 overflow-auto rounded border p-2">
              {availableMembers.map((agent) => (
                <label key={agent.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={effectiveMemberIds.includes(agent.id)}
                    onChange={() => toggleMember(agent.id)}
                    disabled={agent.id === effectiveLeadAgentId}
                  />
                  <span>{agent.label}</span>
                  <span className="text-xs text-muted-foreground">({agent.id})</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end">
            <Button
              onClick={() => void handleCreate()}
              disabled={!effectiveLeadAgentId || effectiveMemberIds.length === 0}
            >
              {t('create.createButton')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">{t('list.title')}</h2>
        {teams.length === 0 ? (
          <Card>
            <CardContent className="py-4 text-sm text-muted-foreground">{t('list.empty')}</CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {teams.map((team) => (
              <Card key={team.id}>
                <CardContent className="py-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">{team.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {t('list.lead')}: {team.leadAgentId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t('list.members')}: {team.memberIds.join(', ')}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={async () => {
                          setActiveTeam(team.id);
                          if (!loadingByTeamId[team.id]) {
                            await initRuntime(team.id);
                          }
                          navigate(`/teams/${team.id}`);
                        }}
                      >
                        {t('list.open')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => deleteTeam(team.id)}
                      >
                        {t('list.delete')}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default TeamsPage;
