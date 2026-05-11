import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clawHubRoutes } from '../../runtime-host/api/routes/clawhub-routes';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

const openReadmeMock = vi.fn();
const openPathMock = vi.fn();

function createClawHubService() {
  return {
    search: vi.fn(),
    login: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    list: vi.fn(),
    openReadme: (...args: unknown[]) => openReadmeMock(...args),
    openPath: (...args: unknown[]) => openPathMock(...args),
  };
}

describe('clawhub routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('open-readme 路由会透传 baseDir 到 service', async () => {
    openReadmeMock.mockResolvedValueOnce({ success: true });

    const response = await dispatchRuntimeRouteDefinition(clawHubRoutes, 'POST', '/api/clawhub/open-readme', {
      skillKey: 'skill.alpha',
      slug: 'skill-alpha',
      baseDir: '/tmp/skills/skill-alpha',
    }, { clawHubService: createClawHubService() });

    expect(response).toMatchObject({
      status: 200,
      data: { success: true },
    });
    expect(openReadmeMock).toHaveBeenCalledWith('skill.alpha', 'skill-alpha', '/tmp/skills/skill-alpha');
  });

  it('open-path 路由会透传 baseDir 到 service', async () => {
    openPathMock.mockResolvedValueOnce({ success: true });

    const response = await dispatchRuntimeRouteDefinition(clawHubRoutes, 'POST', '/api/clawhub/open-path', {
      skillKey: 'skill.beta',
      slug: 'skill-beta',
      baseDir: '/tmp/skills/skill-beta',
    }, { clawHubService: createClawHubService() });

    expect(response).toMatchObject({
      status: 200,
      data: { success: true },
    });
    expect(openPathMock).toHaveBeenCalledWith('skill.beta', 'skill-beta', '/tmp/skills/skill-beta');
  });

  it('install 路由提交后台任务', async () => {
    const service = createClawHubService();
    service.install.mockReturnValueOnce({
      success: true,
      job: {
        id: 'job-clawhub-install',
        type: 'clawhub.install',
      },
    });

    const response = await dispatchRuntimeRouteDefinition(clawHubRoutes, 'POST', '/api/clawhub/install', {
      slug: 'skill-alpha',
    }, { clawHubService: service });

    expect(service.install).toHaveBeenCalledWith({ slug: 'skill-alpha' });
    expect(response).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-clawhub-install',
          type: 'clawhub.install',
        },
      },
    });
  });
});
