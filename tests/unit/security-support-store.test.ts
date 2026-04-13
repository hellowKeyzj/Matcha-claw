import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();
const hostSecurityFetchRuleCatalogMock = vi.fn();
const hostSecurityReadAuditMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/security-runtime', () => ({
  hostSecurityFetchRuleCatalog: (...args: unknown[]) => hostSecurityFetchRuleCatalogMock(...args),
  hostSecurityReadAudit: (...args: unknown[]) => hostSecurityReadAuditMock(...args),
}));

describe('security support store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
    hostSecurityFetchRuleCatalogMock.mockReset();
    hostSecurityReadAuditMock.mockReset();
  });

  it('loadPlatformTools 会标准化并按启用状态排序', async () => {
    hostApiFetchMock.mockResolvedValue({
      success: true,
      tools: [
        { id: 'http.request', enabled: false, source: 'native' },
        { id: 'system.run', enabled: true, source: 'native' },
        { id: '  fs.read  ', enabled: true, source: 'builtin' },
      ],
    });
    const { useSecuritySupportStore } = await import('@/stores/security-support-store');

    await useSecuritySupportStore.getState().loadPlatformTools({ refresh: true });

    const state = useSecuritySupportStore.getState();
    expect(state.platformToolsHydrated).toBe(true);
    expect(state.loadingPlatformTools).toBe(false);
    expect(state.platformTools.map((tool) => tool.id)).toEqual(['fs.read', 'system.run', 'http.request']);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/platform/tools?includeDisabled=true&refresh=true');
  });

  it('loadRuleCatalog 会过滤非法项并保留支持平台', async () => {
    hostSecurityFetchRuleCatalogMock.mockResolvedValue({
      success: true,
      items: [
        { platform: 'linux', command: 'rm -rf /tmp', category: 'filesystem', severity: 'high', reason: 'x' },
        { platform: 'unknown', command: 'bad', category: 'x', severity: 'low', reason: 'x' },
        { platform: 'windows', command: 'del /s', category: 'filesystem', severity: 'critical', reason: 'x' },
      ],
    });
    const { useSecuritySupportStore } = await import('@/stores/security-support-store');

    await useSecuritySupportStore.getState().loadRuleCatalog();

    const state = useSecuritySupportStore.getState();
    expect(state.loadingRuleCatalog).toBe(false);
    expect(state.ruleCatalog).toHaveLength(2);
    expect(state.ruleCatalog.map((item) => item.platform)).toEqual(['linux', 'windows']);
  });

  it('loadRecentAudits 失败时保留旧数据', async () => {
    hostSecurityReadAuditMock.mockResolvedValueOnce({
      items: [{ ts: 1, toolName: 'system.run', risk: 'high', action: 'block', decision: 'deny' }],
    });
    const { useSecuritySupportStore } = await import('@/stores/security-support-store');
    await useSecuritySupportStore.getState().loadRecentAudits({ gatewayState: 'running' });

    hostSecurityReadAuditMock.mockRejectedValueOnce(new Error('network down'));
    await useSecuritySupportStore.getState().loadRecentAudits({ gatewayState: 'running' });

    const state = useSecuritySupportStore.getState();
    expect(state.auditItems).toHaveLength(1);
    expect(state.loadingAudit).toBe(false);
  });

  it('支持 action-center 与 UI 选择态更新', async () => {
    const { useSecuritySupportStore } = await import('@/stores/security-support-store');

    useSecuritySupportStore.getState().setActiveSection('actionCenter');
    useSecuritySupportStore.getState().setAllowlistRegexTab('secretPatterns');
    useSecuritySupportStore.getState().setRuleCatalogPlatform('linux');
    useSecuritySupportStore.getState().setSecurityOpBusy('quick_audit');
    useSecuritySupportStore.getState().setSecurityOpResult('ok');
    useSecuritySupportStore.getState().setRemediationActions([
      { id: 'r-1', title: 'A', description: 'D', risk: 'high' },
      { id: 'r-2', title: 'B', description: 'E', risk: 'low' },
    ]);
    useSecuritySupportStore.getState().setSelectedRemediationActions((prev) => prev.filter((id) => id !== 'r-2'));
    useSecuritySupportStore.getState().setLastRemediationSnapshotId('snap-1');

    const state = useSecuritySupportStore.getState();
    expect(state.activeSection).toBe('actionCenter');
    expect(state.allowlistRegexTab).toBe('secretPatterns');
    expect(state.ruleCatalogPlatform).toBe('linux');
    expect(state.securityOpBusy).toBe('quick_audit');
    expect(state.securityOpResult).toBe('ok');
    expect(state.selectedRemediationActions).toEqual(['r-1']);
    expect(state.lastRemediationSnapshotId).toBe('snap-1');
  });
});
