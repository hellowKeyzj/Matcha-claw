import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const terminalMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/call-log-await', () => ({ waitForCall: terminalMock }));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  resolveSingleCapabilityScope: vi.fn(),
}));

describe('skills store local import', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockResolvedValue({ callId: 'a'.repeat(32), accepted: true });
    terminalMock.mockReset();
  });

  it('sends markdown content to the fixed import endpoint without a native path', async () => {
    terminalMock.mockResolvedValue({ callId: 'a'.repeat(32), module: 'skills', command: 'skills.import.markdown', status: 'succeeded', detail: { access: 'write', outcome: 'accepted' } });
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
    terminalMock.mockResolvedValue({ callId: 'a'.repeat(32), module: 'skills', command: 'skills.import.bundle', status: 'succeeded', detail: { access: 'write', skillKey: 'web-search', outcome: 'accepted' } });
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
    terminalMock.mockResolvedValue({ callId: 'a'.repeat(32), module: 'skills', command: 'skills.import.markdown', status: outcome, detail: { access: 'write', outcome } });
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
