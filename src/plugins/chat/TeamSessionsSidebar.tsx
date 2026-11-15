import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal, SquarePen, Trash2 } from 'lucide-react';
import { useTeamRunLabels } from '@/plugins/teams/hooks/use-team-run-labels';
import { useTeamSessionProjection } from '@/plugins/teams/session-projection';
import { openTeamRun, useTeamSessionNavigation } from '@/plugins/teams/session-navigation';
import {
  buildAgentSessionSwitchboardTeams,
  type AgentSessionSwitchboardTeamRoleInput,
} from './agent-session-switchboard-model';
import { cn } from '@/lib/utils';
import { TeamAvatarStack } from '@/plugins/teams/TeamAvatarStack';
import { useTeamsStore } from '@/plugins/teams/store';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';

const rowClass = 'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring';
const iconClass = 'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40';

export const TeamSessionsSidebar = memo(function TeamSessionsSidebar({ query }: { query: string }) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const teams = useTeamSessionProjection((state) => state.teams);
  const runListByTeamId = useTeamSessionProjection((state) => state.runListByTeamId);
  const runLabels = useTeamRunLabels();
  const createRun = useTeamSessionNavigation((state) => state.createRun);
  const syncRunList = useTeamSessionNavigation((state) => state.syncRunList);
  const deleteTeam = useTeamsStore((state) => state.deleteTeam);
  const teamErrors = useTeamsStore((state) => state.errorByTeamId);
  const [deletingTeam, setDeletingTeam] = useState<{ teamId: string; teamName: string } | null>(null);
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
  const openRun = useCallback((teamId: string, runId: string) => {
    void openTeamRun(navigate, teamId, runId).catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
  }, [navigate]);
  const newRun = async (teamId: string) => {
    if (creatingTeams[teamId]) return;
    setCreatingTeams((current) => ({ ...current, [teamId]: true }));
    setCreateErrors((current) => ({ ...current, [teamId]: false }));
    try {
      const run = await createRun(teamId);
      openRun(teamId, run.runId);
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
              <button type="button" className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md text-left text-[13px] leading-5 font-medium text-foreground outline-none group-hover/team:pr-14 group-focus-within/team:pr-14 group-has-[[data-state=open]]/team:pr-14 [@media(hover:none)]:pr-14 focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={expanded}
                onClick={() => setCollapsedTeams((current) => ({ ...current, [team.teamId]: !current[team.teamId] }))}>
                <TeamAvatarStack teamId={team.teamId} />
                <span className="min-w-0 flex-1 truncate">{team.teamName}</span>
              </button>
              <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 group-hover/team:pointer-events-auto group-hover/team:opacity-100 group-focus-within/team:pointer-events-auto group-focus-within/team:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><button type="button" className={cn(iconClass, 'h-6 w-6')} aria-label={t('teams:list.actions', { name: team.teamName })}><MoreHorizontal aria-hidden="true" className="h-3.5 w-3.5" /></button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem className="text-destructive" onSelect={() => setDeletingTeam({ teamId: team.teamId, teamName: team.teamName })}><Trash2 aria-hidden="true" className="h-3.5 w-3.5" />{t('teams:list.delete')}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <button type="button" className={cn(iconClass, 'h-6 w-6')} aria-label={t('switchboard.newRun')} title={t('switchboard.newRun')}
                  disabled={creatingTeams[team.teamId]} onClick={() => void newRun(team.teamId)}><SquarePen className="h-3.5 w-3.5" /></button>
              </div>
            </div>
            {teamErrors[team.teamId] && <p role="alert" className="px-2 py-1 text-xs text-destructive">{teamErrors[team.teamId]}</p>}
            {createErrors[team.teamId] && <p role="alert" className="px-2 py-1 text-xs text-destructive">{t('switchboard.newRunFailed')}</p>}
            {expanded && <div className="mb-1 space-y-0.5 border-l border-border/50 pl-1">
              {team.runs.length === 0 && !syncPending && <p className="px-2 py-2 text-xs text-muted-foreground">{t('sidebar.noAgentSessions')}</p>}
              {team.runs.map((run) => <button key={run.runId} type="button"
                className={cn(rowClass, 'w-full', run.isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground')}
                title={`${run.label}\n${run.runId}`} aria-current={run.isActive ? 'true' : undefined} onClick={() => openRun(team.teamId, run.runId)}>
                <span className="truncate">{run.label}</span>
              </button>)}
            </div>}
          </section>
        );
      })}
      <ConfirmDialog open={Boolean(deletingTeam)} title={t('teams:list.delete')} message={t('teams:list.deleteConfirm', { name: deletingTeam?.teamName })}
        confirmLabel={t('actions.delete')} cancelLabel={t('actions.cancel')} variant="destructive" onCancel={() => setDeletingTeam(null)}
        onError={(error) => toast.error(error instanceof Error ? error.message : String(error))}
        onConfirm={async () => {
          if (!deletingTeam) return;
          const result = await deleteTeam(deletingTeam.teamId, { errorFeedback: 'caller' });
          setDeletingTeam(null);
          if (result.state === 'outcome_unknown') toast.warning(t('teams:deleteToast.cleanupUnknownTitle'), { description: t('teams:deleteToast.cleanupUnknownDescription') });
          else toast.success(t('teams:deleteToast.deletedTitle'), { description: t('teams:deleteToast.deletedDescription') });
        }} />
    </div>
  );
});
