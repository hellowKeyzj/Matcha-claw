import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const terminalMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/call-log-await', () => ({ waitForCall: terminalMock }));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  hostApiFetchDecoded: async (path: string, decode: (value: unknown) => unknown, init: unknown) => decode(await hostApiFetchMock(path, init)),
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
import { useSealedSkillsStore } from '@/stores/sealed-skills';
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
    if (url === '/api/skills/clawhub/install') return { callId: 'a'.repeat(32), accepted: true };
    if (url === '/api/skills/config') return { callId: 'b'.repeat(32), accepted: true };
    if (url === '/api/skills/operations/result') return { callId: 'b'.repeat(32), command: 'skills.config', result: { kind: 'config', outcome: 'accepted', skillKey: 'weather', invalidKeys: [] } };
    return status;
  });
}

describe('Skills page', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh');
    hostApiFetchMock.mockReset();
    useSealedSkillsStore.setState(useSealedSkillsStore.getInitialState(), true);
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

  it('shows mine drafts and only marks a cloud version installed from the local catalog', async () => {
    const draft = { packageId: 'mine', packageVersionId: 'draft-id', name: 'My Draft', packageType: 'skill', version: 'a'.repeat(64), status: 'draft', downloadable: false };
    const market = { packageId: 'market', packageVersionId: 'market-id', name: 'Cloud Calendar', packageType: 'skill', version: 'b'.repeat(64), status: 'published', entitlementStatus: 'active', downloadable: true };
    hostApiFetchMock.mockImplementation(async (path) => {
      if (path === '/api/packages/mine?packageType=skill') return { items: [draft] };
      if (path === '/api/packages/market?packageType=skill') return { items: [market] };
      if (path === '/api/packages/installed') return { packages: [] };
      if (path === '/api/packages/draft-id/publish') return { ...draft, status: 'published' };
      return status;
    });
    render(<MemoryRouter initialEntries={['/?tab=sealed']}><Skills /></MemoryRouter>);
    expect(screen.getByRole('tab', { name: '已安装', selected: true })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: '我的云端包' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('heading', { name: 'My Draft' })).toBeInTheDocument();
    expect(hostApiFetchMock.mock.calls.some(([path]) => String(path).endsWith('/publish'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '发布', exact: true }));
    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/packages/draft-id/publish', { method: 'POST' }));
    fireEvent.mouseDown(screen.getByRole('tab', { name: '云端市场' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('button', { name: '安装', exact: true })).toBeEnabled();
    expect(screen.getByText('云端可用')).toBeInTheDocument();
    act(() => useSealedSkillsStore.setState({ installedCloudPackages: [{ packageVersionId: 'other-id', packageType: 'skill', packageSha256: market.version, fileName: 'calendar.matcha-skillpkg' }] }));
    expect(screen.getByRole('button', { name: '安装', exact: true })).toBeDisabled();
    expect(screen.queryByText('云端可用')).not.toBeInTheDocument();
  });

  it('installs marketplace skills through install then one config write', async () => {
    mockSkillsApi();
    terminalMock.mockResolvedValueOnce({ callId: 'a'.repeat(32), module: 'skills', command: 'skills.clawhub.install', status: 'succeeded', detail: { access: 'write', slug: 'weather', outcome: 'accepted' } })
      .mockResolvedValueOnce({ callId: 'b'.repeat(32), module: 'skills', command: 'skills.config', status: 'succeeded', detail: { access: 'write', skillKey: 'weather', enabled: true, outcome: 'accepted', resultReady: true, result: 'accepted' } });

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
