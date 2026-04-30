import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { listIndexedSessions, readSessionsIndex } from './session-index';

interface SessionFileResolverDeps {
  getOpenClawConfigDir: () => string;
}

interface SessionFileResolution {
  sessionKey: string;
  agentId: string;
  sessionsDir: string;
  transcriptPath: string;
}

function parseSessionKey(sessionKey: string): { agentId: string } | null {
  if (!sessionKey.startsWith('agent:')) {
    return null;
  }
  const parts = sessionKey.split(':');
  if (parts.length < 3) {
    return null;
  }
  const agentId = parts[1]?.trim();
  if (!agentId) {
    return null;
  }
  return { agentId };
}


export class SessionFileResolver {
  constructor(private readonly deps: SessionFileResolverDeps) {}

  async resolve(sessionKey: string): Promise<SessionFileResolution | null> {
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) {
      return null;
    }

    const sessionsDir = join(this.deps.getOpenClawConfigDir(), 'agents', parsed.agentId, 'sessions');
    const sessionsJsonPath = join(sessionsDir, 'sessions.json');
    const sessionsJson = await readSessionsIndex(sessionsJsonPath);

    const indexedTranscriptPath = listIndexedSessions(sessionsJson, sessionsDir)
      .find((entry) => entry.sessionKey === sessionKey)
      ?.transcriptPath
      ?? null;
    const fallbackTranscriptPath = join(sessionsDir, `${sessionKey.split(':').slice(2).join(':')}.jsonl`);
    const transcriptPath = indexedTranscriptPath ?? fallbackTranscriptPath;

    try {
      await access(transcriptPath);
    } catch {
      return null;
    }

    return {
      sessionKey,
      agentId: parsed.agentId,
      sessionsDir,
      transcriptPath,
    };
  }
}
