import { isCronSessionKey } from './cron-session-utils';
import type { ChatSession } from './types';

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) {
    return 'main';
  }
  return sessionKey.split(':')[1]?.trim() || 'main';
}

function sortByRecentActivity(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

export function pickStartupSessionFallback(currentSessionKey: string, sessions: ChatSession[]): string | null {
  if (sessions.length === 0) {
    return null;
  }

  const agentId = getAgentIdFromSessionKey(currentSessionKey);
  const agentMainKey = `agent:${agentId}:main`;
  const agentMain = sessions.find((session) => session.key === agentMainKey);
  if (agentMain) {
    return agentMain.key;
  }

  const sameAgentNonCron = sortByRecentActivity(
    sessions.filter((session) => session.key.startsWith(`agent:${agentId}:`) && !isCronSessionKey(session.key)),
  );
  if (sameAgentNonCron.length > 0) {
    return sameAgentNonCron[0]!.key;
  }

  const nonCron = sortByRecentActivity(sessions.filter((session) => !isCronSessionKey(session.key)));
  return nonCron[0]?.key ?? null;
}
