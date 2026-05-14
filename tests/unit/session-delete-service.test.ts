import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestSessionRuntimeService } from './helpers/session-runtime-fixture';

describe('session adapter service status management', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('deletes the session transcript and removes it from the adapter index', async () => {
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

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    const response = await service.deleteSession({
      sessionKey: 'agent:alpha:session-a',
    });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ success: true });
    expect(existsSync(join(sessionsDir, 'session-a.jsonl'))).toBe(false);
    expect(existsSync(join(sessionsDir, 'session-a.deleted.jsonl'))).toBe(true);
    expect(JSON.parse(readFileSync(join(sessionsDir, 'sessions.json'), 'utf8'))).toEqual({
      sessions: [
        { key: 'agent:alpha:session-b', id: 'session-b' },
      ],
    });
  });

  it('archives and unarchives native object-map session indexes', async () => {
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

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    const archived = await service.archiveSession({
      sessionKey: 'agent:alpha:main',
    });
    expect(archived.status).toBe(200);
    expect(JSON.parse(readFileSync(join(sessionsDir, 'sessions.json'), 'utf8'))['agent:alpha:main']).toMatchObject({
      sessionId: 'session-main',
      status: 'archived',
    });

    const unarchived = await service.unarchiveSession({
      sessionKey: 'agent:alpha:main',
    });
    expect(unarchived.status).toBe(200);
    expect(existsSync(join(sessionsDir, 'session-main.jsonl'))).toBe(true);
    expect(JSON.parse(readFileSync(join(sessionsDir, 'sessions.json'), 'utf8'))['agent:alpha:main']).toMatchObject({
      sessionId: 'session-main',
      sessionFile: join(sessionsDir, 'session-main.jsonl'),
      status: 'completed',
    });
  });

  it('hides archived and deleted sessions from the ordinary session list', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-delete-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:session-active', id: 'session-active', status: 'completed' },
        { key: 'agent:alpha:session-archived', id: 'session-archived', status: 'archived' },
        { key: 'agent:alpha:session-deleted', id: 'session-deleted', status: 'deleted' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-active.jsonl'), '{"message":{"role":"user","content":"active","timestamp":1}}\n', 'utf8');
    writeFileSync(join(sessionsDir, 'session-archived.jsonl'), '{"message":{"role":"user","content":"archived","timestamp":1}}\n', 'utf8');
    writeFileSync(join(sessionsDir, 'session-deleted.jsonl'), '{"message":{"role":"user","content":"deleted","timestamp":1}}\n', 'utf8');

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    await service.refreshSessionCatalog();
    const response = await service.listSessions();

    expect(response.status).toBe(200);
    expect(response.data.sessions.map((session) => session.key)).toEqual(['agent:alpha:session-active']);
  });
});
