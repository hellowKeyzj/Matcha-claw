import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSkillManagementCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/skill/skill-management-capability';

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

  it('clawhub.openReadme capability 会透传 baseDir 到 service', async () => {
    openReadmeMock.mockResolvedValueOnce({ success: true });

    const [route] = createSkillManagementCapabilityOperationRoutes({
      skillsService: {} as never,
      clawHubService: createClawHubService(),
    }).filter((item) => item.operationId === 'clawhub.openReadme');
    const response = await route.handle({
      domainInput: {
        skillKey: 'skill.alpha',
        slug: 'skill-alpha',
        baseDir: '/tmp/skills/skill-alpha',
      },
    });

    expect(response).toMatchObject({
      status: 200,
      data: { success: true },
    });
    expect(openReadmeMock).toHaveBeenCalledWith('skill.alpha', 'skill-alpha', '/tmp/skills/skill-alpha');
  });

  it('clawhub.openPath capability 会透传 baseDir 到 service', async () => {
    openPathMock.mockResolvedValueOnce({ success: true });

    const [route] = createSkillManagementCapabilityOperationRoutes({
      skillsService: {} as never,
      clawHubService: createClawHubService(),
    }).filter((item) => item.operationId === 'clawhub.openPath');
    const response = await route.handle({
      domainInput: {
        skillKey: 'skill.beta',
        slug: 'skill-beta',
        baseDir: '/tmp/skills/skill-beta',
      },
    });

    expect(response).toMatchObject({
      status: 200,
      data: { success: true },
    });
    expect(openPathMock).toHaveBeenCalledWith('skill.beta', 'skill-beta', '/tmp/skills/skill-beta');
  });

  it('clawhub.install capability 提交后台任务', async () => {
    const service = createClawHubService();
    service.install.mockReturnValueOnce({
      success: true,
      job: {
        id: 'job-clawhub-install',
        type: 'clawhub.install',
      },
    });

    const [installRoute] = createSkillManagementCapabilityOperationRoutes({
      skillsService: {} as never,
      clawHubService: service,
    }).filter((route) => route.operationId === 'clawhub.install');
    const response = await installRoute.handle({ domainInput: { slug: 'skill-alpha' } });

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
