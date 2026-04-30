import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionCatalogService } from '../../runtime-host/application/sessions/catalog-service';

function buildTranscriptLine(input: {
  timestamp: string;
  role: 'user' | 'assistant';
  content: string;
  id: string;
}) {
  return JSON.stringify({
    timestamp: input.timestamp,
    message: {
      id: input.id,
      role: input.role,
      content: input.content,
    },
  });
}

describe('session catalog service', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('lists only sessions backed by real transcripts and resolves labels from the transcript content', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-session-catalog-'));
    tempDirs.push(configDir);

    const sessionsDir = join(configDir, 'agents', 'alpha', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:alpha:session-1', id: 'session-1' },
        { key: 'agent:alpha:session-2', id: 'session-2' },
        { key: 'agent:alpha:session-missing', id: 'session-missing' },
      ],
    }, null, 2));

    writeFileSync(join(sessionsDir, 'session-1.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-10T10:00:00.000Z',
        role: 'user',
        content: '第一条问题',
        id: 'message-1',
      }),
      buildTranscriptLine({
        timestamp: '2026-04-10T10:10:00.000Z',
        role: 'user',
        content: '最终标题来自这里',
        id: 'message-2',
      }),
    ].join('\n'));

    writeFileSync(join(sessionsDir, 'session-2.jsonl'), [
      buildTranscriptLine({
        timestamp: '2026-04-11T08:00:00.000Z',
        role: 'assistant',
        content: '没有 user 时用 assistant 兜底',
        id: 'message-3',
      }),
    ].join('\n'));

    const service = new SessionCatalogService({
      getOpenClawConfigDir: () => configDir,
    });

    const response = await service.list();

    expect(response.status).toBe(200);
    expect(response.data).toEqual({
      sessions: [
        {
          key: 'agent:alpha:session-2',
          label: '没有 user 时用 assistant 兜底',
          displayName: 'agent:alpha:session-2',
          updatedAt: Date.parse('2026-04-11T08:00:00.000Z'),
        },
        {
          key: 'agent:alpha:session-1',
          label: '最终标题来自这里',
          displayName: 'agent:alpha:session-1',
          updatedAt: Date.parse('2026-04-10T10:10:00.000Z'),
        },
      ],
    });
  });
});
