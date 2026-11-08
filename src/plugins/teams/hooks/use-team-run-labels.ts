import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ChatStoreState } from '@/plugins/chat/store';
import { findSessionRecordKey, readSessionsFromState, readSessionTitlesFromState, resolveSessionListLabel } from '@/plugins/chat/session-catalog';
import { useTeamsStore } from '@/plugins/teams/store';
import type { TeamRunListItem } from '@/plugins/teams/services/team-runtime-client';
import type { SessionIdentity } from '@/types/desktop/runtime-address';

export function resolveTeamRunLabels(
  state: Pick<ChatStoreState, 'loadedSessions' | 'sessionRecordKeyByIdentityKey'>,
  runsByTeamId: Record<string, readonly TeamRunListItem[]>,
  unnamedLabel: string,
): Record<string, string> {
  return buildTeamRunLabels(runsByTeamId, unnamedLabel, (identity) => {
    const recordKey = findSessionRecordKey(state, identity);
    return recordKey ? resolveSessionListLabel(state, recordKey) : null;
  });
}

function buildTeamRunLabels(
  runsByTeamId: Record<string, readonly TeamRunListItem[]>,
  unnamedLabel: string,
  titleForIdentity: (identity: SessionIdentity) => string | null,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const runs of Object.values(runsByTeamId)) {
    for (const run of runs) {
      const leader = run.sessions.find((role) => role.roleId === 'leader');
      labels[run.runId] = (leader ? titleForIdentity(leader.sessionIdentity) : null) ?? unnamedLabel;
    }
  }
  return labels;
}

function createTeamRunLabelsSelector(runsByTeamId: Record<string, readonly TeamRunListItem[]>, unnamedLabel: string) {
  let sessions: ReturnType<typeof readSessionsFromState> | undefined;
  let titles: ReturnType<typeof readSessionTitlesFromState> | undefined;
  let identities: ChatStoreState['sessionRecordKeyByIdentityKey'] | undefined;
  let labels: Record<string, string> = {};
  return (state: ChatStoreState) => {
    const nextSessions = readSessionsFromState(state);
    const nextTitles = readSessionTitlesFromState(state);
    if (sessions !== nextSessions || titles !== nextTitles || identities !== state.sessionRecordKeyByIdentityKey) {
      sessions = nextSessions;
      titles = nextTitles;
      identities = state.sessionRecordKeyByIdentityKey;
      labels = buildTeamRunLabels(runsByTeamId, unnamedLabel, (identity) => {
        const recordKey = findSessionRecordKey(state, identity);
        return recordKey ? nextTitles[recordKey] ?? null : null;
      });
    }
    return labels;
  };
}

export function useTeamRunLabels(): Record<string, string> {
  const { t } = useTranslation('common');
  const runsByTeamId = useTeamsStore((state) => state.runListByTeamId);
  const unnamedLabel = t('sidebar.newSession');
  const selectLabels = useMemo(() => createTeamRunLabelsSelector(runsByTeamId, unnamedLabel), [runsByTeamId, unnamedLabel]);
  return useChatStore(useShallow(selectLabels));
}
