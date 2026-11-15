import { invokeIpc } from '@/lib/api-client';
import type { PluginCleanup } from '@/plugin-host/core';
import type { AppTeam } from '../../../sdk/app-plugins/src/execution';
import { TEAMS_FEATURE_ENABLED } from './feature-flag';
import type { TeamMeta } from './types/team';

const CHANNEL = 'app-plugins:execution-teams';
let revision = Number(import.meta.hot?.data.executionTeamsRevision ?? 0);
let stopProjection: PluginCleanup | undefined;

function projectTeams(teams: readonly TeamMeta[], scopeForTeam: (teamId: string) => AppTeam['scope'] | null): AppTeam[] {
  return teams.map((team) => {
    const scope = scopeForTeam(team.id);
    if (!scope) throw new Error(`Team runtime scope is unavailable: ${team.id}`);
    return {
      teamId: team.id,
      name: team.name,
      scope,
      packagePath: team.packagePath,
      sourceType: team.sourceType ?? 'teamskill',
    };
  });
}

export function observeTeamExecutionTargets(): PluginCleanup {
  stopProjection?.();
  let active = true;
  let unsubscribe = () => {};
  let pending: readonly AppTeam[] | null | undefined;
  let sending = false;
  let previous: string | undefined;
  const push = (teams: readonly AppTeam[] | null) => {
    revision += 1;
    if (import.meta.hot) import.meta.hot.data.executionTeamsRevision = revision;
    return invokeIpc<void>(CHANNEL, { revision, teams });
  };
  const drain = async () => {
    if (sending) return;
    sending = true;
    try {
      while (active && pending !== undefined) {
        const teams = pending;
        pending = undefined;
        try { await push(teams); } catch (error) {
          if (active) {
            previous = undefined;
            console.error('Could not publish the team execution directory.', error);
          }
        }
      }
    } finally { sending = false; }
  };
  const publish = (next: readonly AppTeam[] | null) => {
    const serialized = JSON.stringify(next);
    if (!active || serialized === previous) return;
    previous = serialized;
    pending = next;
    void drain();
  };
  const stop: PluginCleanup = (reason) => {
    if (!active) return;
    active = false;
    unsubscribe();
    pending = undefined;
    if (stopProjection === stop) stopProjection = undefined;
    if (reason !== 'page-exit') {
      // A newer revision invalidates even an older invoke still in flight.
      void push(null).catch((error) => console.error('Could not clear the team execution directory.', error));
    }
  };
  stopProjection = stop;
  if (!TEAMS_FEATURE_ENABLED) {
    publish([]);
  } else {
    void import('./store').then(({ selectTeamRuntimeScope, useTeamsStore }) => {
      if (!active) return;
      const publishState = (state: ReturnType<typeof useTeamsStore.getState>) => {
        try {
          publish(projectTeams(state.teams, (teamId) => selectTeamRuntimeScope(state, teamId)));
        } catch (error) {
          publish(null);
          console.error('Could not resolve the team execution directory.', error);
        }
      };
      unsubscribe = useTeamsStore.subscribe((state, previousState) => {
        if (state.teams !== previousState.teams || state.rolesByTeamId !== previousState.rolesByTeamId
          || state.runListByTeamId !== previousState.runListByTeamId || state.designByRunId !== previousState.designByRunId) publishState(state);
      });
      publishState(useTeamsStore.getState());
    }).catch((error) => {
      if (active) {
        stop();
        console.error('Could not load the team execution directory.', error);
      }
    });
  }
  return stop;
}

if (import.meta.hot) import.meta.hot.dispose(() => stopProjection?.());
