import type { SessionIdentity } from '../../types/desktop/runtime-address';

export interface SessionOperationTarget {
  sessionKey: string;
  endpointSessionId?: string;
  sessionIdentity: SessionIdentity;
}

export function buildSessionOperationTarget(
  sessionIdentity: SessionIdentity,
  endpointSessionId?: string | null,
): SessionOperationTarget {
  return {
    sessionKey: sessionIdentity.sessionKey,
    ...(endpointSessionId ? { endpointSessionId } : {}),
    sessionIdentity,
  };
}
