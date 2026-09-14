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

  it('uploads a local .matcha-skillpkg path without exposing package content', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ outcome: 'accepted' })
      .mockResolvedValueOnce({ packages: [] });
    const { useSealedSkillsStore } = await import('@/stores/sealed-skills');

    await useSealedSkillsStore.getState().uploadLocalSkillPackageToCloud('C:/sealed/calendar.matcha-skillpkg');

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/upload', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ packagePath: 'C:/sealed/calendar.matcha-skillpkg' }),
    }));
    expect(String(hostApiFetchMock.mock.calls[0]?.[1]?.body)).not.toContain('token');
    expect(String(hostApiFetchMock.mock.calls[0]?.[1]?.body)).not.toContain('content');
  });

  it('downloads and installs a cloud skill package by public package version id', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce({ install: { outcome: 'accepted' } })
      .mockResolvedValueOnce({ skills: [] })
      .mockResolvedValueOnce({ items: [] });
    const { useSealedSkillsStore } = await import('@/stores/sealed-skills');

    await useSealedSkillsStore.getState().downloadAndInstallCloudSkillPackage({
      packageId: 'pkg-calendar',
      packageVersionId: 'version-calendar',
      skillKey: 'calendar',
      fileName: 'calendar.matcha-skillpkg',
    });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/install', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ packageVersionId: 'version-calendar', packageType: 'skill', source: 'skills' }),
    }));
  });
});
