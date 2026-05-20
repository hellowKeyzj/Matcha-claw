import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('skills store error mapping', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('maps fetchSkills rate-limit error by AppError code', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/skills/status') {
        throw new Error('rate limit exceeded');
      }
      throw new Error(`Unexpected hostApiFetch path: ${path}`);
    });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().fetchSkills();

    expect(useSkillsStore.getState().error).toBe('fetchRateLimitError');
  });

  it('maps searchSkills timeout error by AppError code', async () => {
    hostApiFetchMock.mockRejectedValueOnce(new Error('request timeout'));

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills('git');

    expect(useSkillsStore.getState().searchError).toBe('searchTimeoutError');
  });

  it('preserves specific fetchSkills error messages when no mapped error code exists', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/skills/status') {
        throw new Error('custom fetch failure');
      }
      throw new Error(`Unexpected hostApiFetch path: ${path}`);
    });

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().fetchSkills();

    expect(useSkillsStore.getState().error).toBe('custom fetch failure');
  });

  it('preserves specific searchSkills error messages when no mapped error code exists', async () => {
    hostApiFetchMock.mockRejectedValueOnce(new Error('custom search failure'));

    const { useSkillsStore } = await import('@/stores/skills');
    await useSkillsStore.getState().searchSkills('git');

    expect(useSkillsStore.getState().searchError).toBe('custom search failure');
  });

  it('maps installSkill timeout result into installTimeoutError', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: false, error: 'request timeout' });

    const { useSkillsStore } = await import('@/stores/skills');
    await expect(useSkillsStore.getState().installSkill('demo-skill')).rejects.toThrow('installTimeoutError');
  });

  it('preserves specific installSkill error messages when no mapped error code exists', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: false, error: 'custom install failure' });

    const { useSkillsStore } = await import('@/stores/skills');
    await expect(useSkillsStore.getState().installSkill('demo-skill')).rejects.toThrow('custom install failure');
  });
});
