import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SecurityPage } from '@/pages/Security';
import {
  hostSecurityApplyRemediation,
  hostSecurityCheckAdvisories,
  hostSecurityCheckIntegrity,
  hostSecurityPreviewRemediation,
  hostSecurityRebaselineIntegrity,
  hostSecurityRollbackRemediation,
  hostSecurityRunEmergencyResponse,
  hostSecurityRunQuickAudit,
  hostSecurityScanSkills,
  SECURITY_EMERGENCY_OUTCOME_UNKNOWN_MESSAGE,
  resolveSecurityEmergencyOutcome,
} from '@/lib/security-runtime';
import { useSecuritySupportStore } from '@/stores/security-support-store';

const { toastSuccessMock, toastErrorMock } = vi.hoisted(() => ({
  toastSuccessMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));

const hostApiFetchMock = vi.fn();
const loadAgentsMock = vi.fn(async () => {});
let emergencyResponse: unknown = { outcome: 'applied' };

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

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh' },
  }),
}));

const policy = {
  preset: 'balanced',
  securityPolicyVersion: 1,
  runtime: {
    runtimeGuardEnabled: true,
    auditOnGatewayStart: true,
    autoHarden: true,
    enablePromptInjectionGuard: true,
    blockDestructive: true,
    blockSecrets: true,
    monitors: { credentials: true, memory: true, cost: true },
    logging: { logDetections: true },
    allowPathPrefixes: [],
    allowDomains: [],
    auditEgressAllowlist: [],
    auditDailyCostLimitUsd: 1,
    auditFailureMode: 'safe_mode',
    promptInjectionPatterns: [],
    allowlist: { tools: [], sessions: [] },
    destructive: {
      action: 'confirm',
      severityActions: { critical: 'block', high: 'confirm', medium: 'warn', low: 'log' },
      categories: {
        fileDelete: true,
        gitDestructive: true,
        sqlDestructive: true,
        systemDestructive: true,
        processKill: true,
        networkDestructive: true,
        privilegeEscalation: true,
      },
    },
    secrets: {
      action: 'redact',
      severityActions: { critical: 'block', high: 'confirm', medium: 'warn', low: 'log' },
    },
    destructivePatterns: [],
    secretPatterns: [],
  },
};

function mountPage() {
  return render(<MemoryRouter><SecurityPage /></MemoryRouter>);
}

