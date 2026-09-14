import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  hostOpenClawGetSkillsDir: vi.fn().mockResolvedValue('C:/openclaw/skills'),
  resolveSingleCapabilityScope: vi.fn().mockResolvedValue('skills'),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { useGatewayStore } from '@/stores/gateway';
import { useSkillsStore } from '@/stores/skills';
import { Skills } from '@/pages/Skills';

const status = {
  skills: [{
    skillKey: 'calendar',
    name: 'Calendar',
    description: 'Calendar integration',
    disabled: false,
    selectable: true,
    eligible: true,
    unavailableReason: null,
    missingCategories: [],
  }],
};

const marketplaceResult = {
  success: true,
  results: [{
    slug: 'weather',
    name: 'Weather',
    description: 'Forecasts',
    version: '1.0.0',
  }],
};

function renderSkills() {
  return render(
    <MemoryRouter>
      <Skills />
    </MemoryRouter>,
  );
}

function mockSkillsApi() {
  hostApiFetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/clawhub/search') return marketplaceResult;
    if (url === '/api/skills/clawhub/install') return { outcome: 'accepted' };
    if (url === '/api/skills/config') return { outcome: 'accepted' };
    return status;
  });
}

describe('Skills page', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    hostApiFetchMock.mockReset();
    useSkillsStore.setState({
      skills: [],
      searchResults: [],
      snapshotReady: false,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      mutatingBySkillId: {},
      searching: false,
      searchError: null,
      installing: {},
      error: null,
    });
    useGatewayStore.getState().setStatus({
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
    });
  });

  it('renders status skills and management controls', async () => {
    hostApiFetchMock.mockResolvedValue(status);
    renderSkills();

    const skillsTab = await screen.findByRole('tab', { selected: true });
    expect(skillsTab).toHaveTextContent('技能');
    expect(skillsTab).toHaveTextContent('1');
    expect(screen.getByRole('tab', { name: '市场' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '批量启用可见项' })).toBeInTheDocument();
    expect(await screen.findByText('Calendar')).toBeInTheDocument();
  });

  it('installs marketplace skills through install then one config write', async () => {
    mockSkillsApi();

    await useSkillsStore.getState().installSkill('weather');

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/clawhub/install', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ slug: 'weather' }),
    }));
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/config', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ skillKey: 'weather', enabled: true }),
    }));
    expect(hostApiFetchMock.mock.calls.filter(([url]) => url === '/api/skills/config')).toHaveLength(1);
  });

});
