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
        entryId: 'run:run-live-1:assistant:0',
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

  it('同一 run 的 chat delta 会持续合并到同一条 assistant timeline entry', () => {
    const configDir = join(tmpdir(), `matcha-session-runtime-${Date.now()}`);
    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-unused' }),
      },
    });

    const [firstEvent] = service.consumeGatewayConversationEvent({
      type: 'chat.message',
      event: {
        state: 'delta',
        runId: 'run-stream-merge',
        sessionKey: 'agent:main:main',
        sequenceId: 4,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '主人，我' }],
        },
      },
    });
    const [secondEvent] = service.consumeGatewayConversationEvent({
      type: 'chat.message',
      event: {
        state: 'delta',
        runId: 'run-stream-merge',
        sessionKey: 'agent:main:main',
        sequenceId: 5,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '主人，我拿不到你当前定位' }],
        },
      },
    });

    expect(firstEvent.entry.entryId).toBe('run:run-stream-merge:assistant:0');
    expect(secondEvent.entry.entryId).toBe('run:run-stream-merge:assistant:0');
    expect(secondEvent.entry.text).toBe('主人，我拿不到你当前定位');
    expect(secondEvent.window.totalEntryCount).toBe(1);
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
        entryId: 'run:run-team-1:agent:worker-a:assistant:0',
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

  it('OpenClaw tool lifecycle 会物化为可渲染的 assistant toolCall timeline entry', () => {
    const [event] = buildSessionUpdateEventsFromGatewayConversationEvent({
      type: 'tool.lifecycle',
      event: {
        runId: 'run-tools-1',
        sessionKey: 'agent:main:main',
        sequenceId: 4,
        timestamp: 1_700_000_000_000,
        phase: 'start',
        toolCallId: 'tool-1',
        name: 'memory_store',
        args: { text: '记住偏好' },
      },
    });

    expect(event).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      entry: {
        entryId: 'run:run-tools-1:tool:tool-1',
        text: '',
        message: {
          content: [{
            type: 'toolCall',
            id: 'tool-1',
            name: 'memory_store',
            input: { text: '记住偏好' },
          }],
          toolStatuses: [{
            toolCallId: 'tool-1',
            name: 'memory_store',
            status: 'running',
          }],
        },
      },
    });
  });

  it('同一个 toolCallId 的 live tool stream 会合并到同一条 timeline entry', () => {
    const configDir = join(tmpdir(), `matcha-session-runtime-${Date.now()}`);
    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-unused' }),
      },
    });

    const [startEvent] = service.consumeGatewayConversationEvent({
      type: 'tool.lifecycle',
      event: {
        runId: 'run-tool-live',
        sessionKey: 'agent:main:main',
        sequenceId: 10,
        timestamp: 1_700_000_000_000,
        phase: 'start',
        toolCallId: 'tool-1',
        name: 'memory_store',
        args: { text: '记住偏好' },
      },
    });
    const [resultEvent] = service.consumeGatewayConversationEvent({
      type: 'tool.lifecycle',
      event: {
        runId: 'run-tool-live',
        sessionKey: 'agent:main:main',
        sequenceId: 11,
        timestamp: 1_700_000_000_001,
        phase: 'result',
        toolCallId: 'tool-1',
        isError: false,
      },
    });

    expect(startEvent.entry.entryId).toBe('run:run-tool-live:tool:tool-1');
    expect(resultEvent.entry.entryId).toBe('run:run-tool-live:tool:tool-1');
    expect(resultEvent.entry.message.content).toMatchObject([{
      type: 'toolCall',
      id: 'tool-1',
      name: 'memory_store',
      input: { text: '记住偏好' },
    }]);
    expect(resultEvent.entry.message.toolStatuses).toMatchObject([{
      toolCallId: 'tool-1',
      name: 'memory_store',
      status: 'completed',
    }]);
    expect(resultEvent.window.totalEntryCount).toBe(1);
  });

  it('同一 run 内 final assistant 会按 OpenClaw sequence 排在 tool activity 后面', async () => {
    const configDir = join(tmpdir(), `matcha-session-runtime-${Date.now()}`);
    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => configDir,
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-unused' }),
      },
    });

    service.consumeGatewayConversationEvent({
      type: 'chat.message',
      event: {
        state: 'delta',
        runId: 'run-order-1',
        sessionKey: 'agent:main:main',
        sequenceId: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '我先看看' }],
        },
      },
    });
    service.consumeGatewayConversationEvent({
      type: 'tool.lifecycle',
      event: {
        runId: 'run-order-1',
        sessionKey: 'agent:main:main',
        sequenceId: 2,
        timestamp: 1_700_000_000_000,
        phase: 'start',
        toolCallId: 'tool-read',
        name: 'read',
        args: { filePath: 'README.md' },
      },
    });
    const [finalEvent] = service.consumeGatewayConversationEvent({
      type: 'chat.message',
      event: {
        state: 'final',
        runId: 'run-order-1',
        sessionKey: 'agent:main:main',
        sequenceId: 3,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '读完了，结论如下' }],
        },
      },
    });

    expect(finalEvent.window.totalEntryCount).toBe(2);
    await expect(service.getSessionStateSnapshot({ sessionKey: 'agent:main:main' })).resolves.toMatchObject({
      data: {
        snapshot: {
          entries: [
            {
              entryId: 'run:run-order-1:tool:tool-read',
            },
            {
              entryId: 'run:run-order-1:assistant:0',
              text: '读完了，结论如下',
            },
          ],
        },
      },
    });
  });

  it('session snapshot 会直接产出 authoritative executionGraphs，前端不再自己拉 child history 拼 graph', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'matcha-session-runtime-'));
    const mainDir = join(rootDir, 'agents', 'main', 'sessions');
    const coderDir = join(rootDir, 'agents', 'coder', 'sessions');
    await mkdir(mainDir, { recursive: true });
    await mkdir(coderDir, { recursive: true });
    await writeFile(
      join(mainDir, 'main.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          id: 'user-1',
          timestamp: '2026-05-03T12:00:00.000Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '请让 coder 去看一下' }],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'completion-1',
          timestamp: '2026-05-03T12:00:01.000Z',
          message: {
            role: 'user',
            content: 'internal completion',
            taskCompletionEvents: [{
              kind: 'task_completion',
              source: 'subagent',
              childSessionKey: 'agent:coder:child-1',
              childSessionId: 'child-1',
              childAgentId: 'coder',
            }],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'assistant-1',
          timestamp: '2026-05-03T12:00:02.000Z',
          message: {
            role: 'assistant',
            agentId: 'coder',
            uniqueId: 'turn-1',
            requestId: 'user-1',
            content: [{ type: 'text', text: 'coder 看完了' }],
          },
        }),
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(mainDir, 'sessions.json'),
      JSON.stringify({
        sessions: [{
          key: 'agent:main:main',
          sessionKey: 'agent:main:main',
          file: 'main.jsonl',
        }],
      }),
      'utf8',
    );
    await writeFile(
      join(coderDir, 'child-1.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          id: 'child-assistant-1',
          timestamp: '2026-05-03T12:00:01.500Z',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: 'tool-1',
              name: 'read_file',
              input: { path: 'README.md' },
            }],
          },
        }),
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(coderDir, 'sessions.json'),
      JSON.stringify({
        sessions: [{
          key: 'agent:coder:child-1',
          sessionKey: 'agent:coder:child-1',
          file: 'child-1.jsonl',
        }],
      }),
      'utf8',
    );

    const service = new SessionRuntimeService({
      getOpenClawConfigDir: () => rootDir,
      openclawBridge: {
        chatSend: async () => ({ runId: 'run-unused' }),
      },
    });

    const loadResponse = await service.loadSession({ sessionKey: 'agent:main:main' });

    expect(loadResponse.status).toBe(200);
    expect(loadResponse.data.snapshot.executionGraphs).toMatchObject([{
      childSessionKey: 'agent:coder:child-1',
      childSessionId: 'child-1',
      childAgentId: 'coder',
      triggerEntryId: 'user-1',
      replyEntryId: 'assistant-1',
      anchorEntryId: 'assistant-1',
      anchorTurnKey: 'member:coder:assistant-1',
      anchorLaneKey: 'member:coder',
      steps: expect.arrayContaining([
        expect.objectContaining({
          label: 'read_file',
          kind: 'tool',
        }),
      ]),
    }]);
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

  it('同一 run 内 assistant toolCall entry 与最终文本 entry 不应因 fallback merge 被压成一条', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'matcha-session-runtime-'));
    const transcriptDir = join(rootDir, 'agents', 'main', 'sessions');
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(transcriptDir, 'main.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          id: 'user-1',
          timestamp: '2026-05-03T12:28:03.784Z',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '记住：我是男的' }],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'assistant-tool-1',
          timestamp: '2026-05-03T12:28:12.787Z',
          message: {
            role: 'assistant',
            content: [{
              type: 'toolCall',
              id: 'tool-1',
              name: 'memory_store',
              arguments: { text: '用户是男性。用户明确要求记住其性别为男。' },
            }],
          },
        }),
        JSON.stringify({
          type: 'message',
          id: 'assistant-final-1',
          timestamp: '2026-05-03T12:28:15.373Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '记住了，主人。你是男的。' }],
          },
        }),
      ].join('\n'),
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
        chatSend: async () => ({ runId: 'run-unused' }),
      },
    });

    const loadResponse = await service.loadSession({ sessionKey: 'agent:main:main' });

    expect(loadResponse.status).toBe(200);
    expect(loadResponse.data.snapshot.entries).toHaveLength(3);
    expect(loadResponse.data.snapshot.entries[1]).toMatchObject({
      role: 'assistant',
      message: {
        content: [{
          type: 'toolCall',
          id: 'tool-1',
          name: 'memory_store',
        }],
      },
    });
    expect(loadResponse.data.snapshot.entries[2]).toMatchObject({
      role: 'assistant',
      text: '记住了，主人。你是男的。',
    });
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
