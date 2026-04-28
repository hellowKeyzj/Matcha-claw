import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface SessionFileResolverDeps {
  getOpenClawConfigDir: () => string;
}

interface SessionFileResolution {
  sessionKey: string;
  agentId: string;
  sessionsDir: string;
  transcriptPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

async function readSessionsIndex(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pickIndexedTranscriptPath(
  sessionsJson: Record<string, unknown> | null,
  sessionKey: string,
  sessionsDir: string,
): string | null {
  if (!sessionsJson) {
    return null;
  }

  let resolvedSrcPath: string | null = null;
  let fileName: string | null = null;

  if (Array.isArray(sessionsJson.sessions)) {
    const entry = sessionsJson.sessions.find((session) => {
      if (!isRecord(session)) {
        return false;
      }
      return session.key === sessionKey || session.sessionKey === sessionKey;
    });
    if (isRecord(entry)) {
      const indexedPath = entry.sessionFile || entry.file || entry.fileName || entry.path;
      if (typeof indexedPath === 'string' && indexedPath.trim()) {
        if (indexedPath.includes(':\\') || indexedPath.startsWith('/')) {
          resolvedSrcPath = indexedPath;
        } else {
          fileName = indexedPath;
        }
      } else if (typeof entry.id === 'string' && entry.id.trim()) {
        fileName = `${entry.id}.jsonl`;
      }
    }
  }

  if (!resolvedSrcPath && !fileName && sessionsJson[sessionKey] != null) {
    const entry = sessionsJson[sessionKey];
    if (typeof entry === 'string' && entry.trim()) {
      fileName = entry;
    } else if (isRecord(entry)) {
      const indexedPath = entry.sessionFile || entry.file || entry.fileName || entry.path;
      if (typeof indexedPath === 'string' && indexedPath.trim()) {
        if (indexedPath.includes(':\\') || indexedPath.startsWith('/')) {
          resolvedSrcPath = indexedPath;
        } else {
          fileName = indexedPath;
        }
      } else {
        const sessionId = entry.id || entry.sessionId;
        if (typeof sessionId === 'string' && sessionId.trim()) {
          fileName = sessionId.endsWith('.jsonl') ? sessionId : `${sessionId}.jsonl`;
        }
      }
    }
  }

  if (resolvedSrcPath) {
    return resolvedSrcPath;
  }
  if (!fileName) {
    return null;
  }
  const normalizedFileName = fileName.endsWith('.jsonl') ? fileName : `${fileName}.jsonl`;
  return join(sessionsDir, normalizedFileName);
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

    const indexedTranscriptPath = pickIndexedTranscriptPath(sessionsJson, sessionKey, sessionsDir);
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
