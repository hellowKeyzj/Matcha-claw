import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Skills } from '@/pages/Skills';

const fetchSkillsMock = vi.fn(async () => {});
const invokeIpcMock = vi.fn(async (channel: string) => {
  if (channel === 'openclaw:getSkillsDir') {
    return 'C:/Users/test/.openclaw/skills';
  }
  return '';
});

const gatewayState = {
  status: {
    state: 'running',
    port: 18789,
  },
};

const skillsState: {
  skills: Array<{ id: string; name: string; description: string; enabled: boolean; isBundled?: boolean; eligible?: boolean }>;
  loading: boolean;
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
  loading: false,
  error: null,
  fetchSkills: fetchSkillsMock,
  enableSkill: async () => {},
  disableSkill: async () => {},
  searchResults: [],
  searchSkills: async () => {},
  installSkill: async () => {},
  uninstallSkill: async () => {},
  searching: false,
  searchError: null,
  installing: {},
};

vi.mock('@/stores/skills', () => ({
  useSkillsStore: () => skillsState,
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
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
    vi.clearAllMocks();
  });

  it('skills 已存在时不重复触发 fetchSkills', async () => {
    skillsState.skills = [
      { id: 's1', name: 'Skill1', description: 'd', enabled: true, isBundled: true, eligible: true },
    ];

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(invokeIpcMock).toHaveBeenCalledWith('openclaw:getSkillsDir');
    });
    expect(fetchSkillsMock).not.toHaveBeenCalled();
  });

  it('skills 为空时触发 fetchSkills', async () => {
    skillsState.skills = [];

    render(
      <MemoryRouter>
        <Skills />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(fetchSkillsMock).toHaveBeenCalledTimes(1);
    });
  });
});
