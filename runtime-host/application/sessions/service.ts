import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface SessionsServiceDeps {
  getOpenClawConfigDir: () => string;
  resolveDeletedPath: (path: string) => string;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class SessionsService {
  constructor(private readonly deps: SessionsServiceDeps) {}

  async delete(payload: unknown) {
    const body = isRecord(payload) ? payload : null;
    const sessionKey = typeof body?.sessionKey === 'string' ? body.sessionKey : '';
    if (!sessionKey || !sessionKey.startsWith('agent:')) {
      return {
        status: 400,
        data: { success: false, error: `Invalid sessionKey: ${sessionKey}` },
      };
    }

    const parts = sessionKey.split(':');
    if (parts.length < 3) {
      return {
        status: 400,
        data: { success: false, error: `sessionKey has too few parts: ${sessionKey}` },
      };
    }

    const agentId = parts[1];
    const sessionsDir = join(this.deps.getOpenClawConfigDir(), 'agents', agentId, 'sessions');
    const sessionsJsonPath = join(sessionsDir, 'sessions.json');
    const sessionsJson = JSON.parse(await readFile(sessionsJsonPath, 'utf8'));

    let uuidFileName: string | undefined;
    let resolvedSrcPath: string | undefined;

    if (isRecord(sessionsJson) && Array.isArray(sessionsJson.sessions)) {
      const entry = sessionsJson.sessions.find((session) => {
        if (!isRecord(session)) {
          return false;
        }
        return session.key === sessionKey || session.sessionKey === sessionKey;
      });
      if (isRecord(entry)) {
        uuidFileName = entry.file || entry.fileName || entry.path;
        if (!uuidFileName && typeof entry.id === 'string') {
          uuidFileName = `${entry.id}.jsonl`;
        }
      }
    }

    if (!uuidFileName && !resolvedSrcPath && isRecord(sessionsJson) && sessionsJson[sessionKey] != null) {
      const entry = sessionsJson[sessionKey];
      if (typeof entry === 'string') {
        uuidFileName = entry;
      } else if (isRecord(entry)) {
        const absFile = entry.sessionFile || entry.file || entry.fileName || entry.path;
        if (typeof absFile === 'string' && absFile.trim()) {
          if (absFile.includes(':\\') || absFile.startsWith('/')) {
            resolvedSrcPath = absFile;
          } else {
            uuidFileName = absFile;
          }
        } else {
          const uuidVal = entry.id || entry.sessionId;
          if (typeof uuidVal === 'string' && uuidVal.trim()) {
            uuidFileName = uuidVal.endsWith('.jsonl') ? uuidVal : `${uuidVal}.jsonl`;
          }
        }
      }
    }

    if (!uuidFileName && !resolvedSrcPath) {
      return {
        status: 404,
        data: { success: false, error: `Cannot resolve file for session: ${sessionKey}` },
      };
    }

    if (!resolvedSrcPath) {
      const normalizedFileName = String(uuidFileName).endsWith('.jsonl')
        ? String(uuidFileName)
        : `${String(uuidFileName)}.jsonl`;
      resolvedSrcPath = join(sessionsDir, normalizedFileName);
    }

    try {
      await access(resolvedSrcPath);
      await rename(resolvedSrcPath, this.deps.resolveDeletedPath(resolvedSrcPath));
    } catch {
      // transcript 文件缺失不阻塞 sessions.json 清理
    }

    const nextJsonRaw = await readFile(sessionsJsonPath, 'utf8');
    const nextJson = JSON.parse(nextJsonRaw);
    if (!isRecord(nextJson)) {
      return {
        status: 500,
        data: { success: false, error: 'Invalid sessions.json payload' },
      };
    }
    if (Array.isArray(nextJson.sessions)) {
      nextJson.sessions = nextJson.sessions.filter((session) => {
        if (!isRecord(session)) {
          return true;
        }
        return session.key !== sessionKey && session.sessionKey !== sessionKey;
      });
    } else if (nextJson[sessionKey]) {
      delete nextJson[sessionKey];
    }

    await writeFile(sessionsJsonPath, JSON.stringify(nextJson, null, 2), 'utf8');
    return {
      status: 200,
      data: { success: true },
    };
  }
}
