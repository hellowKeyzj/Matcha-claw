import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '@/pages/Dashboard';

const fetchChannelsMock = vi.fn(async () => {});
const fetchSkillsMock = vi.fn(async () => {});
const hostApiFetchMock = vi.fn(async (path: string) => {
  if (path === '/api/runtime-host/usage/recent') {
    return [
      {
        timestamp: '2026-03-15T00:00:00.000Z',
        sessionId: 's-1',
        agentId: 'main',
        model: 'demo-model',
        provider: 'demo-provider',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
      },
    ];
  }
  return { success: true };
});

const gatewayState = {
  status: {
    state: 'running',
    port: 18789,
    pid: 1234,
    connectedAt: Date.now(),
  },
};

const channelsState = {
  channels: [],
  fetchChannels: fetchChannelsMock,
};

const skillsState: {
  skills: Array<{ id: string; enabled: boolean; name: string }>;
  fetchSkills: typeof fetchSkillsMock;
} = {
  skills: [],
  fetchSkills: fetchSkillsMock,
};

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/stores/channels', () => ({
  useChannelsStore: (selector?: (state: typeof channelsState) => unknown) =>
    typeof selector === 'function' ? selector(channelsState) : channelsState,
}));

vi.mock('@/stores/skills', () => ({
  useSkillsStore: (selector?: (state: typeof skillsState) => unknown) =>
    typeof selector === 'function' ? selector(skillsState) : skillsState,
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: { devModeUnlocked: boolean }) => unknown) =>
    selector({ devModeUnlocked: false }),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('dashboard skills fetch behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('技能列表已有数据时，不重复触发 fetchSkills', async () => {
    skillsState.skills = [{ id: 'skill-1', enabled: true, name: 'Skill 1' }];

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(fetchChannelsMock).toHaveBeenCalled();
    });
    expect(fetchSkillsMock).not.toHaveBeenCalled();
  });

  it('技能列表为空时，才触发 fetchSkills', async () => {
    skillsState.skills = [];

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(fetchSkillsMock).toHaveBeenCalledTimes(1);
    });
  });
});
