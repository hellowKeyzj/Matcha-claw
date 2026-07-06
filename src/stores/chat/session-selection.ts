import { isCronSessionKey } from './cron-session-utils';
import type { ChatSession } from './types';

function sortByRecentActivity(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
}

function sessionMatchesKey(session: ChatSession, sessionKey: string): boolean {
  return session.key === sessionKey
    || session.backendSessionKey === sessionKey
    || session.sessionIdentity.sessionKey === sessionKey;
}

function getSessionOwnerAgentId(session: ChatSession): string | null {
  return session.agentId.trim() || session.sessionIdentity.agentId.trim() || null;
}

function pickMostRecentNonCronSession(sessions: ChatSession[]): string | null {
  const nonCron = sortByRecentActivity(sessions.filter((session) => !isCronSessionKey(session.key)));
  return nonCron[0]?.key ?? null;
}

export function pickStartupSessionFallback(currentSessionKey: string, sessions: ChatSession[]): string | null {
  if (sessions.length === 0) {
    return null;
  }

  const currentSession = sessions.find((session) => sessionMatchesKey(session, currentSessionKey));
  const ownerAgentId = currentSession ? getSessionOwnerAgentId(currentSession) : null;
  if (!ownerAgentId) {
    return pickMostRecentNonCronSession(sessions);
  }

  const agentMainKey = `agent:${ownerAgentId}:main`;
  const agentMain = sessions.find((session) => (
    getSessionOwnerAgentId(session) === ownerAgentId
    && sessionMatchesKey(session, agentMainKey)
  ));
  if (agentMain) {
    return agentMain.key;
  }

  const sameAgentNonCron = sortByRecentActivity(
    sessions.filter((session) => getSessionOwnerAgentId(session) === ownerAgentId && !isCronSessionKey(session.key)),
  );
  if (sameAgentNonCron.length > 0) {
    return sameAgentNonCron[0]!.key;
  }

  return pickMostRecentNonCronSession(sessions);
}
