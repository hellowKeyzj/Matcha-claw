import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionRuntimeService, buildSessionUpdateEventsFromGatewayConversationEvent } from '../../runtime-host/application/session-runtime/service';

async function createRuntimeConfigDir() {
  return await mkdtemp(join(tmpdir(), 'matcha-session-runtime-'));
}

describe('session runtime service', () => {
  it('createSession 会把全新空会话作为已完成初始快照返回，避免前端误判为历史加载中', async () => {
    const configDir = await createRuntimeConfigDir();
    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-unused' }),
      },
    });

    const response = await service.createSession({
      agentId: 'worker-a',
    });

    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({
      success: true,
      sessionKey: expect.stringMatching(/^agent:worker-a:session-/),
      snapshot: {
        replayComplete: true,
        entries: [],
        runtime: {
          sending: false,
          activeRunId: null,
          runPhase: 'idle',
          pendingFinal: false,
        },
        window: {
          totalEntryCount: 0,
          windowStartOffset: 0,
          windowEndOffset: 0,
          hasMore: false,
          hasNewer: false,
          isAtLatest: true,
        },
      },
    });
  });

  it('live agent_message_chunk 在缺少 message id 时，仍会生成稳定的 run/sequence timeline identity', () => {
    const [event] = buildSessionUpdateEventsFromGatewayConversationEvent({
      type: 'chat.message',
      event: {
        state: 'delta',
        runId: 'run-live-1',
        sessionKey: 'agent:main:main',
        sequenceId: 2,
        message: {
          role: 'assistant',
          content: 'hello',
        },
      },
    });

    expect(event).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      runId: 'run-live-1',
      sessionKey: 'agent:main:main',
      laneKey: 'main',
      entry: {
        entryId: 'run:run-live-1:seq:2',
        turnKey: 'main:run-live-1',
        laneKey: 'main',
        status: 'streaming',
        sequenceId: 2,
        text: 'hello',
        message: {
          role: 'assistant',
          content: 'hello',
        },
      },
    });
  });

  it('team lane live 事件会带上 member laneKey，并把 runId 作为 turn fallback', () => {
    const [event] = buildSessionUpdateEventsFromGatewayConversationEvent({
      type: 'chat.message',
      event: {
        state: 'final',
        runId: 'run-team-1',
        sessionKey: 'agent:main:main',
        sequenceId: 3,
        agentId: 'worker-a',
        message: {
          role: 'assistant',
          agentId: 'worker-a',
          content: 'done',
        },
      },
    });

    expect(event).toMatchObject({
      sessionUpdate: 'agent_message',
      laneKey: 'member:worker-a',
      entry: {
        entryId: 'run:run-team-1:seq:3',
        laneKey: 'member:worker-a',
        turnKey: 'member:worker-a:run-team-1',
        agentId: 'worker-a',
        status: 'final',
      },
      _meta: {
        'codebuddy.ai/memberEvent': 'worker-a',
      },
    });
  });

  it('promptSession 会返回并缓存 authoritative user entry，后续 load/window 直接读同一份 timeline', async () => {
    const configDir = await createRuntimeConfigDir();
    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-prompt-1' }),
      },
    });

    const promptResponse = await service.promptSession({
      sessionKey: 'agent:main:main',
      message: 'hello authoritative',
      idempotencyKey: 'user-local-1',
      media: [{
        filePath: 'C:\\a.png',
        mimeType: 'image/png',
        fileName: 'a.png',
        fileSize: 1,
        preview: 'data:image/png;base64,AA==',
      }],
    });

    expect(promptResponse.status).toBe(200);
    expect(promptResponse.data).toMatchObject({
      success: true,
      sessionKey: 'agent:main:main',
      runId: 'run-prompt-1',
      promptId: 'user-local-1',
      entry: {
        entryId: 'user-local-1',
        sessionKey: 'agent:main:main',
        laneKey: 'main',
        turnKey: 'main:user-local-1',
        role: 'user',
        text: 'hello authoritative',
        message: {
          id: 'user-local-1',
        },
      },
    });

    const loadResponse = await service.loadSession({ sessionKey: 'agent:main:main' });
    expect(loadResponse.status).toBe(200);
    expect(loadResponse.data).toMatchObject({
      snapshot: {
        sessionKey: 'agent:main:main',
        entries: [{
          entryId: 'user-local-1',
        }],
        window: {
          totalEntryCount: 1,
        },
      },
    });

    const windowResponse = await service.getSessionWindow({
      sessionKey: 'agent:main:main',
      mode: 'latest',
      limit: 20,
      includeCanonical: true,
    });
    expect(windowResponse.status).toBe(200);
    expect(windowResponse.data).toMatchObject({
      snapshot: {
        entries: [{
          entryId: 'user-local-1',
          message: {
            _attachedFiles: [{
              fileName: 'a.png',
              fileSize: 1,
            }],
          },
        }],
        window: {
          totalEntryCount: 1,
        },
      },
    });
  });

  it('canonical transcript 还没追平时，loadSession 仍会保留 live assistant final', async () => {
    const configDir = await createRuntimeConfigDir();
    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-unused' }),
      },
    });

    const [sessionUpdate] = service.consumeGatewayConversationEvent({
      type: 'chat.message',
      event: {
        state: 'final',
        runId: 'run-final-1',
        sessionKey: 'agent:main:main',
        sequenceId: 1,
        message: {
          role: 'assistant',
          content: 'authoritative final',
        },
      },
    });

    expect(sessionUpdate).toMatchObject({
      sessionUpdate: 'agent_message',
      entry: {
        role: 'assistant',
        text: 'authoritative final',
      },
    });

    const loadResponse = await service.loadSession({ sessionKey: 'agent:main:main' });
    expect(loadResponse.status).toBe(200);
    expect(loadResponse.data).toMatchObject({
      snapshot: {
        entries: [{
          role: 'assistant',
          text: 'authoritative final',
          message: {
            role: 'assistant',
            content: 'authoritative final',
          },
        }],
      },
    });
    expect(loadResponse.data.snapshot.entries).toHaveLength(1);
  });

  it('promptSession 进入 runtime 后，后续 loadSession 不再用 canonical user 文本语义回写覆盖本地 authoritative entry', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'matcha-session-runtime-'));
    const transcriptDir = join(rootDir, 'agents', 'main', 'sessions');
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, 'main.jsonl'),
      `${JSON.stringify({
        role: 'user',
        content: '[Sat 2026-05-02 22:26 GMT+8] hello authoritative',
        timestamp: 1,
        id: 'canonical-user-1',
      })}\n`,
      'utf8',
    );
    await writeFile(
      join(transcriptDir, 'sessions.json'),
      JSON.stringify({
        sessions: [{
          key: 'agent:main:main',
          sessionKey: 'agent:main:main',
          file: 'main.jsonl',
        }],
      }),
      'utf8',
    );

    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => rootDir,
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-prompt-2' }),
      },
    });

    const promptResponse = await service.promptSession({
      sessionKey: 'agent:main:main',
      message: 'hello authoritative',
      idempotencyKey: 'user-local-1',
    });
    expect(promptResponse.status).toBe(200);

    const loadResponse = await service.loadSession({ sessionKey: 'agent:main:main' });
    expect(loadResponse.status).toBe(200);
    expect(loadResponse.data).toMatchObject({
      snapshot: {
        entries: [{
          entryId: 'user-local-1',
          message: {
            id: 'user-local-1',
            content: 'hello authoritative',
          },
        }],
      },
    });
  });

  it('runtime store v2 only persists minimal live runtime metadata, not historical entries/window snapshots', async () => {
    const configDir = await createRuntimeConfigDir();
    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-prompt-3' }),
      },
    });

    await service.promptSession({
      sessionKey: 'agent:main:main',
      message: 'hello runtime store',
      idempotencyKey: 'user-local-3',
    });

    const persisted = JSON.parse(
      await readFile(join(configDir, 'matchaclaw-session-runtime-store.json'), 'utf8'),
    ) as {
      version: number;
      activeSessionKey: string | null;
      liveSessions: Array<Record<string, unknown>>;
    };

    expect(persisted).toMatchObject({
      version: 2,
      activeSessionKey: 'agent:main:main',
      liveSessions: [
        {
          sessionKey: 'agent:main:main',
          runtime: {
            sending: true,
            activeRunId: 'run-prompt-3',
            runPhase: 'submitted',
          },
        },
      ],
    });
    expect(persisted.liveSessions[0]).not.toHaveProperty('entries');
    expect(persisted.liveSessions[0]).not.toHaveProperty('window');
  });
});
