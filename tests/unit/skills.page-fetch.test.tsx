import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Skills } from '@/pages/Skills';
import { toast } from 'sonner';

const fetchSkillsMock = vi.fn(async () => {});
const enableSkillMock = vi.fn(async () => {});
const disableSkillMock = vi.fn(async () => {});
const installSkillMock = vi.fn(async () => {});
const uninstallSkillMock = vi.fn(async () => {});
const invokeIpcMock = vi.fn();

const gatewayState = {
  status: {
    processState: 'running',
    port: 18789,
    gatewayReady: true,
    healthSummary: 'healthy',
    transportState: 'connected',
    portReachable: true,
    diagnostics: {
      consecutiveHeartbeatMisses: 0,
      consecutiveRpcFailures: 0,
    },
    updatedAt: 1,
  },
};

const skillsState: {
  skills: Array<{ id: string; name: string; description: string; enabled: boolean; isBundled?: boolean; eligible?: boolean }>;
  snapshotReady: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  mutating: boolean;
  error: string | null;
  fetchSkills: typeof fetchSkillsMock;
  enableSkill: (skillId: string) => Promise<void>;
  disableSkill: (skillId: string) => Promise<void>;
  searchResults: unknown[];
  searchSkills: (query: string) => Promise<void>;
  installSkill: (slug: string, version?: string) => Promise<void>;
  uninstallSkill: (slug: string) => Promise<void>;
  searching: boolean;
  searchError: string | null;
  installing: Record<string, boolean>;
} = {
  skills: [],
  snapshotReady: false,
  initialLoading: false,
  refreshing: false,
  mutating: false,
  error: null,
  fetchSkills: fetchSkillsMock,
  enableSkill: enableSkillMock,
  disableSkill: disableSkillMock,
  searchResults: [],
  searchSkills: async () => {},
  installSkill: installSkillMock,
  uninstallSkill: uninstallSkillMock,
  searching: false,
  searchError: null,
  installing: {},
};
const hoisted = vi.hoisted(() => ({
  useSkillsStoreMock: Object.assign(
    (selector: (state: typeof skillsState) => unknown) => selector(skillsState),
    {
      getState: () => skillsState,
    },
  ),
}));

