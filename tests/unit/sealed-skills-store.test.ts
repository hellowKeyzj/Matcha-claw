import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('sealed skills store cloud packages', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
  });

  it('lists cloud skill packages through the package registry endpoint', async () => {
    hostApiFetchMock.mockResolvedValue({
      items: [{
        packageId: 'pkg-calendar',
        packageVersionId: 'version-calendar',
        name: 'skill:openclaw:calendar',
        displayName: 'Calendar',
        packageType: 'skill',
        version: 'v1',
        status: 'published',
        entitlementStatus: 'active',
        downloadable: true,
      }],
      total: 1,
      page: 1,
      pageSize: 20,
      pages: 1,
    });
    const { useSealedSkillsStore } = await import('@/stores/sealed-skills');

    await useSealedSkillsStore.getState().fetchCloudSkillPackages();

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/market?packageType=skill');
    expect(useSealedSkillsStore.getState().cloudPackages).toEqual([{ packageId: 'pkg-calendar', packageVersionId: 'version-calendar', packageType: 'skill', skillKey: 'skill:openclaw:calendar', name: 'Calendar', description: undefined, version: 'v1', installed: true, downloadable: true }]);
  });

  it('shows cloud package list failures as unavailable state', async () => {
    hostApiFetchMock.mockRejectedValue(new Error('Not Found'));
    const { SEALED_SKILL_CLOUD_UNAVAILABLE_ERROR, useSealedSkillsStore } = await import('@/stores/sealed-skills');

    useSealedSkillsStore.setState({
      cloudPackages: [{ packageId: 'stale', packageVersionId: 'stale', skillKey: 'stale' }],
    });
    await useSealedSkillsStore.getState().fetchCloudSkillPackages();

    expect(useSealedSkillsStore.getState().cloudPackages).toEqual([]);
    expect(useSealedSkillsStore.getState().cloudError).toBe(SEALED_SKILL_CLOUD_UNAVAILABLE_ERROR);
  });

  it('keeps sealed package paths out of renderer state', async () => {
    hostApiFetchMock.mockResolvedValue({
      skills: [{
        skillKey: 'skill:openclaw:calendar',
        name: 'Calendar',
        description: 'Calendar integration',
        enabled: true,
        installed: true,
        source: 'matcha-sealed',
        runtimes: ['openclaw'],
        packagePath: 'C:/Users/Mr.Key/.openclaw/skills/calendar.matcha-skillpkg',
      }],
    });
    const { useSealedSkillsStore } = await import('@/stores/sealed-skills');

    await useSealedSkillsStore.getState().fetchSealedSkills();

    expect(useSealedSkillsStore.getState().skills).toEqual([{ skillKey: 'skill:openclaw:calendar', name: 'Calendar', description: 'Calendar integration', installed: true, version: undefined, source: 'matcha-sealed', runtimes: ['openclaw'] }]);
    expect('packagePath' in useSealedSkillsStore.getState().skills[0]).toBe(false);
  });

  it('uploads an installed sealed skill package through skill key', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ packages: [] });
    const { useSealedSkillsStore } = await import('@/stores/sealed-skills');

    await useSealedSkillsStore.getState().uploadInstalledSkillPackageToCloud('skill:openclaw:calendar');

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/upload/sealed-skill', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ skillKey: 'skill:openclaw:calendar' }),
    }));
    expect(String(hostApiFetchMock.mock.calls[0]?.[1]?.body)).not.toMatch(/packagePath|deviceEnvelope|authorizationKey|contentKey|rawPayload|token/);
  });

  it('installs a local .matcha-skillpkg through the main-owned sealed install endpoint', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ outcome: 'accepted', skillKey: 'skill:openclaw:calendar' })
      .mockResolvedValueOnce({ skills: [] });
    const { useSealedSkillsStore } = await import('@/stores/sealed-skills');

    await useSealedSkillsStore.getState().installLocalSkillPackage();

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/sealed-skills/install-local', expect.objectContaining({
      method: 'POST',
    }));
    expect(String(hostApiFetchMock.mock.calls[0]?.[1]?.body ?? '')).not.toMatch(/packagePath|deviceEnvelope|authorizationKey|contentKey|rawPayload|token/);
    expect(useSealedSkillsStore.getState().localPackageInstalling).toBe(false);
  });

  it('downloads, installs, and refreshes a cloud skill package through the package install route', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ install: { outcome: 'accepted', skillKey: 'skill:openclaw:calendar' } })
      .mockResolvedValueOnce({ skills: [] })
      .mockResolvedValueOnce({ items: [] });
    const { useSealedSkillsStore } = await import('@/stores/sealed-skills');

    await useSealedSkillsStore.getState().downloadAndInstallCloudSkillPackage({
      packageId: 'pkg-calendar',
      packageVersionId: 'version-calendar',
      skillKey: 'skill:openclaw:calendar',
      fileName: 'calendar.matcha-skillpkg',
    });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/install', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ packageVersionId: 'version-calendar', packageType: 'skill', source: 'skills' }),
    }));
    expect(String(hostApiFetchMock.mock.calls[0]?.[1]?.body)).not.toMatch(/packagePath|deviceEnvelope|authorizationKey|contentKey|rawPayload|token/);
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/skills/config', expect.anything());
  });

  it('uninstalls a sealed skill package through the sealed package endpoint', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ outcome: 'removed', skillKey: 'skill:openclaw:calendar' })
      .mockResolvedValueOnce({ skills: [] });
    const { useSealedSkillsStore } = await import('@/stores/sealed-skills');

    await useSealedSkillsStore.getState().uninstallSealedSkill('skill:openclaw:calendar');

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/sealed-skills/uninstall', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ skillKey: 'skill:openclaw:calendar' }),
    }));
    expect(useSealedSkillsStore.getState().uninstallingBySkillKey).toEqual({});
  });
});
