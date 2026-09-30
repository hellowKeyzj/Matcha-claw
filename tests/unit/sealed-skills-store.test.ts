import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  hostApiFetchDecoded: async (path: string, decode: (value: unknown) => unknown, options: unknown) => decode(await hostApiFetchMock(path, options)),
}));

const receipt = { callId: 'a'.repeat(32), accepted: true };
const terminal = (command: string, outcome = 'accepted') => ({
  callId: receipt.callId, module: 'skills', command, status: 'succeeded', start: 1, end: 2, revision: 3,
  detail: { access: command === 'sealedSkills.exportCloud' ? 'read' : 'write', outcome, skillKey: 'skill:openclaw:calendar' },
});

describe('sealed skills store cloud packages', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
  });

  it('lists cloud skill packages through the package registry endpoint', async () => {
    hostApiFetchMock.mockImplementation(async (path) => path === '/api/packages/installed' ? { packages: [] } : {
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
    expect(useSealedSkillsStore.getState().cloudPackages).toEqual([{ packageId: 'pkg-calendar', packageVersionId: 'version-calendar', packageType: 'skill', skillKey: 'skill:openclaw:calendar', name: 'Calendar', description: undefined, version: 'v1', status: 'published', entitlementStatus: 'active', downloadable: true }]);
    expect(useSealedSkillsStore.getState().installedCloudPackages).toEqual([]);
    expect(useSealedSkillsStore.getState().cloudPackages[0].installed).not.toBe(true);
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
    const operationId = 'cloud-package:00000000-0000-4000-8000-000000000001';
    hostApiFetchMock
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(terminal('sealedSkills.exportCloud'))
      .mockResolvedValueOnce({ operationId, accepted: true })
      .mockResolvedValueOnce({
        operationId, kind: 'confirmSealedSkillUpload', state: 'succeeded',
        result: { packageId: 'pkg-calendar', packageVersionId: 'version-calendar', name: 'skill:openclaw:calendar', packageType: 'skill', version: 'v1', status: 'draft', downloadable: false },
      })
      .mockResolvedValueOnce({ items: [] });
    const { useSealedSkillsStore } = await import('@/stores/sealed-skills');

    await useSealedSkillsStore.getState().uploadInstalledSkillPackageToCloud('skill:openclaw:calendar');

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/upload/sealed-skill', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ skillKey: 'skill:openclaw:calendar' }),
    }));
    expect(String(hostApiFetchMock.mock.calls[0]?.[1]?.body)).not.toMatch(/packagePath|deviceEnvelope|authorizationKey|contentKey|rawPayload|token/);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/mine?packageType=skill');
    expect(hostApiFetchMock.mock.calls.some(([path]) => String(path).endsWith('/publish'))).toBe(false);
  });

  it('publishes a mine draft explicitly and uses the direct version response', async () => {
    const draft = { packageId: 'pkg', packageVersionId: 'version/a', name: 'Calendar', packageType: 'skill', version: 'a'.repeat(64), status: 'draft', downloadable: false };
    hostApiFetchMock.mockImplementation(async (path) => {
      if (path === '/api/packages/mine?packageType=skill') return { items: [draft] };
      if (path === '/api/packages/version%2Fa/publish') return { ...draft, status: 'published' };
      if (path === '/api/packages/installed') return { packages: [] };
      return { items: [] };
    });
    const { useSealedSkillsStore } = await import('@/stores/sealed-skills');
    await useSealedSkillsStore.getState().fetchMyCloudSkillPackages();
    expect(useSealedSkillsStore.getState().myCloudPackages).toEqual([draft]);
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    await useSealedSkillsStore.getState().publishCloudSkillPackage(draft.packageVersionId);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/version%2Fa/publish', { method: 'POST' });
    expect(useSealedSkillsStore.getState().myCloudPackages[0].status).toBe('published');
    expect(useSealedSkillsStore.getState().cloudPublishingByVersionId).toEqual({});
  });

  it('installs a local .matcha-skillpkg through the main-owned sealed install endpoint', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(terminal('sealedSkills.install'))
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
    const operationId = 'cloud-package:00000000-0000-4000-8000-000000000002';
    hostApiFetchMock
      .mockResolvedValueOnce({ operationId, accepted: true })
      .mockResolvedValueOnce({
        operationId, kind: 'install', state: 'succeeded',
        result: { packageVersionId: 'version-calendar', filename: 'calendar.matcha-skillpkg', bytes: 1024, packageSha256: 'a'.repeat(64), install: receipt },
      })
      .mockResolvedValueOnce(terminal('sealedSkills.install'))
      .mockResolvedValueOnce({ install: { outcome: 'accepted', skillKey: 'skill:openclaw:calendar' } })
      .mockResolvedValueOnce({ skills: [] })
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ packages: [] });
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
      .mockResolvedValueOnce(receipt)
      .mockResolvedValueOnce(terminal('sealedSkills.uninstall', 'removed'))
      .mockResolvedValueOnce({ skills: [] })
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ packages: [] });
    const { useSealedSkillsStore } = await import('@/stores/sealed-skills');

    await useSealedSkillsStore.getState().uninstallSealedSkill('skill:openclaw:calendar');

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/sealed-skills/uninstall', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ skillKey: 'skill:openclaw:calendar' }),
    }));
    expect(useSealedSkillsStore.getState().uninstallingBySkillKey).toEqual({});
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/installed');
    expect(useSealedSkillsStore.getState().cloudError).toBeNull();
  });
});