vi.mock('@/stores/skills', () => ({
  useSkillsStore: hoisted.useSkillsStoreMock,
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('skills page fetch behavior', () => {
  beforeEach(() => {
    vi.useRealTimers();
    invokeIpcMock.mockClear();
    fetchSkillsMock.mockClear();
    enableSkillMock.mockClear();
    disableSkillMock.mockClear();
    installSkillMock.mockClear();
    uninstallSkillMock.mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
    invokeIpcMock.mockImplementation(async (channel: string, payload?: { path?: string }) => {
      if (channel === 'hostapi:fetch' && payload?.path === '/api/openclaw/skills-dir') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: 'C:/Users/test/.openclaw/skills',
          },
        };
      }
      if (channel === 'hostapi:fetch' && payload?.path === '/api/skills/import-local') {
        return {
          ok: true,
          data: {
            status: 202,
            ok: true,
            json: {
              success: true,
              job: {
                id: 'job-skill-import',
                type: 'skills.importLocal',
                status: 'queued',
                queuedAt: 1,
                attempts: 0,
                maxAttempts: 1,
              },
            },
          },
        };
      }
      if (channel === 'hostapi:fetch' && payload?.path === '/api/runtime-host/jobs/get') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              success: true,
              job: {
                id: 'job-skill-import',
                type: 'skills.importLocal',
                status: 'succeeded',
                queuedAt: 1,
                startedAt: 2,
                finishedAt: 3,
                attempts: 1,
                maxAttempts: 1,
                result: {
                  success: true,
                  skillKey: 'uploaded-skill',
                  installedPath: 'C:/Users/test/.openclaw/skills/uploaded-skill',
                  sourceKind: 'zip',
                },
              },
            },
          },
        };
      }
      if (channel === 'dialog:open') {
        return {
          canceled: false,
          filePaths: ['C:/Downloads/uploaded-skill.zip'],
        };
      }
      return '';
    });
    skillsState.skills = [];
    skillsState.snapshotReady = false;
    skillsState.initialLoading = false;
    skillsState.refreshing = false;
    skillsState.mutating = false;
    skillsState.error = null;
    skillsState.searchResults = [];
    skillsState.searching = false;
    skillsState.searchError = null;
    skillsState.installing = {};
    gatewayState.status.processState = 'running';
    gatewayState.status.gatewayReady = true;
    gatewayState.status.transportState = 'connected';
    gatewayState.status.healthSummary = 'healthy';
  });

  it('skills 已存在时不重复触发 fetchSkills', async () => {
    skillsState.skills = [
      { id: 's1', name: 'Skill1', description: 'd', enabled: true, isBundled: true, eligible: true },
    ];
    skillsState.snapshotReady = true;

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );
    expect(fetchSkillsMock).not.toHaveBeenCalled();
  });

  it('skills 为空时触发 fetchSkills', async () => {
    skillsState.skills = [];
    skillsState.snapshotReady = false;

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(fetchSkillsMock).toHaveBeenCalledTimes(1);
    });
  });

  it('手动刷新按钮会请求最新技能快照', async () => {
    skillsState.skills = [
      { id: 's1', name: 'Skill1', description: 'd', enabled: true, isBundled: true, eligible: true },
    ];
    skillsState.snapshotReady = true;

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));

    expect(fetchSkillsMock).toHaveBeenCalledWith({ force: true, fresh: true });
  });

  it('技能页会一次性渲染完整技能列表，不使用内部裁切滚动区', async () => {
    skillsState.skills = Array.from({ length: 30 }, (_, index) => ({
      id: `skill-${index + 1}`,
      name: `Skill ${index + 1}`,
      description: `Description ${index + 1}`,
      enabled: index % 2 === 0,
      isBundled: index % 3 === 0,
      eligible: true,
    }));
    skillsState.snapshotReady = true;

    const { container } = render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Skill 1')).toBeInTheDocument();
      expect(screen.getByText('Skill 30')).toBeInTheDocument();
    });

    const clippedViewport = container.querySelector('.max-h-\\[56vh\\].overflow-y-auto');
    expect(clippedViewport).toBeNull();
  });

  it('已安装列表展示可用技能与用户禁用项，过滤掉缺依赖与状态未知项', async () => {
    skillsState.skills = [
      { id: 'available-skill', name: 'Available Skill', description: 'ready', enabled: true, isBundled: true, eligible: true },
      { id: 'disabled-skill', name: 'Disabled Skill', description: 'user disabled', enabled: false, isBundled: true, eligible: false },
      { id: 'missing-skill', name: 'Missing Skill', description: 'missing deps', enabled: true, isBundled: true, eligible: false },
      { id: 'unknown-skill', name: 'Unknown Skill', description: 'unknown eligibility', enabled: true, isBundled: false },
    ];
    skillsState.snapshotReady = true;

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Available Skill')).toBeInTheDocument();
    });

    expect(screen.getByText('Disabled Skill')).toBeInTheDocument();
    expect(screen.queryByText('Missing Skill')).not.toBeInTheDocument();
    expect(screen.queryByText('Unknown Skill')).not.toBeInTheDocument();
    expect(screen.queryByText('filter.eligible')).not.toBeInTheDocument();
  });

  it('市场页移除旧手动安装提示卡，并提供上传技能入口', async () => {
    skillsState.snapshotReady = true;

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'tabs.marketplace' }));

    await screen.findByPlaceholderText('searchMarketplace');

    expect(screen.queryByText('marketplace.manualInstallHint')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'marketplace.uploadSkill' })).toBeInTheDocument();
  });

  it('市场搜索未知错误时展示具体错误信息而不是通用兜底文案', async () => {
    skillsState.snapshotReady = true;
    skillsState.searchError = 'custom search failure';

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'tabs.marketplace' }));

    await screen.findByPlaceholderText('searchMarketplace');

    expect(screen.getByText('custom search failure')).toBeInTheDocument();
    expect(screen.queryByText('marketplace.searchError')).not.toBeInTheDocument();
  });

  it('市场卡片描述使用与已安装列表一致的两行省略样式', async () => {
    skillsState.skills = [];
    skillsState.searchResults = [{
      slug: 'meeting-helper',
      name: 'Meeting Helper',
      description: 'This is a long marketplace description that should clamp consistently with the installed skill cards.',
      version: '1.0.0',
      author: 'matchaclaw',
    }];
    skillsState.snapshotReady = true;

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'tabs.marketplace' }));

    await screen.findByPlaceholderText('searchMarketplace');

    const description = await screen.findByText(
      'This is a long marketplace description that should clamp consistently with the installed skill cards.',
    );

    expect(description).toHaveClass('line-clamp-2');
    expect(description).toHaveClass('leading-6');
  });

  it('上传技能弹窗可以选择本地来源并更新选择状态', async () => {
    skillsState.snapshotReady = true;

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'tabs.marketplace' }));
    await screen.findByPlaceholderText('searchMarketplace');

    fireEvent.click(screen.getByRole('button', { name: 'marketplace.uploadSkill' }));
    expect(screen.getByText('marketplace.uploadDialog.title')).toBeInTheDocument();

    fireEvent.click(screen.getByText('marketplace.uploadDialog.empty'));

    await waitFor(() => {
      expect(invokeIpcMock).toHaveBeenCalledWith(
        'dialog:open',
        expect.objectContaining({
          properties: ['openFile', 'openDirectory'],
        }),
      );
    });

    expect(screen.getByText('uploaded-skill.zip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'marketplace.uploadDialog.confirm' })).toBeEnabled();
  });

  it('上传技能弹窗可以拖入本地来源并更新选择状态', async () => {
    skillsState.snapshotReady = true;
    vi.mocked(window.electron.getPathForFile).mockReturnValue('C:/Downloads/dragged-skill.zip');

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'tabs.marketplace' }));
    await screen.findByPlaceholderText('searchMarketplace');

    fireEvent.click(screen.getByRole('button', { name: 'marketplace.uploadSkill' }));
    const dropTarget = screen.getByText('marketplace.uploadDialog.empty').closest('[role="button"]');
    expect(dropTarget).not.toBeNull();

    fireEvent.drop(dropTarget as HTMLElement, {
      dataTransfer: {
        files: [new File(['skill'], 'dragged-skill.zip', { type: 'application/zip' })],
      },
    });

    expect(window.electron.getPathForFile).toHaveBeenCalled();
    expect(screen.getByText('dragged-skill.zip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'marketplace.uploadDialog.confirm' })).toBeEnabled();
  });

  it('上传技能不需要勾选，导入完成后会用后台任务返回的 skillKey 自动启用', async () => {
    skillsState.snapshotReady = true;

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'tabs.marketplace' }));
    await screen.findByPlaceholderText('searchMarketplace');

    fireEvent.click(screen.getByRole('button', { name: 'marketplace.uploadSkill' }));
    expect(screen.queryByText('marketplace.uploadDialog.autoEnable')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('marketplace.uploadDialog.empty'));
    await screen.findByText('uploaded-skill.zip');

    fireEvent.click(screen.getByRole('button', { name: 'marketplace.uploadDialog.confirm' }));

    await waitFor(() => {
      expect(enableSkillMock).toHaveBeenCalledWith('uploaded-skill');
    });
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'hostapi:fetch',
      expect.objectContaining({ path: '/api/runtime-host/jobs/get' }),
    );
  });

  it('上传技能格式不符合要求时显示具体错误且不会启用', async () => {
    skillsState.snapshotReady = true;
    invokeIpcMock.mockImplementation(async (channel: string, payload?: { path?: string }) => {
      if (channel === 'hostapi:fetch' && payload?.path === '/api/openclaw/skills-dir') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: 'C:/Users/test/.openclaw/skills',
          },
        };
      }
      if (channel === 'hostapi:fetch' && payload?.path === '/api/skills/import-local') {
        return {
          ok: true,
          data: {
            status: 202,
            ok: true,
            json: {
              success: true,
              job: {
                id: 'job-skill-import',
                type: 'skills.importLocal',
                status: 'queued',
                queuedAt: 1,
                attempts: 0,
                maxAttempts: 1,
              },
            },
          },
        };
      }
      if (channel === 'hostapi:fetch' && payload?.path === '/api/runtime-host/jobs/get') {
        return {
          ok: true,
          data: {
            status: 200,
            ok: true,
            json: {
              success: true,
              job: {
                id: 'job-skill-import',
                type: 'skills.importLocal',
                status: 'failed',
                queuedAt: 1,
                startedAt: 2,
                finishedAt: 3,
                attempts: 1,
                maxAttempts: 1,
                error: 'SKILL.md 格式不符合要求，缺少 YAML frontmatter 中的 name 和 description。',
              },
            },
          },
        };
      }
      if (channel === 'dialog:open') {
        return {
          canceled: false,
          filePaths: ['C:/Downloads/bad-skill.zip'],
        };
      }
      return '';
    });

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'tabs.marketplace' }));
    await screen.findByPlaceholderText('searchMarketplace');

    fireEvent.click(screen.getByRole('button', { name: 'marketplace.uploadSkill' }));
    fireEvent.click(screen.getByText('marketplace.uploadDialog.empty'));
    await screen.findByText('bad-skill.zip');

    fireEvent.click(screen.getByRole('button', { name: 'marketplace.uploadDialog.confirm' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'toast.failedImportLocalSkill: SKILL.md 格式不符合要求，缺少 YAML frontmatter 中的 name 和 description。',
      );
    });
    expect(enableSkillMock).not.toHaveBeenCalled();
    expect(fetchSkillsMock).not.toHaveBeenCalledWith({ force: true, fresh: true });
    expect(toast.success).not.toHaveBeenCalled();
  });
});
