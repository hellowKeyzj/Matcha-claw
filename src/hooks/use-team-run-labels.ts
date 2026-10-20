import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type ChatStoreState } from '@/stores/chat';
import { findSessionRecordKey } from '@/stores/chat/session-identity';
import { readSessionsFromState, readSessionTitlesFromState, resolveSessionListLabel } from '@/stores/chat/session-helpers';
import { useTeamsStore } from '@/stores/teams';
import type { TeamRunListItem } from '@/services/openclaw/team-runtime-client';
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
    const titles = runs.map((run) => {
      const leader = run.sessions.find((role) => role.roleId === 'leader');
      return leader ? titleForIdentity(leader.sessionIdentity) : null;
    });
    const counts = new Map<string | null, number>();
    for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1);
    runs.forEach((run, index) => {
      const title = titles[index];
      const shortId = run.runId.replace(/^teamrun-/, '').slice(0, 8);
      labels[run.runId] = title === null
        ? `${unnamedLabel} · ${shortId}`
        : counts.get(title)! > 1 ? `${title} · ${shortId}` : title;
    });
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
  const { t } = useTranslation('teams');
  const runsByTeamId = useTeamsStore((state) => state.runListByTeamId);
  const unnamedLabel = t('run.unnamed');
  const selectLabels = useMemo(() => createTeamRunLabelsSelector(runsByTeamId, unnamedLabel), [runsByTeamId, unnamedLabel]);
  return useChatStore(useShallow(selectLabels));
}
