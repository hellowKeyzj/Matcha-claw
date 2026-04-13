import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: (...args: unknown[]) => rpcMock(...args),
    }),
  },
}));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mockSkillsFetchDependencies() {
  hostApiFetchMock.mockImplementation(async (path: string) => {
    if (path === '/api/skills/configs') {
      return {};
    }
    if (path === '/api/clawhub/list') {
      return { success: true, results: [] };
    }
    throw new Error(`Unexpected hostApiFetch path: ${path}`);
  });
}

describe('skills store availability and search cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('首次无快照时进入 initialLoading，成功后写入快照', async () => {
    const deferredRpc = createDeferred<{ skills: Array<{ skillKey: string; disabled?: boolean }> }>();
    rpcMock.mockReturnValue(deferredRpc.promise);
    mockSkillsFetchDependencies();

    const { useSkillsStore } = await import('@/stores/skills');
    const fetchPromise = useSkillsStore.getState().fetchSkills();

    expect(useSkillsStore.getState().snapshotReady).toBe(false);
    expect(useSkillsStore.getState().initialLoading).toBe(true);
    expect(useSkillsStore.getState().refreshing).toBe(false);

    deferredRpc.resolve({ skills: [{ skillKey: 'demo-skill', disabled: false }] });
    await fetchPromise;

    const state = useSkillsStore.getState();
    expect(state.snapshotReady).toBe(true);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.skills[0]?.id).toBe('demo-skill');
  });

  it('已有快照时刷新失败保留旧数据，不回退空白', async () => {
    rpcMock.mockResolvedValueOnce({
      skills: [{ skillKey: 'demo-skill', disabled: false }],
    });
    mockSkillsFetchDependencies();

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().fetchSkills();

    rpcMock.mockRejectedValueOnce(new Error('rate limit exceeded'));
    const refreshPromise = useSkillsStore.getState().fetchSkills({ force: true });

    expect(useSkillsStore.getState().refreshing).toBe(true);
    expect(useSkillsStore.getState().initialLoading).toBe(false);

    await refreshPromise;

    const state = useSkillsStore.getState();
    expect(state.snapshotReady).toBe(true);
    expect(state.refreshing).toBe(false);
    expect(state.skills[0]?.id).toBe('demo-skill');
    expect(state.error).toBe('fetchRateLimitError');
  });

  it('fetchSkills 并发请求会单飞去重', async () => {
    const deferredRpc = createDeferred<{ skills: Array<{ skillKey: string; disabled?: boolean }> }>();
    rpcMock.mockReturnValue(deferredRpc.promise);
    mockSkillsFetchDependencies();

    const { useSkillsStore } = await import('@/stores/skills');
    const first = useSkillsStore.getState().fetchSkills();
    const second = useSkillsStore.getState().fetchSkills();

    expect(rpcMock).toHaveBeenCalledTimes(1);

    deferredRpc.resolve({ skills: [{ skillKey: 'singleflight-skill', disabled: false }] });
    await Promise.all([first, second]);
  });

  it('enableSkill 会维护 mutatingBySkillId 生命周期', async () => {
    const deferredRpc = createDeferred<{ success: boolean }>();
    rpcMock.mockReturnValue(deferredRpc.promise);

    const { useSkillsStore } = await import('@/stores/skills');
    useSkillsStore.getState().setSkills([
      {
        id: 'demo-skill',
        slug: 'demo-skill',
        name: 'Demo Skill',
        description: 'demo',
        enabled: false,
        icon: '🧩',
      },
    ]);

    const enablePromise = useSkillsStore.getState().enableSkill('demo-skill');
    expect(useSkillsStore.getState().mutating).toBe(true);
    expect(useSkillsStore.getState().mutatingBySkillId['demo-skill']).toBe(1);

    deferredRpc.resolve({ success: true });
    await enablePromise;

    const state = useSkillsStore.getState();
    expect(state.mutating).toBe(false);
    expect(state.mutatingBySkillId['demo-skill']).toBeUndefined();
    expect(state.skills[0]?.enabled).toBe(true);
  });

  it('maps skills.status availability fields into Skill model', async () => {
    rpcMock.mockResolvedValueOnce({
      skills: [
        {
          skillKey: 'foo-skill',
          name: 'Foo Skill',
          description: 'foo',
          disabled: false,
          eligible: false,
          blockedByAllowlist: true,
          missing: {
            bins: ['git'],
            anyBins: ['pnpm', 'npm'],
            env: ['OPENAI_API_KEY'],
            config: ['baseUrl'],
            os: ['linux'],
          },
          source: 'openclaw-workspace',
          baseDir: '/tmp/openclaw/workspace/skills/foo-skill',
          filePath: '/tmp/openclaw/workspace/skills/foo-skill/SKILL.md',
        },
      ],
    });

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/skills/configs') {
        return {};
      }
      if (path === '/api/clawhub/list') {
        return { success: true, results: [] };
      }
      throw new Error(`Unexpected hostApiFetch path: ${path}`);
    });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().fetchSkills();

    expect(useSkillsStore.getState().skills).toHaveLength(1);
    expect(useSkillsStore.getState().skills[0]).toMatchObject({
      id: 'foo-skill',
      eligible: false,
      blockedByAllowlist: true,
      missing: {
        bins: ['git'],
        anyBins: ['pnpm', 'npm'],
        env: ['OPENAI_API_KEY'],
        config: ['baseUrl'],
        os: ['linux'],
      },
      source: 'openclaw-workspace',
      baseDir: '/tmp/openclaw/workspace/skills/foo-skill',
      filePath: '/tmp/openclaw/workspace/skills/foo-skill/SKILL.md',
    });
  });

  it('fills source/baseDir from clawhub list when gateway status entry is incomplete', async () => {
    rpcMock.mockResolvedValueOnce({
      skills: [
        {
          skillKey: 'git-helper',
          name: 'Git Helper',
          description: 'helper',
          disabled: false,
        },
      ],
    });

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/skills/configs') {
        return {};
      }
      if (path === '/api/clawhub/list') {
        return {
          success: true,
          results: [{
            slug: 'git-helper',
            version: '1.2.3',
            source: 'openclaw-managed',
            baseDir: '/tmp/.openclaw/skills/git-helper',
          }],
        };
      }
      throw new Error(`Unexpected hostApiFetch path: ${path}`);
    });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().fetchSkills();

    expect(useSkillsStore.getState().skills[0]).toMatchObject({
      id: 'git-helper',
      source: 'openclaw-managed',
      baseDir: '/tmp/.openclaw/skills/git-helper',
    });
  });

  it('deduplicates inflight marketplace search requests for same query', async () => {
    const deferred = createDeferred<{ success: boolean; results: Array<{ slug: string; name: string; description: string; version: string }>; }>();
    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/clawhub/search') {
        return deferred.promise;
      }
      throw new Error(`Unexpected hostApiFetch path: ${path}`);
    });

    const { useSkillsStore } = await import('@/stores/skills');
    const p1 = useSkillsStore.getState().searchSkills('git');
    const p2 = useSkillsStore.getState().searchSkills('git');

    deferred.resolve({
      success: true,
      results: [{ slug: 'git-helper', name: 'Git Helper', description: 'desc', version: '1.0.0' }],
    });

    await Promise.all([p1, p2]);

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(useSkillsStore.getState().searchResults).toHaveLength(1);
  });

  it('returns cached marketplace search result within ttl', async () => {
    hostApiFetchMock.mockResolvedValue({
      success: true,
      results: [{ slug: 'cache-skill', name: 'Cache Skill', description: 'desc', version: '1.0.0' }],
    });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills('cache');
    await useSkillsStore.getState().searchSkills('cache');

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(useSkillsStore.getState().searchResults[0]?.slug).toBe('cache-skill');
  });
});
