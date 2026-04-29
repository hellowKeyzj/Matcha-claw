import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Skills } from '@/pages/Skills';

const fetchSkillsMock = vi.fn(async () => {});
const enableSkillMock = vi.fn(async () => {});
const disableSkillMock = vi.fn(async () => {});
const installSkillMock = vi.fn(async () => {});
const uninstallSkillMock = vi.fn(async () => {});
const invokeIpcMock = vi.fn();

const gatewayState = {
  status: {
    state: 'running',
    port: 18789,
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

vi.mock('@/stores/skills', () => ({
  useSkillsStore: (selector: (state: typeof skillsState) => unknown) => selector(skillsState),
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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('skills page fetch behavior', () => {
  beforeEach(() => {
    invokeIpcMock.mockClear();
    fetchSkillsMock.mockClear();
    enableSkillMock.mockClear();
    disableSkillMock.mockClear();
    installSkillMock.mockClear();
    uninstallSkillMock.mockClear();
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
            status: 200,
            ok: true,
            json: {
              success: true,
              skillKey: 'uploaded-skill',
              installedPath: 'C:/Users/test/.openclaw/skills/uploaded-skill',
              sourceKind: 'zip',
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

  it('已安装列表只展示可用技能，并移除冗余的可用筛选', async () => {
    skillsState.skills = [
      { id: 'available-skill', name: 'Available Skill', description: 'ready', enabled: true, isBundled: true, eligible: true },
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
});
