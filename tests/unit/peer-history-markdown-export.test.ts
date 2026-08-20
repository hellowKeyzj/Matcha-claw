import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({ hostApiFetch: hostApiFetchMock }));

import {
  buildPeerTextHistoryMarkdown,
  exportPeerTextHistoryMarkdown,
} from '@/pages/Chat/peer-history-markdown-export';

describe('peer text history markdown export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serializes only OpenClaw role/text messages', () => {
    const result = buildPeerTextHistoryMarkdown({
      title: 'Session',
      sessionKey: 'agent:main:demo',
      exportedAt: new Date('2026-07-28T12:34:56.000Z'),
      messages: [
        { role: 'user', text: 'Question' },
        { role: 'assistant', text: 'Answer' },
      ],
    });

    expect(result.fileName).toBe('Session-2026-07-28-12-34-56.md');
    expect(result.markdown).toContain('- Messages: 2');
    expect(result.markdown).toContain('## User\n\nQuestion');
    expect(result.markdown).toContain('## Assistant\n\nAnswer');
    expect(result.markdown).not.toContain('Tool:');
  });

  it('requests OpenClaw history through the dedicated text endpoint only', async () => {
    hostApiFetchMock.mockResolvedValue({
      messages: [{ role: 'assistant', text: 'Answer' }],
    });
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => 'blob:peer-history');
    const revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

    try {
      await exportPeerTextHistoryMarkdown({
        runtimeAdapterId: 'openclaw',
        sessionKey: 'agent:main:demo',
        title: 'Session',
        exportedAt: new Date('2026-07-28T12:34:56.000Z'),
      });

      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/openclaw/chat/history', {
        method: 'POST',
        body: JSON.stringify({
          id: 'openclaw.chat.history',
          operationId: 'openclaw.chat.history',
          sessionKey: 'agent:main:demo',
        }),
      });
      await expect((createObjectURL.mock.calls[0]?.[0] as Blob).text()).resolves.toContain('## Assistant\n\nAnswer');
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:peer-history');
    } finally {
      clickSpy.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', { value: originalCreateObjectURL, configurable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: originalRevokeObjectURL, configurable: true });
    }
  });

  it('rejects non-text OpenClaw response fields without downloading', async () => {
    hostApiFetchMock.mockResolvedValue({
      messages: [{ role: 'assistant', text: 'Answer', tool: 'private' }],
    });

    await expect(exportPeerTextHistoryMarkdown({
      runtimeAdapterId: 'openclaw',
      sessionKey: 'agent:main:demo',
      title: 'Session',
      exportedAt: new Date('2026-07-28T12:34:56.000Z'),
    })).rejects.toThrow('OpenClaw chat history is unavailable');

  });

  it('exports Matcha Agent native text history through its independent endpoint', async () => {
    hostApiFetchMock.mockResolvedValue({
      messages: [{ role: 'assistant', text: 'Native answer' }],
    });
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => 'blob:matcha-peer-history');
    const revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

    try {
      await exportPeerTextHistoryMarkdown({
        runtimeAdapterId: 'matcha-agent',
        sessionKey: 'matcha-session-1',
        title: 'Session',
        exportedAt: new Date('2026-07-28T12:34:56.000Z'),
      });

      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/matcha-agent/chat/history', {
        method: 'POST',
        body: JSON.stringify({
          id: 'matcha-agent.chat.history',
          operationId: 'matcha-agent.chat.history',
          sessionId: 'matcha-session-1',
        }),
      });
      await expect((createObjectURL.mock.calls[0]?.[0] as Blob).text()).resolves.toContain(
        '## Assistant\n\nNative answer',
      );
    } finally {
      clickSpy.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', { value: originalCreateObjectURL, configurable: true });
      Object.defineProperty(URL, 'revokeObjectURL', { value: originalRevokeObjectURL, configurable: true });
    }
  });

  it('rejects non-text Matcha response fields without downloading', async () => {
    hostApiFetchMock.mockResolvedValue({
      messages: [{ role: 'assistant', text: 'Answer', raw: 'private' }],
    });

    await expect(exportPeerTextHistoryMarkdown({
      runtimeAdapterId: 'matcha-agent',
      sessionKey: 'matcha-session-1',
      title: 'Session',
      exportedAt: new Date('2026-07-28T12:34:56.000Z'),
    })).rejects.toThrow('Matcha Agent chat history is unavailable');
  });
});
