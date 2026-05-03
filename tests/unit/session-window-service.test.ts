import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionRuntimeService } from '../../runtime-host/application/session-runtime/service';

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

  it('returns the latest window with real offsets and flags', async () => {
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

    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({}),
      },
    });
    const response = await service.getSessionWindow({
      sessionKey: 'agent:main:session-a',
      mode: 'latest',
      limit: 3,
    });

    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      snapshot: {
        window: {
          totalEntryCount: 5,
          windowStartOffset: 2,
          windowEndOffset: 5,
          hasMore: true,
          hasNewer: false,
          isAtLatest: true,
        },
      },
    });
    expect((response.data as { snapshot: { entries: Array<{ message: { id: string } }> } }).snapshot.entries.map((entry) => entry.message.id)).toEqual([
      'message-3',
      'message-4',
      'message-5',
    ]);
  });

  it('returns older and newer windows from explicit offsets', async () => {
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

    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({}),
      },
    });

    const older = await service.getSessionWindow({
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
    expect((older.data as { snapshot: { entries: Array<{ message: { id: string } }> } }).snapshot.entries.map((entry) => entry.message.id)).toEqual([
      'message-3',
      'message-4',
      'message-5',
      'message-6',
    ]);

    const newer = await service.getSessionWindow({
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
    expect((newer.data as { snapshot: { entries: Array<{ message: { id: string } }> } }).snapshot.entries.map((entry) => entry.message.id)).toEqual([
      'message-5',
      'message-6',
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

    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({}),
      },
    });
    const response = await service.getSessionWindow({
      sessionKey: 'agent:main:session-a',
      mode: 'latest',
      limit: 2,
      includeCanonical: true,
    });

    expect(response.status).toBe(200);
    expect((response.data as {
      snapshot: { entries: Array<{ message: { id: string } }> };
    }).snapshot.entries.map((entry) => entry.message.id)).toEqual(['message-3', 'message-4']);
  });

  it('preserves transcript identity fields needed to reconcile optimistic user messages', async () => {
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

    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({}),
      },
    });
    const response = await service.getSessionWindow({
      sessionKey: 'agent:main:session-a',
      mode: 'latest',
      limit: 20,
      includeCanonical: true,
    });

    expect(response.status).toBe(200);
    expect((response.data as {
      snapshot: { entries: Array<{
        laneKey?: string;
        turnKey?: string;
        message: {
          id?: string;
          messageId?: string;
          originMessageId?: string;
          clientId?: string;
          uniqueId?: string;
          requestId?: string;
          agentId?: string;
        };
      }> };
    }).snapshot.entries).toMatchObject([
      {
        laneKey: 'member:agent-main',
        turnKey: 'member:agent-main:transcript-user-1',
        message: {
          role: 'user',
          content: 'hello world',
          timestamp: Date.parse('2026-04-01T10:00:00.000Z'),
          id: 'transcript-user-1',
          messageId: 'transcript-user-1',
          originMessageId: 'origin-user-1',
          clientId: 'client-user-1',
          uniqueId: 'transcript-user-1',
          requestId: 'client-user-1',
          agentId: 'agent-main',
        },
      },
    ]);
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

    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({}),
      },
    });
    const response = await service.getSessionWindow({
      sessionKey: 'agent:main:session-a',
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

    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({}),
      },
    });

    const older = await service.getSessionWindow({
      sessionKey: 'agent:main:session-a',
      mode: 'older',
      limit: 2,
      offset: 4,
    });
    expect(older.status).toBe(200);

    const resumed = await service.resumeSession({
      sessionKey: 'agent:main:session-a',
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

    const switched = await service.switchSession({
      sessionKey: 'agent:main:session-a',
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
