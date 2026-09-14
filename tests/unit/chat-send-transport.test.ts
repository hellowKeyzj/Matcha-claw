import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionView } from './helpers/session-fixtures';

const hostSessionPromptMock = vi.fn();
const sessionIdentity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'default',
  sessionKey: 'agent:main:main',
};

vi.mock('@/lib/host-api', () => ({
  hostSessionPrompt: (...args: unknown[]) => hostSessionPromptMock(...args),
}));

describe('chat send transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('纯文本发送使用 hostSessionPrompt 并返回 canonical projection', async () => {
    const view = sessionView(sessionIdentity.sessionKey, { identity: sessionIdentity });
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: sessionIdentity.sessionKey,
      runId: '  run-1  ',
      item: null,
      snapshot: view,
    });

    const { sendChatTransport } = await import('@/stores/chat/send-transport');
    const result = await sendChatTransport({
      sessionKey: sessionIdentity.sessionKey,
      sessionIdentity,
      message: 'hello',
      idempotencyKey: 'user-local-1',
    });

    expect(hostSessionPromptMock).toHaveBeenCalledWith({
      sessionIdentity,
      message: 'hello',
      idempotencyKey: 'user-local-1',
      deliver: false,
    });
    expect(result).toEqual({ ok: true, runId: 'run-1', projection: { kind: 'view', view } });
  });

  it('does not add the caller timeout to the hostSessionPrompt payload', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: sessionIdentity.sessionKey,
      runId: 'user-local-deadline',
      item: null,
      projection: null,
    });

    const { sendChatTransport } = await import('@/stores/chat/send-transport');
    await sendChatTransport({
      sessionKey: sessionIdentity.sessionKey,
      sessionIdentity,
      message: 'hello',
      idempotencyKey: 'user-local-deadline',
      timeoutMs: 120_000,
    });

    expect(hostSessionPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'user-local-deadline',
      deliver: false,
    }));
    expect(hostSessionPromptMock.mock.calls[0]?.[0]).not.toHaveProperty('timeoutMs');
  });

  it('通用附件发送只将 staged attachment 引用交给 hostSessionPrompt', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: sessionIdentity.sessionKey,
      runId: 'user-local-2',
      item: null,
      projection: null,
    });

    const { sendChatTransport } = await import('@/stores/chat/send-transport');
    await expect(sendChatTransport({
      sessionKey: sessionIdentity.sessionKey,
      sessionIdentity,
      message: 'hello',
      idempotencyKey: 'user-local-2',
      attachments: [{
        fileName: 'a.png',
        mimeType: 'image/png',
        fileSize: 1,
        stagedAttachmentId: 'attachment-a',
        preview: 'data:image/png;base64,AA==',
        sourcePath: 'D:\\docs\\a.png',
      }],
    })).resolves.toEqual({ ok: true, runId: 'user-local-2', projection: null });

    expect(hostSessionPromptMock).toHaveBeenCalledWith({
      sessionIdentity,
      message: 'hello',
      idempotencyKey: 'user-local-2',
      deliver: false,
      attachments: [{
        stagedAttachmentId: 'attachment-a',
        mimeType: 'image/png',
        fileName: 'a.png',
        fileSize: 1,
      }],
    });
    expect(JSON.stringify(hostSessionPromptMock.mock.calls)).not.toContain('base64');
    expect(JSON.stringify(hostSessionPromptMock.mock.calls)).not.toContain('D:\\\\docs');
  });

  it('maps prompt rejection errors to the transport failure result', async () => {
    const { sendChatTransport } = await import('@/stores/chat/send-transport');
    hostSessionPromptMock.mockResolvedValueOnce({
      success: false,
      sessionKey: sessionIdentity.sessionKey,
      runId: null,
      item: null,
      projection: null,
      error: 'Target rejected the prompt',
    });

    await expect(sendChatTransport({
      sessionKey: sessionIdentity.sessionKey,
      sessionIdentity,
      message: 'hello',
      idempotencyKey: 'user-local-rejected',
    })).resolves.toEqual({ ok: false, error: 'Target rejected the prompt' });

    hostSessionPromptMock.mockResolvedValueOnce({
      success: false,
      sessionKey: sessionIdentity.sessionKey,
      runId: null,
      item: null,
      projection: null,
    });

    await expect(sendChatTransport({
      sessionKey: sessionIdentity.sessionKey,
      sessionIdentity,
      message: 'hello',
      idempotencyKey: 'user-local-unknown',
    })).resolves.toEqual({ ok: false, error: 'Failed to send message' });
  });

  it('rejects accepted-looking responses without a native run id', async () => {
    const { sendChatTransport } = await import('@/stores/chat/send-transport');
    for (const response of [
      { success: true, runId: null },
      { outcome: 'queued', runId: '   ' },
      { outcome: 'succeeded' },
    ]) {
      hostSessionPromptMock.mockResolvedValueOnce(response);
      await expect(sendChatTransport({
        sessionKey: sessionIdentity.sessionKey,
        sessionIdentity,
        message: 'hello',
        idempotencyKey: 'user-local-no-native-run',
      })).resolves.toEqual({ ok: false, error: 'Failed to send message' });
    }
  });
});
