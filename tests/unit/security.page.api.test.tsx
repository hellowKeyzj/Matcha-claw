import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, waitFor } from '@testing-library/react';
import { SecurityPage } from '@/pages/Security';

const hostApiFetchMock = vi.fn();
const gatewayRpcMock = vi.fn();
const loadAgentsMock = vi.fn(async () => {});

const subagentsState = {
  agents: [{ id: 'main', name: 'Main Agent' }],
  loadAgents: loadAgentsMock,
};

const gatewayState = {
  status: { state: 'running' as const },
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
});
