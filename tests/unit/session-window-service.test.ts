import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionWindowService } from '../../runtime-host/application/sessions/window-service';

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

describe('session window service', () => {
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

    const service = new SessionWindowService({
      getOpenClawConfigDir: () => configDir,
    });
    const response = await service.getWindow({
      sessionKey: 'agent:main:session-a',
      mode: 'latest',
      limit: 3,
    });

    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      totalMessageCount: 5,
      windowStartOffset: 2,
      windowEndOffset: 5,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    expect((response.data as { messages: Array<{ id: string }> }).messages.map((message) => message.id)).toEqual([
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

    const service = new SessionWindowService({
      getOpenClawConfigDir: () => configDir,
    });

    const older = await service.getWindow({
      sessionKey: 'agent:main:session-a',
      mode: 'older',
      limit: 2,
      offset: 4,
    });
    expect(older.status).toBe(200);
    expect(older.data).toMatchObject({
      windowStartOffset: 2,
      windowEndOffset: 4,
      hasMore: true,
      hasNewer: true,
      isAtLatest: false,
    });
    expect((older.data as { messages: Array<{ id: string }> }).messages.map((message) => message.id)).toEqual([
      'message-3',
      'message-4',
    ]);

    const newer = await service.getWindow({
      sessionKey: 'agent:main:session-a',
      mode: 'newer',
      limit: 2,
      offset: 4,
    });
    expect(newer.status).toBe(200);
    expect(newer.data).toMatchObject({
      windowStartOffset: 4,
      windowEndOffset: 6,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    expect((newer.data as { messages: Array<{ id: string }> }).messages.map((message) => message.id)).toEqual([
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

    const service = new SessionWindowService({
      getOpenClawConfigDir: () => configDir,
    });
    const response = await service.getWindow({
      sessionKey: 'agent:main:session-a',
      mode: 'latest',
      limit: 2,
      includeCanonical: true,
    });

    expect(response.status).toBe(200);
    expect((response.data as {
      messages: Array<{ id: string }>;
      canonicalMessages?: Array<{ id: string }>;
    }).messages.map((message) => message.id)).toEqual(['message-3', 'message-4']);
    expect((response.data as {
      canonicalMessages?: Array<{ id: string }>;
    }).canonicalMessages?.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'message-4',
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

    const service = new SessionWindowService({
      getOpenClawConfigDir: () => configDir,
    });
    const response = await service.getWindow({
      sessionKey: 'agent:main:session-a',
      mode: 'older',
      limit: 2,
    });

    expect(response.status).toBe(400);
    expect(response.data).toMatchObject({
      success: false,
    });
  });
});
