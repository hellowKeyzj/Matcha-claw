import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  resolveSingleCapabilityScope: vi.fn(),
}));

describe('skills store local import', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
  });

  it('sends markdown content to the fixed import endpoint without a native path', async () => {
    hostApiFetchMock.mockResolvedValue({ outcome: 'accepted' });
    const { useSkillsStore } = await import('@/stores/skills');
    const content = '---\nname: Web Search\ndescription: Search the web\n---\n';

    await expect(useSkillsStore.getState().importLocalSkill({
      kind: 'markdown',
      skillKey: 'web-search',
      content,
    })).resolves.toBe('web-search');

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/import/markdown', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    expect(String(hostApiFetchMock.mock.calls[0]?.[1]?.body)).not.toContain('C:/');
    expect(useSkillsStore.getState()).toMatchObject({
      installing: {},
      mutatingBySkillId: {},
      mutating: false,
    });
  });

  it('sends bundle content and its derived key to the fixed bundle endpoint', async () => {
    hostApiFetchMock.mockResolvedValue({ outcome: 'accepted' });
    const { useSkillsStore } = await import('@/stores/skills');
    const files = [{ path: 'SKILL.md', content: '---\nname: Web Search\ndescription: Search the web\n---\n' }];

    await expect(useSkillsStore.getState().importLocalSkill({
      kind: 'bundle',
      skillKey: 'web-search',
      files,
    })).resolves.toBe('web-search');

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/import/bundle', {
      method: 'POST',
      body: JSON.stringify({ skillKey: 'web-search', files }),
    });
    expect(String(hostApiFetchMock.mock.calls[0]?.[1]?.body)).not.toContain('C:/');
  });

  it.each(['rejected', 'unknown'] as const)('does not mutate an existing projection when import is %s', async (outcome) => {
    hostApiFetchMock.mockResolvedValue({ outcome });
    const { useSkillsStore } = await import('@/stores/skills');
    const existingSkill = {
      id: 'calendar',
      name: 'Calendar',
      description: 'Calendar integration',
      enabled: true,
    };
    useSkillsStore.getState().setSkills([existingSkill]);

    await expect(useSkillsStore.getState().importLocalSkill({
      kind: 'markdown',
      skillKey: 'web-search',
      content: '---\nname: Web Search\ndescription: Search the web\n---\n',
    })).rejects.toThrow('Skill import failed');

    expect(useSkillsStore.getState().skills).toEqual([existingSkill]);
    expect(useSkillsStore.getState()).toMatchObject({
      installing: {},
      mutatingBySkillId: {},
      mutating: false,
    });
  });
});
