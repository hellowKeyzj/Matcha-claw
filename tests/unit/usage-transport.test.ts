import { describe, expect, it, vi } from 'vitest';
import { createUsageTransport } from '../../electron/main/runtime-host-delivery/transport/usage';

describe('Electron Main Usage transport', () => {
  it('signs the fixed recent-history request and accepts only the safe projection', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        entries: [{
          sessionId: 'session-1',
          agentId: 'main',
          timestamp: '2026-04-03T00:00:00.000Z',
          model: 'demo-model',
          provider: 'demo-provider',
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 4,
          cacheWriteTokens: 5,
          totalTokens: 14,
          costUsd: 0.01,
        }],
      }),
    });
    const transport = createUsageTransport({ verificationKey: 'public', signDecision }, 34_243, fetcher);

    await expect(transport.read(12)).resolves.toEqual({
      status: 200,
      body: {
        entries: [{
          sessionId: 'session-1',
          agentId: 'main',
          timestamp: '2026-04-03T00:00:00.000Z',
          model: 'demo-model',
          provider: 'demo-provider',
          inputTokens: 2,
          outputTokens: 3,
          cacheReadTokens: 4,
          cacheWriteTokens: 5,
          totalTokens: 14,
          costUsd: 0.01,
        }],
      },
    });
    expect(signDecision).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: '/api/usage/recent',
      scope: 'openclaw:usage-history:read',
      capability: 'openclaw.usage.history',
      subject: 'openclaw-usage-history',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34243/api/usage/recent?limit=12',
      expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer signed-decision' } }),
    );
  });

  it('reads session timeseries through the same sealed projection', async () => {
    const signDecision = vi.fn().mockReturnValue('signed-decision');
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ entries: [] }) });
    const transport = createUsageTransport({ verificationKey: 'public', signDecision }, 34_243, fetcher);

    await expect(transport.readSessionTimeseries({ sessionId: 'session-1', agentId: 'main' })).resolves.toEqual({ status: 200, body: { entries: [] } });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34243/api/usage/session-timeseries?sessionId=session-1&agentId=main',
      expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer signed-decision' } }),
    );
  });

  it('accepts empty usage history as a valid recovered projection', async () => {
    const transport = createUsageTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_243,
      vi.fn().mockResolvedValue({ status: 200, json: async () => ({ entries: [] }) }),
    );

    await expect(transport.read()).resolves.toEqual({ status: 200, body: { entries: [] } });
  });

  it('fails closed before signing invalid limits and redacts malformed native responses', async () => {
    const signDecision = vi.fn();
    const fetcher = vi.fn();
    const transport = createUsageTransport({ verificationKey: 'public', signDecision }, 34_243, fetcher);

    await expect(transport.read(0)).resolves.toEqual({
      status: 400,
      body: { success: false, error: 'OpenClaw usage history is unavailable' },
    });
    expect(signDecision).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();

    const malformed = await createUsageTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_243,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          entries: [{
            sessionId: 'session-1',
            agentId: 'main',
            timestamp: '2026-04-03T00:00:00.000Z',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 2,
            sourcePath: 'C:/private/session.jsonl',
          }],
        }),
      }),
    ).read();
    expect(malformed).toEqual({
      status: 503,
      body: { success: false, error: 'OpenClaw usage history is unavailable' },
    });
    expect(JSON.stringify(malformed)).not.toContain('C:/private/session.jsonl');

    const invalidIdentity = await createUsageTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_243,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          entries: [{
            sessionId: '../session',
            agentId: 'main',
            timestamp: '2026-04-03T00:00:00.000Z',
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 2,
          }],
        }),
      }),
    ).read();
    expect(invalidIdentity).toEqual({
      status: 503,
      body: { success: false, error: 'OpenClaw usage history is unavailable' },
    });
  });
});
