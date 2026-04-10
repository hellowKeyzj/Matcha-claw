import { beforeEach, describe, expect, it, vi } from 'vitest';

const openReadmeMock = vi.fn();
const openPathMock = vi.fn();

vi.mock('../../runtime-host/application/skills/clawhub', () => ({
  ClawHubService: class {
    search = vi.fn();
    login = vi.fn();
    install = vi.fn();
    uninstall = vi.fn();
    list = vi.fn();
    openReadme = (...args: unknown[]) => openReadmeMock(...args);
    openPath = (...args: unknown[]) => openPathMock(...args);
  },
  listInstalledClawHubSkills: vi.fn(),
}));

describe('clawhub routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('open-readme 路由会透传 baseDir 到 service', async () => {
    openReadmeMock.mockResolvedValueOnce({ success: true });
    const { handleClawHubRoute } = await import('../../runtime-host/api/routes/clawhub-routes');

    const response = await handleClawHubRoute('POST', '/api/clawhub/open-readme', {
      skillKey: 'skill.alpha',
      slug: 'skill-alpha',
      baseDir: '/tmp/skills/skill-alpha',
    });

    expect(response).toMatchObject({
      status: 200,
      data: { success: true },
    });
    expect(openReadmeMock).toHaveBeenCalledWith('skill.alpha', 'skill-alpha', '/tmp/skills/skill-alpha');
  });

  it('open-path 路由会透传 baseDir 到 service', async () => {
    openPathMock.mockResolvedValueOnce({ success: true });
    const { handleClawHubRoute } = await import('../../runtime-host/api/routes/clawhub-routes');

    const response = await handleClawHubRoute('POST', '/api/clawhub/open-path', {
      skillKey: 'skill.beta',
      slug: 'skill-beta',
      baseDir: '/tmp/skills/skill-beta',
    });

    expect(response).toMatchObject({
      status: 200,
      data: { success: true },
    });
    expect(openPathMock).toHaveBeenCalledWith('skill.beta', 'skill-beta', '/tmp/skills/skill-beta');
  });
});
