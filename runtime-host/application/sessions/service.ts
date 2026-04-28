import { access, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionFileResolver } from './session-file-resolver';

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

    const fileResolver = new SessionFileResolver({
      getOpenClawConfigDir: this.deps.getOpenClawConfigDir,
    });
    const resolution = await fileResolver.resolve(sessionKey);
    if (!resolution) {
      return {
        status: 404,
        data: { success: false, error: `Cannot resolve file for session: ${sessionKey}` },
      };
    }

    const { sessionsDir, transcriptPath: resolvedSrcPath } = resolution;
    const sessionsJsonPath = join(sessionsDir, 'sessions.json');
    const sessionsJson = JSON.parse(await readFile(sessionsJsonPath, 'utf8'));

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
