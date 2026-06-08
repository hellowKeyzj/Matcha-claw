import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { SecurityPage } from '@/pages/Security';
import { useSecuritySupportStore } from '@/stores/security-support-store';

const hostApiFetchMock = vi.fn();
const resolveSingleCapabilityScopeMock = vi.fn();
const gatewayRpcMock = vi.fn();
const loadAgentsMock = vi.fn(async () => {});

const subagentsState = {
  agents: [{ id: 'main', name: 'Main Agent' }],
  loadAgents: loadAgentsMock,
};

const gatewayState = {
  status: {
    processState: 'running' as const,
    port: 18789,
    gatewayReady: true,
    healthSummary: 'healthy' as const,
    transportState: 'connected' as const,
    portReachable: true,
    diagnostics: {
      consecutiveHeartbeatMisses: 0,
      consecutiveRpcFailures: 0,
    },
    updatedAt: 1,
  },
  isInitialized: true,
  rpc: gatewayRpcMock,
};

vi.mock('@/stores/subagents', () => ({
  useSubagentsStore: (selector: (state: typeof subagentsState) => unknown) => selector(subagentsState),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  resolveSingleCapabilityScope: (...args: unknown[]) => resolveSingleCapabilityScopeMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh' },
  }),
}));

describe('SecurityPage API 接入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayState.isInitialized = true;
    gatewayState.status = {
      ...gatewayState.status,
      processState: 'running',
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
    };
    useSecuritySupportStore.setState({
      activeSection: 'runtime',
      auditItems: [],
      loadingAudit: false,
      ruleCatalog: [],
      loadingRuleCatalog: false,
      ruleCatalogError: null,
      securityOpBusy: null,
      securityOpResult: '',
    });
    resolveSingleCapabilityScopeMock.mockResolvedValue({
      kind: 'runtime-instance',
      endpoint: {
        kind: 'native-runtime',
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
      },
    });
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/security') {
        return {
          securityPreset: 'balanced',
          securityPolicyVersion: 1,
          securityPolicyByAgent: {},
        };
      }
      if (path === '/api/security/audit?page=1&pageSize=8') {
        return {
          items: [],
        };
      }
      if (path === '/api/platform/tools?includeDisabled=true') {
        return {
          success: true,
          tools: [
            { id: 'system.run', name: 'System Run', source: 'native', enabled: true },
            { id: 'http.request', name: 'HTTP Request', source: 'native', enabled: true },
          ],
        };
      }
      if (path === '/api/skills/effective') {
        return { success: true, tools: [] };
      }
      throw new Error(`unexpected path: ${path}`);
    });
    gatewayRpcMock.mockResolvedValue({ page: 1, pageSize: 8, total: 0, items: [] });
  });

  it('页面加载时应通过 /api/security 读取策略', async () => {
    render(
      <MemoryRouter>
        <SecurityPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/security');
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/security/audit?page=1&pageSize=8');
    expect(gatewayRpcMock).not.toHaveBeenCalled();
  });

  it('初始化前审计区显示准备中，不显示停止文案', () => {
    gatewayState.isInitialized = false;
    gatewayState.status = {
      ...gatewayState.status,
      processState: 'stopped',
      gatewayReady: false,
      healthSummary: 'unresponsive',
      transportState: 'disconnected',
      portReachable: false,
    };
    useSecuritySupportStore.setState({ activeSection: 'auditHits' });

    render(
      <MemoryRouter>
        <SecurityPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('audit.gatewayPreparing')).toBeInTheDocument();
    expect(screen.queryByText('audit.gatewayStopped')).not.toBeInTheDocument();
  });
});
