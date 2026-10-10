import { useShallow } from 'zustand/react/shallow';
import { useTranslation } from 'react-i18next';
import { useChatStore, type ChatStoreState } from '@/stores/chat';
import { findSessionRecordKey } from '@/stores/chat/session-identity';
import { resolveSessionListLabel } from '@/stores/chat/session-helpers';
import { useTeamsStore } from '@/stores/teams';
import type { TeamRunListItem } from '@/services/openclaw/team-runtime-client';

export function resolveTeamRunLabels(
  state: Pick<ChatStoreState, 'loadedSessions' | 'sessionRecordKeyByIdentityKey'>,
  runsByTeamId: Record<string, readonly TeamRunListItem[]>,
  unnamedLabel: string,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const runs of Object.values(runsByTeamId)) {
    const titles = runs.map((run) => {
      const leader = run.sessions.find((role) => role.roleId === 'leader');
      const recordKey = leader ? findSessionRecordKey(state, leader.sessionIdentity) : null;
      return recordKey ? resolveSessionListLabel(state, recordKey) ?? unnamedLabel : unnamedLabel;
    });
    const counts = new Map<string, number>();
    for (const title of titles) counts.set(title, (counts.get(title) ?? 0) + 1);
    runs.forEach((run, index) => {
      const title = titles[index];
      const shortId = run.runId.replace(/^teamrun-/, '').slice(0, 8);
      labels[run.runId] = counts.get(title)! > 1 ? `${title} · ${shortId}` : title;
    });
  }
  return labels;
}

export function useTeamRunLabels(): Record<string, string> {
  const { t } = useTranslation('teams');
  const runsByTeamId = useTeamsStore((state) => state.runListByTeamId);
  const unnamedLabel = t('run.unnamed');
  return useChatStore(useShallow((state) => resolveTeamRunLabels(state, runsByTeamId, unnamedLabel)));
}
