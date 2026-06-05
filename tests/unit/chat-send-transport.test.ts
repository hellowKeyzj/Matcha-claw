import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostSessionPromptMock = vi.fn();
const runtimeAddress = {
  kind: 'native-runtime' as const,
  capabilityId: 'session.prompt',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  agentId: 'default',
  sessionKey: 'agent:main:main',
};

vi.mock('@/lib/host-api', () => ({
  hostSessionPrompt: (...args: unknown[]) => hostSessionPromptMock(...args),
}));

function buildPromptSnapshot(entryId: string, content: string) {
  return {
    sessionKey: 'agent:main:main',
    replayComplete: true,
    items: [
      {
        key: `session:agent:main:main|entry:${entryId}`,
        kind: 'user-message',
        sessionKey: 'agent:main:main',
        role: 'user',
        text: content,
        createdAt: 1,
        updatedAt: 1,
        images: [],
        attachedFiles: [],
        messageId: entryId,
      },
    ],
    runtime: {
      activeRunId: 'run-1',
      runPhase: 'submitted',
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      lastUserMessageAt: 1,
      lastError: null,
      updatedAt: 1,
    },
    window: {
      totalItemCount: 1,
      windowStartOffset: 0,
      windowEndOffset: 1,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    },
  };
}

describe('chat send transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('纯文本发送会走 session.prompt translator，并返回 authoritative snapshot', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      snapshot: buildPromptSnapshot('user-local-1', 'hello'),
    });

    const { sendChatTransport } = await import('@/stores/chat/send-transport');
    const result = await sendChatTransport({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      message: 'hello',
      idempotencyKey: 'user-local-1',
    });

    expect(hostSessionPromptMock).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      message: 'hello',
      idempotencyKey: 'user-local-1',
      deliver: false,
    });
    expect(result).toMatchObject({
      ok: true,
      runId: 'run-1',
      snapshot: expect.objectContaining({
        sessionKey: 'agent:main:main',
      }),
    });
  });

  it('带附件发送也统一走 session.prompt translator，并透传本地附件元数据给 runtime-host', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      runId: 'run-2',
      sessionKey: 'agent:main:main',
      snapshot: buildPromptSnapshot('user-local-2', 'hello'),
    });

    const { sendChatTransport } = await import('@/stores/chat/send-transport');
    await sendChatTransport({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      message: 'hello',
      idempotencyKey: 'user-local-2',
      attachments: [{
        fileName: 'a.png',
        mimeType: 'image/png',
        fileSize: 1,
        stagedPath: 'C:\\a.png',
        preview: 'data:image/png;base64,AA==',
      }],
    });

    expect(hostSessionPromptMock).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      message: 'hello',
      idempotencyKey: 'user-local-2',
      deliver: false,
      media: [{
        filePath: 'C:\\a.png',
        mimeType: 'image/png',
        fileName: 'a.png',
        fileSize: 1,
        preview: 'data:image/png;base64,AA==',
      }],
    });
  });

  it('发送失败时应保留后端原始错误文案', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: false,
      error: 'model unavailable: quota exceeded',
    });

    const { sendChatTransport } = await import('@/stores/chat/send-transport');
    const result = await sendChatTransport({
      sessionKey: 'agent:main:main',
      runtimeAddress,
      message: 'hello',
      idempotencyKey: 'user-local-3',
    });

    expect(result).toEqual({
      ok: false,
      error: 'model unavailable: quota exceeded',
    });
  });
});