describe('SecurityPage API 接入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    gatewayState.isInitialized = true;
    gatewayState.status = {
      ...gatewayState.status,
      processState: 'running',
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
    };
    emergencyResponse = { outcome: 'applied' };
    useSecuritySupportStore.setState({
      activeSection: 'runtime',
      auditItems: [],
      loadingAudit: false,
      auditError: null,
      auditStale: false,
      ruleCatalog: [],
      loadingRuleCatalog: false,
      ruleCatalogError: null,
      securityOpBusy: null,
      securityOpResult: '',
      remediationActions: [],
      selectedRemediationActions: [],
      lastRemediationSnapshotId: null,
    });
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/security') return policy;
      if (path === '/api/security/audit?page=1&pageSize=8') {
        return { page: 1, pageSize: 8, total: 0, items: [] };
      }
      if (path === '/api/security/destructive-rule-catalog') {
        return { success: true, items: [] };
      }
      if (path === '/api/security/operation') return { outcome: 'applied' };
      if (path === '/api/security/emergency') return emergencyResponse;
      throw new Error(`unexpected path: ${path}`);
    });
  });

  it('页面加载通过 Host API 读取策略、审计和规则目录，不走旧 gateway RPC', async () => {
    mountPage();

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/security');
    });
    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/security/audit?page=1&pageSize=8');
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/security/destructive-rule-catalog');
    });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/platform/tools?includeDisabled=true');
  });

  it.each([
    ['applied', true],
    ['target_rejected', false],
    ['outcome_unknown', false],
  ] as const)('emergency sealed outcome %s 的成功判定为 %s', (outcome, expectedSuccess) => {
    expect(resolveSecurityEmergencyOutcome({ outcome }).outcome === 'applied').toBe(expectedSuccess);
  });

  it('页面通过 dedicated emergency route 发送空 envelope，并隐藏 native detail', async () => {
    emergencyResponse = { outcome: 'outcome_unknown', nativeDetail: 'private runtime detail' };
    useSecuritySupportStore.setState({ activeSection: 'actionCenter' });

    mountPage();
    fireEvent.click(screen.getByRole('button', { name: 'actionCenter.emergency' }));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(SECURITY_EMERGENCY_OUTCOME_UNKNOWN_MESSAGE);
    });
    const emergencyCall = hostApiFetchMock.mock.calls.find(([path]) => path === '/api/security/emergency');
    expect(emergencyCall?.[1]).toEqual({
      method: 'POST',
      body: '{}',
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(screen.getByText(`ERROR: ${SECURITY_EMERGENCY_OUTCOME_UNKNOWN_MESSAGE}`)).toBeInTheDocument();
    expect(screen.queryByText(/private runtime detail/)).not.toBeInTheDocument();
  });

  it('所有 non-emergency operation helper 都发送固定 operation envelope，emergency 使用专用 route', async () => {
    hostApiFetchMock.mockResolvedValue({ outcome: 'applied' });

    await hostSecurityRunQuickAudit();
    await hostSecurityRunEmergencyResponse();
    await hostSecurityCheckIntegrity();
    await hostSecurityRebaselineIntegrity();
    await hostSecurityScanSkills('C:\\scan');
    await hostSecurityCheckAdvisories('https://feed.example');
    await hostSecurityPreviewRemediation();
    await hostSecurityApplyRemediation(['action-a', 'action-b']);
    await hostSecurityRollbackRemediation('snapshot-1');

    const operationCalls = hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/security/operation');
    const emergencyCalls = hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/security/emergency');
    expect(emergencyCalls).toHaveLength(1);
    expect(emergencyCalls[0]?.[1]).toEqual({ method: 'POST', body: '{}' });
    expect(operationCalls).toHaveLength(8);
    expect(operationCalls.map(([, init]) => JSON.parse((init as { body: string }).body))).toEqual([
      {
        id: 'security.operation', operationId: 'security.quickAudit',
        scope: { kind: 'security-policy' }, target: { kind: 'security-policy' }, input: {},
      },
      {
        id: 'security.operation', operationId: 'security.checkIntegrity',
        scope: { kind: 'security-policy' }, target: { kind: 'security-policy' }, input: {},
      },
      {
        id: 'security.operation', operationId: 'security.rebaselineIntegrity',
        scope: { kind: 'security-policy' }, target: { kind: 'security-policy' }, input: {},
      },
      {
        id: 'security.operation', operationId: 'security.scanSkills',
        scope: { kind: 'security-policy' }, target: { kind: 'security-policy' }, input: { scanPath: 'C:\\scan' },
      },
      {
        id: 'security.operation', operationId: 'security.checkAdvisories',
        scope: { kind: 'security-policy' }, target: { kind: 'security-policy' }, input: { feedUrl: 'https://feed.example' },
      },
      {
        id: 'security.operation', operationId: 'security.previewRemediation',
        scope: { kind: 'security-remediation' }, target: { kind: 'security-remediation' }, input: {},
      },
      {
        id: 'security.operation', operationId: 'security.applyRemediation',
        scope: { kind: 'security-remediation' }, target: { kind: 'security-remediation' }, input: { actions: ['action-a', 'action-b'] },
      },
      {
        id: 'security.operation', operationId: 'security.rollbackRemediation',
        scope: { kind: 'security-remediation' }, target: { kind: 'security-remediation', snapshotId: 'snapshot-1' }, input: { snapshotId: 'snapshot-1' },
      },
    ]);
  });

  it('preserves explicit nullable and empty operation inputs', async () => {
    hostApiFetchMock.mockResolvedValue({});

    await hostSecurityCheckAdvisories(null);
    await hostSecurityCheckAdvisories();
    await hostSecurityApplyRemediation([]);
    await hostSecurityApplyRemediation();
    await hostSecurityRollbackRemediation(null);
    await hostSecurityRollbackRemediation();

    const operationBodies = hostApiFetchMock.mock.calls
      .filter(([path]) => path === '/api/security/operation')
      .map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(operationBodies).toEqual([
      {
        id: 'security.operation', operationId: 'security.checkAdvisories',
        scope: { kind: 'security-policy' }, target: { kind: 'security-policy' }, input: { feedUrl: null },
      },
      {
        id: 'security.operation', operationId: 'security.checkAdvisories',
        scope: { kind: 'security-policy' }, target: { kind: 'security-policy' }, input: {},
      },
      {
        id: 'security.operation', operationId: 'security.applyRemediation',
        scope: { kind: 'security-remediation' }, target: { kind: 'security-remediation' }, input: { actions: [] },
      },
      {
        id: 'security.operation', operationId: 'security.applyRemediation',
        scope: { kind: 'security-remediation' }, target: { kind: 'security-remediation' }, input: {},
      },
      {
        id: 'security.operation', operationId: 'security.rollbackRemediation',
        scope: { kind: 'security-remediation' }, target: { kind: 'security-remediation' }, input: { snapshotId: null },
      },
      {
        id: 'security.operation', operationId: 'security.rollbackRemediation',
        scope: { kind: 'security-remediation' }, target: { kind: 'security-remediation' }, input: {},
      },
    ]);
  });

  it('页面加载前审计区显示准备中，不显示停止文案', () => {
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

    mountPage();

    expect(screen.getByText('audit.gatewayPreparing')).toBeInTheDocument();
    expect(screen.queryByText('audit.gatewayStopped')).not.toBeInTheDocument();
  });
});
