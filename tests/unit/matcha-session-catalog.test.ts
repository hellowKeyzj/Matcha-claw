import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostMatchaSessionCatalogListMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostMatchaSessionCatalogList: (...args: unknown[]) => hostMatchaSessionCatalogListMock(...args),
}));

describe('matcha session catalog', () => {
  beforeEach(() => {
    hostMatchaSessionCatalogListMock.mockReset();
  });

  it('projects only opaque native session handles from the fixed Matcha endpoint', async () => {
    hostMatchaSessionCatalogListMock.mockResolvedValue({
      sessions: [
        {
          endpoint: {
            kind: 'native-runtime',
            runtimeAdapterId: 'matcha-agent',
            runtimeInstanceId: 'local',
          },
          nativeSessionHandle: ' native-session-1 ',
          updatedAt: 1_728_000_000_000,
        },
      ],
    });

    const { listMatchaSessionCatalog } = await import('@/services/runtime/matcha-session-catalog');

    await expect(listMatchaSessionCatalog()).resolves.toEqual([{
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'matcha-agent',
        runtimeInstanceId: 'local',
      },
      nativeSessionHandle: 'native-session-1',
      updatedAt: 1_728_000_000_000,
    }]);
    expect(hostMatchaSessionCatalogListMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the catalog payload has an unknown shape or invalid session', async () => {
    const { listMatchaSessionCatalog } = await import('@/services/runtime/matcha-session-catalog');
    hostMatchaSessionCatalogListMock.mockResolvedValueOnce({ sessions: { entries: [] } });
    await expect(listMatchaSessionCatalog()).resolves.toEqual([]);

    hostMatchaSessionCatalogListMock.mockResolvedValueOnce({
      sessions: [{
        endpoint: {
          kind: 'native-runtime',
          runtimeAdapterId: 'matcha-agent',
          runtimeInstanceId: 'local',
        },
        nativeSessionHandle: 'native-session-2',
        updatedAt: 'not-a-timestamp',
      }],
    });
    await expect(listMatchaSessionCatalog()).resolves.toEqual([]);

    hostMatchaSessionCatalogListMock.mockResolvedValueOnce({
      sessions: [{
        endpoint: {
          kind: 'native-runtime',
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'local',
        },
        nativeSessionHandle: 'native-session-3',
      }],
    });
    await expect(listMatchaSessionCatalog()).resolves.toEqual([]);

    hostMatchaSessionCatalogListMock.mockResolvedValueOnce({
      sessions: [{
        endpoint: {
          kind: 'native-runtime',
          runtimeAdapterId: 'matcha-agent',
          runtimeInstanceId: 'local',
        },
        nativeSessionHandle: '',
      }],
    });
    await expect(listMatchaSessionCatalog()).resolves.toEqual([]);

    hostMatchaSessionCatalogListMock.mockResolvedValueOnce({
      sessions: [{
        endpoint: {
          kind: 'native-runtime',
          runtimeAdapterId: 'matcha-agent',
          runtimeInstanceId: 'local',
        },
        nativeSessionHandle: 'native-session-4',
        endpointSessionId: 'legacy-alias-must-not-project',
        cwd: 'must-not-project',
      }],
    });
    await expect(listMatchaSessionCatalog()).resolves.toEqual([]);
  });

  it('fails safe without retaining a previous result when the host request fails', async () => {
    const { listMatchaSessionCatalog } = await import('@/services/runtime/matcha-session-catalog');
    hostMatchaSessionCatalogListMock.mockResolvedValueOnce({
      sessions: [{
        endpoint: {
          kind: 'native-runtime',
          runtimeAdapterId: 'matcha-agent',
          runtimeInstanceId: 'local',
        },
        nativeSessionHandle: 'native-session-1',
      }],
    });
    await expect(listMatchaSessionCatalog()).resolves.toEqual([{
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'matcha-agent',
        runtimeInstanceId: 'local',
      },
      nativeSessionHandle: 'native-session-1',
    }]);

    hostMatchaSessionCatalogListMock.mockRejectedValueOnce(new Error('host unavailable'));
    await expect(listMatchaSessionCatalog()).resolves.toEqual([]);
  });
});
