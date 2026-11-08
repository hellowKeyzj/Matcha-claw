import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SquarePen, Users } from 'lucide-react';
import { useChatStore } from '@/plugins/chat/store';
import { useTeamRunLabels } from '@/plugins/teams/hooks/use-team-run-labels';
import { useTeamSessionProjection } from '@/plugins/teams/session-projection';
import { useTeamSessionNavigation } from '@/plugins/teams/session-navigation';
import {
  buildAgentSessionSwitchboardTeams,
  type AgentSessionSwitchboardTeamRoleInput,
  type AgentSessionSwitchboardTeamRunResult,
} from './agent-session-switchboard-model';
import { cn } from '@/lib/utils';
import { showWorkspaceChat } from '@/plugins/workspace/actions';

const rowClass = 'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring';
const iconClass = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';

export const TeamSessionsSidebar = memo(function TeamSessionsSidebar({ query }: { query: string }) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const teams = useTeamSessionProjection((state) => state.teams);
  const runListByTeamId = useTeamSessionProjection((state) => state.runListByTeamId);
  const runLabels = useTeamRunLabels();
  const createRun = useTeamSessionNavigation((state) => state.createRun);
  const setActiveRun = useTeamSessionNavigation((state) => state.setActiveRun);
  const syncRunList = useTeamSessionNavigation((state) => state.syncRunList);
  const refreshSnapshot = useTeamSessionNavigation((state) => state.refreshSnapshot);
  const openSessionIdentity = useChatStore((state) => state.openSessionIdentity);
  const [collapsedTeams, setCollapsedTeams] = useState<Record<string, boolean>>({});
  const [creatingTeams, setCreatingTeams] = useState<Record<string, boolean>>({});
  const [createErrors, setCreateErrors] = useState<Record<string, boolean>>({});
  const [syncState, setSyncState] = useState<{ key: string | null; failed: boolean }>({ key: null, failed: false });
  const teamSyncKey = JSON.stringify(teams.map((team) => team.id));
  const syncPending = syncState.key !== teamSyncKey;
  useEffect(() => {
    let active = true;
    const ids = JSON.parse(teamSyncKey) as string[];
    void Promise.allSettled(ids.map((teamId) => syncRunList(teamId))).then((results) => {
      if (active) setSyncState({ key: teamSyncKey, failed: results.some((result) => result.status === 'rejected') });
    });
    return () => { active = false; };
  }, [syncRunList, teamSyncKey]);
  const nodes = useMemo(() => buildAgentSessionSwitchboardTeams(teams
    .map((team) => ({
      teamId: team.id,
      teamName: team.name,
      activeRunId: team.activeRunId,
      runs: (runListByTeamId[team.id] ?? []).map((run) => {
        const sessions = run.sessions ?? [];
        const toRole = (role: (typeof sessions)[number]): AgentSessionSwitchboardTeamRoleInput => ({
          roleId: role.roleId,
          agentId: role.agentId,
          sessionIdentity: role.sessionIdentity,
        });
        const leader = sessions.find((role) => role.roleId === 'leader');
        return {
          runId: run.runId,
          label: runLabels[run.runId] ?? t('sidebar.newSession'),
          leader: leader ? toRole(leader) : null,
          roles: sessions.filter((role) => role.roleId !== 'leader').map(toRole),
        };
      }),
    }))), [runLabels, runListByTeamId, teams, t]);
  const openRole = useCallback((teamId: string, runId: string, role: AgentSessionSwitchboardTeamRoleInput) => {
    showWorkspaceChat();
    setActiveRun(teamId, runId);
    openSessionIdentity({ sessionIdentity: role.sessionIdentity });
    navigate('/', { state: { teamDesignSurface: { kind: 'team-graph', sourceSessionIdentity: role.sessionIdentity, teamId, runId } } });
    void refreshSnapshot(teamId, { force: true }).catch(() => { /* Error already reported by the Teams owner. */ });
  }, [navigate, openSessionIdentity, refreshSnapshot, setActiveRun]);
  const openRun = useCallback((teamId: string, run: AgentSessionSwitchboardTeamRunResult) => {
    if (run.leader) openRole(teamId, run.runId, run.leader);
    else {
      setActiveRun(teamId, run.runId);
      void refreshSnapshot(teamId, { force: true }).catch(() => { /* Error already reported by the Teams owner. */ });
    }
  }, [openRole, refreshSnapshot, setActiveRun]);
  const newRun = async (teamId: string) => {
    if (creatingTeams[teamId]) return;
    setCreatingTeams((current) => ({ ...current, [teamId]: true }));
    setCreateErrors((current) => ({ ...current, [teamId]: false }));
    try {
      await createRun(teamId);
    } catch {
      setCreateErrors((current) => ({ ...current, [teamId]: true }));
    } finally {
      setCreatingTeams((current) => ({ ...current, [teamId]: false }));
    }
  };
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = nodes.map((team) => ({ ...team, runs: normalizedQuery
    ? team.runs.filter((run) => run.label.toLocaleLowerCase().includes(normalizedQuery)) : team.runs }))
    .filter((team) => !normalizedQuery || team.runs.length > 0);
  return (
    <div data-testid="team-list-scroll-area" className="space-y-0.5">
      {syncState.failed && <p role="alert" className="px-2 text-xs text-destructive">{t('status.error')}</p>}
      {syncPending && nodes.every((team) => team.runs.length === 0) && (
        <div role="status" aria-label={t('status.loading')} className="space-y-2 px-2 py-2">
          <div className="h-6 rounded-md bg-secondary" /><div className="h-6 rounded-md bg-secondary" />
        </div>
      )}
      {visible.length === 0 && !syncPending && <p className="px-2 py-3 text-xs text-muted-foreground">{t(normalizedQuery ? 'switchboard.noSearchResults' : 'sidebar.noTeams')}</p>}
      {visible.map((team) => {
        const expanded = !collapsedTeams[team.teamId] || Boolean(normalizedQuery);
        return (
          <section key={team.teamId}>
            <div className="group/team relative flex items-center gap-0.5 rounded-md px-1 hover:bg-secondary/70">
              <button type="button" className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-left text-[13px] leading-5 font-medium text-foreground outline-none group-hover/team:pr-8 group-focus-within/team:pr-8 [@media(hover:none)]:pr-8 focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={expanded}
                onClick={() => setCollapsedTeams((current) => ({ ...current, [team.teamId]: !current[team.teamId] }))}>
                <Users className="h-5 w-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{team.teamName}</span>
              </button>
              <button type="button" className={cn(iconClass, 'pointer-events-none absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 group-hover/team:pointer-events-auto group-hover/team:opacity-100 group-focus-within/team:pointer-events-auto group-focus-within/team:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100')} aria-label={t('switchboard.newRun')} title={t('switchboard.newRun')}
                disabled={creatingTeams[team.teamId]} onClick={() => void newRun(team.teamId)}><SquarePen className="h-3.5 w-3.5" /></button>
            </div>
            {createErrors[team.teamId] && <p role="alert" className="px-2 py-1 text-xs text-destructive">{t('switchboard.newRunFailed')}</p>}
            {expanded && <div className="mb-1 space-y-0.5 border-l border-border/50 pl-1">
              {team.runs.length === 0 && !syncPending && <p className="px-2 py-2 text-xs text-muted-foreground">{t('sidebar.noAgentSessions')}</p>}
              {team.runs.map((run) => <button key={run.runId} type="button"
                className={cn(rowClass, 'w-full', run.isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground')}
                title={`${run.label}\n${run.runId}`} aria-current={run.isActive ? 'true' : undefined} onClick={() => openRun(team.teamId, run)}>
                <span className="truncate">{run.label}</span>
              </button>)}
            </div>}
          </section>
        );
      })}
    </div>
  );
});
