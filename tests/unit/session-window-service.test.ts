import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenClawTestSessionIdentity, createTestSessionRuntimeService } from './helpers/session-runtime-fixture';

async function resolveHydrationResponse(
  service: ReturnType<typeof createTestSessionRuntimeService>,
  response: Awaited<ReturnType<ReturnType<typeof createTestSessionRuntimeService>['getSessionWindow']>>,
  payload: {
    sessionKey: string;
    sessionIdentity?: ReturnType<typeof createOpenClawTestSessionIdentity>;
    snapshot: Parameters<ReturnType<typeof createTestSessionRuntimeService>['executeSessionHydration']>[0]['snapshot'];
  },
) {
  if (response.status !== 202) {
    return response;
  }
  return {
    status: 200,
    data: await service.executeSessionHydration({
      ...payload,
      sessionIdentity: payload.sessionIdentity ?? createOpenClawTestSessionIdentity(payload.sessionKey),
    }),
  };
}

function readAgentIdFromSessionKey(sessionKey: string): string {
  const [, agentId] = sessionKey.split(':');
  return agentId || 'default';
}

function createSessionIdentity(sessionKey: string) {
  return createOpenClawTestSessionIdentity(sessionKey, readAgentIdFromSessionKey(sessionKey));
}

async function hydrateSessionWindow(
  service: ReturnType<typeof createTestSessionRuntimeService>,
  payload: {
    sessionKey: string;
    mode?: 'latest' | 'older' | 'newer';
    limit?: number;
    offset?: number;
    includeCanonical?: boolean;
  },
) {
  const sessionIdentity = createSessionIdentity(payload.sessionKey);
  return resolveHydrationResponse(service, await service.getSessionWindow({
    ...payload,
    sessionIdentity,
  }), {
    sessionKey: payload.sessionKey,
    sessionIdentity,
    snapshot: {
      kind: 'window',
      mode: payload.mode ?? 'latest',
      limit: payload.limit ?? 80,
      offset: payload.offset ?? null,
    },
  });
}

function buildTranscriptLine(index: number) {
  return JSON.stringify({
    timestamp: `2026-04-0${Math.min(index, 9)}T10:00:00.000Z`,
    message: {
      id: `message-${index}`,
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: `content-${index}`,
    },
  });
}

function buildTranscriptLineFromShape(shape: Record<string, unknown>) {
  return JSON.stringify(shape);
}

