import { invokeIpc } from '@/lib/api-client';
import type { PluginCleanup } from '@/plugin-host/core';
import type { AppTeam } from '../../../sdk/app-plugins/src/execution';
import { TEAMS_FEATURE_ENABLED } from './feature-flag';
import type { TeamMeta } from './types/team';

const CHANNEL = 'app-plugins:execution-teams';
let revision = Number(import.meta.hot?.data.executionTeamsRevision ?? 0);
let stopProjection: PluginCleanup | undefined;

function projectTeams(teams: readonly TeamMeta[]): AppTeam[] {
  return teams.map((team) => ({
    teamId: team.id,
    name: team.name,
    // The store's pre-cutover TeamMeta contract is local OpenClaw (store.ts:329).
    scope: team.runtimeScope ?? {
      kind: 'runtime-instance',
      endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
    },
    packagePath: team.packagePath,
    sourceType: team.sourceType ?? 'teamskill',
  }));
}

export function observeTeamExecutionTargets(): PluginCleanup {
  stopProjection?.();
  let active = true;
  let unsubscribe = () => {};
  let pending: readonly AppTeam[] | undefined;
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
  const publish = (teams: readonly TeamMeta[]) => {
    const next = projectTeams(teams);
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
    void import('./store').then(({ useTeamsStore }) => {
      if (!active) return;
      unsubscribe = useTeamsStore.subscribe((state, previousState) => {
        if (state.teams !== previousState.teams) publish(state.teams);
      });
      publish(useTeamsStore.getState().teams);
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
