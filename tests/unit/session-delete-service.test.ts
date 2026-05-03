import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionRuntimeService } from '../../runtime-host/application/session-runtime/service';

describe('session adapter service delete', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('deletes the transcript and prunes the session index through the adapter service', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-delete-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:session-a', id: 'session-a' },
        { key: 'agent:alpha:session-b', id: 'session-b' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-a.jsonl'), '{"hello":"world"}\n', 'utf8');

    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      resolveDeletedPath: (path) => path.replace(/\.jsonl$/, '.deleted.jsonl'),
      openclawBridge: {
        chatSend: async () => ({}),
      },
    });

    const response = await service.deleteSession({
      sessionKey: 'agent:alpha:session-a',
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ success: true });
    expect(existsSync(join(sessionsDir, 'session-a.deleted.jsonl'))).toBe(true);
    expect(JSON.parse(readFileSync(join(sessionsDir, 'sessions.json'), 'utf8'))).toEqual({
      sessions: [
        { key: 'agent:alpha:session-b', id: 'session-b' },
      ],
    });
  });

  it('deletes the transcript and prunes native object-map session indexes', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-delete-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      'agent:alpha:main': {
        sessionId: 'session-main',
        sessionFile: join(sessionsDir, 'session-main.jsonl'),
      },
      'agent:alpha:session-b': {
        sessionId: 'session-b',
        sessionFile: join(sessionsDir, 'session-b.jsonl'),
      },
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-main.jsonl'), '{"hello":"world"}\n', 'utf8');

    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      resolveDeletedPath: (path) => path.replace(/\.jsonl$/, '.deleted.jsonl'),
      openclawBridge: {
        chatSend: async () => ({}),
      },
    });

    const response = await service.deleteSession({
      sessionKey: 'agent:alpha:main',
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ success: true });
    expect(existsSync(join(sessionsDir, 'session-main.deleted.jsonl'))).toBe(true);
    expect(JSON.parse(readFileSync(join(sessionsDir, 'sessions.json'), 'utf8'))).toEqual({
      'agent:alpha:session-b': {
        sessionId: 'session-b',
        sessionFile: join(sessionsDir, 'session-b.jsonl'),
      },
    });
  });
});