describe('session runtime service window', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('returns the latest item window with real offsets and flags', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-window-'));
    tempDirs.push(configDir);
    const sessionsDir = join(configDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:main:session-a', id: 'session-a' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-a.jsonl'), [
      buildTranscriptLine(1),
      buildTranscriptLine(2),
      buildTranscriptLine(3),
      buildTranscriptLine(4),
      buildTranscriptLine(5),
    ].join('\n'));

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });
    const response = await hydrateSessionWindow(service, {
      sessionKey: 'agent:main:session-a',
      mode: 'latest',
      limit: 3,
    });

    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      snapshot: {
        window: {
          totalItemCount: 5,
          windowStartOffset: 2,
          windowEndOffset: 5,
          hasMore: true,
          hasNewer: false,
          isAtLatest: true,
        },
      },
    });
    expect(response.data.snapshot.items.map((item) => item.key)).toEqual([
      'session:agent:main:session-a|user:message:user:main:message-3',
      'session:agent:main:session-a|assistant-turn:main:message:assistant:main:message-4',
      'session:agent:main:session-a|user:message:user:main:message-5',
    ]);
  });

  it('returns older and newer item windows from explicit offsets', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-window-'));
    tempDirs.push(configDir);
    const sessionsDir = join(configDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:main:session-a', id: 'session-a' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-a.jsonl'), [
      buildTranscriptLine(1),
      buildTranscriptLine(2),
      buildTranscriptLine(3),
      buildTranscriptLine(4),
      buildTranscriptLine(5),
      buildTranscriptLine(6),
    ].join('\n'));

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    const older = await hydrateSessionWindow(service, {
      sessionKey: 'agent:main:session-a',
      mode: 'older',
      limit: 2,
      offset: 4,
    });
    expect(older.status).toBe(200);
    expect(older.data).toMatchObject({
      snapshot: {
        window: {
          windowStartOffset: 2,
          windowEndOffset: 6,
          hasMore: true,
          hasNewer: false,
          isAtLatest: true,
        },
      },
    });
    expect(older.data.snapshot.items.map((item) => item.key)).toEqual([
      'session:agent:main:session-a|user:message:user:main:message-3',
      'session:agent:main:session-a|assistant-turn:main:message:assistant:main:message-4',
      'session:agent:main:session-a|user:message:user:main:message-5',
      'session:agent:main:session-a|assistant-turn:main:message:assistant:main:message-6',
    ]);

    const newer = await hydrateSessionWindow(service, {
      sessionKey: 'agent:main:session-a',
      mode: 'newer',
      limit: 2,
      offset: 4,
    });
    expect(newer.status).toBe(200);
    expect(newer.data).toMatchObject({
      snapshot: {
        window: {
          windowStartOffset: 4,
          windowEndOffset: 6,
          hasMore: true,
          hasNewer: false,
          isAtLatest: true,
        },
      },
    });
    expect(newer.data.snapshot.items.map((item) => item.key)).toEqual([
      'session:agent:main:session-a|user:message:user:main:message-5',
      'session:agent:main:session-a|assistant-turn:main:message:assistant:main:message-6',
    ]);
  });

  it('can include the canonical transcript alongside the viewport window', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-window-'));
    tempDirs.push(configDir);
    const sessionsDir = join(configDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:main:session-a', id: 'session-a' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-a.jsonl'), [
      buildTranscriptLine(1),
      buildTranscriptLine(2),
      buildTranscriptLine(3),
      buildTranscriptLine(4),
    ].join('\n'));

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });
    const response = await hydrateSessionWindow(service, {
      sessionKey: 'agent:main:session-a',
      mode: 'latest',
      limit: 2,
      includeCanonical: true,
    });

    expect(response.status).toBe(200);
    expect(response.data.snapshot.items.map((item) => item.key)).toEqual([
      'session:agent:main:session-a|user:message:user:main:message-3',
      'session:agent:main:session-a|assistant-turn:main:message:assistant:main:message-4',
    ]);
  });

  it('preserves user render-item identity needed for optimistic reconciliation', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-window-'));
    tempDirs.push(configDir);
    const sessionsDir = join(configDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:main:session-a', id: 'session-a' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-a.jsonl'), [
      buildTranscriptLineFromShape({
        id: 'transcript-user-1',
        timestamp: '2026-04-01T10:00:00.000Z',
        message: {
          role: 'user',
          content: 'hello world',
          origin_message_id: 'origin-user-1',
          agent_id: 'agent-main',
          idempotencyKey: 'client-user-1',
        },
      }),
    ].join('\n'));

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });
    const response = await hydrateSessionWindow(service, {
      sessionKey: 'agent:main:session-a',
      mode: 'latest',
      limit: 20,
      includeCanonical: true,
    });

    expect(response.status).toBe(200);
    expect(response.data.snapshot.items).toMatchObject([
      {
        kind: 'user-message',
        key: 'session:agent:main:session-a|user:message:user:member:agent-main:transcript-user-1',
        text: 'hello world',
      },
    ]);
  });

  it('returns a snapshot directly for an already hydrated session window request', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-window-'));
    tempDirs.push(configDir);
    const sessionsDir = join(configDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:main:session-a', id: 'session-a' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-a.jsonl'), [
      buildTranscriptLine(1),
      buildTranscriptLine(2),
      buildTranscriptLine(3),
    ].join('\n'));

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    const initial = await hydrateSessionWindow(service, {
      sessionKey: 'agent:main:session-a',
      mode: 'latest',
      limit: 2,
    });
    expect(initial.status).toBe(200);

    const second = await service.getSessionWindow({
      sessionKey: 'agent:main:session-a',
      sessionIdentity: createSessionIdentity('agent:main:session-a'),
      mode: 'latest',
      limit: 2,
    });

    expect(second.status).toBe(200);
    expect(second.data).not.toHaveProperty('hydrationJob');
    expect(second.data).toMatchObject({
      snapshot: {
        window: {
          totalItemCount: 3,
          windowStartOffset: 1,
          windowEndOffset: 3,
        },
      },
    });
  });

  it('rejects older/newer requests without offset', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-window-'));
    tempDirs.push(configDir);
    const sessionsDir = join(configDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:main:session-a', id: 'session-a' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-a.jsonl'), buildTranscriptLine(1));

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });
    const response = await service.getSessionWindow({
      sessionKey: 'agent:main:session-a',
      sessionIdentity: createSessionIdentity('agent:main:session-a'),
      mode: 'older',
      limit: 2,
    });

    expect(response.status).toBe(400);
    expect(response.data).toMatchObject({
      success: false,
    });
  });

  it('resume keeps the current window while switch resets to latest', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-window-'));
    tempDirs.push(configDir);
    const sessionsDir = join(configDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:main:session-a', id: 'session-a' },
      ],
    }, null, 2));
    writeFileSync(join(sessionsDir, 'session-a.jsonl'), [
      buildTranscriptLine(1),
      buildTranscriptLine(2),
      buildTranscriptLine(3),
      buildTranscriptLine(4),
      buildTranscriptLine(5),
    ].join('\n'));

    const service = createTestSessionRuntimeService({
      workspace: { getConfigDir: () => configDir },
      openclawBridge: {
        chatSend: async () => ({}),
        gatewayRpc: async () => ({}),
      },
    });

    const older = await hydrateSessionWindow(service, {
      sessionKey: 'agent:main:session-a',
      mode: 'older',
      limit: 2,
      offset: 4,
    });
    expect(older.status).toBe(200);

    const sessionIdentity = createSessionIdentity('agent:main:session-a');
    const resumed = await resolveHydrationResponse(service, await service.resumeSession({
      sessionKey: 'agent:main:session-a',
      sessionIdentity,
    }), {
      sessionKey: 'agent:main:session-a',
      sessionIdentity,
      snapshot: { kind: 'state' },
    });
    expect(resumed.status).toBe(200);
    expect(resumed.data).toMatchObject({
      snapshot: {
        window: {
          windowStartOffset: 2,
          windowEndOffset: 5,
        },
      },
    });

    const switched = await resolveHydrationResponse(service, await service.switchSession({
      sessionKey: 'agent:main:session-a',
      sessionIdentity,
    }), {
      sessionKey: 'agent:main:session-a',
      sessionIdentity,
      snapshot: { kind: 'window', mode: 'latest', limit: 80, offset: null },
    });
    expect(switched.status).toBe(200);
    expect(switched.data).toMatchObject({
      snapshot: {
        window: {
          windowStartOffset: 0,
          windowEndOffset: 5,
        },
      },
    });
  });
});
