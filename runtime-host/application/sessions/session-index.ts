import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveIndexedTranscriptPath(
  entry: Record<string, unknown>,
  sessionsDir: string,
): string | null {
  const indexedPath = entry.sessionFile ?? entry.file ?? entry.fileName ?? entry.path;
  if (typeof indexedPath === 'string' && indexedPath.trim()) {
    if (indexedPath.includes(':\\') || indexedPath.startsWith('/')) {
      return indexedPath;
    }
    const normalizedFileName = indexedPath.endsWith('.jsonl') ? indexedPath : `${indexedPath}.jsonl`;
    return join(sessionsDir, normalizedFileName);
  }

  const sessionId = entry.id ?? entry.sessionId;
  if (typeof sessionId === 'string' && sessionId.trim()) {
    const normalizedFileName = sessionId.endsWith('.jsonl') ? sessionId : `${sessionId}.jsonl`;
    return join(sessionsDir, normalizedFileName);
  }

  return null;
}

export interface IndexedSessionEntry {
  sessionKey: string;
  transcriptPath: string | null;
}

export async function readSessionsIndex(path: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function listIndexedSessions(
  sessionsJson: Record<string, unknown> | null,
  sessionsDir: string,
): IndexedSessionEntry[] {
  if (!sessionsJson) {
    return [];
  }

  const entries: IndexedSessionEntry[] = [];

  if (Array.isArray(sessionsJson.sessions)) {
    for (const candidate of sessionsJson.sessions) {
      if (!isRecord(candidate)) {
        continue;
      }
      const sessionKey = typeof candidate.key === 'string'
        ? candidate.key.trim()
        : (typeof candidate.sessionKey === 'string' ? candidate.sessionKey.trim() : '');
      if (!sessionKey) {
        continue;
      }
      entries.push({
        sessionKey,
        transcriptPath: resolveIndexedTranscriptPath(candidate, sessionsDir),
      });
    }
    return entries;
  }

  for (const [sessionKey, value] of Object.entries(sessionsJson)) {
    if (!sessionKey.startsWith('agent:')) {
      continue;
    }
    if (typeof value === 'string' && value.trim()) {
      const normalizedFileName = value.endsWith('.jsonl') ? value : `${value}.jsonl`;
      entries.push({
        sessionKey,
        transcriptPath: join(sessionsDir, normalizedFileName),
      });
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    entries.push({
      sessionKey,
      transcriptPath: resolveIndexedTranscriptPath(value, sessionsDir),
    });
  }

  return entries;
}
