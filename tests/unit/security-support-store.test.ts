import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostSecurityFetchRuleCatalogMock = vi.fn();
const hostSecurityReadAuditMock = vi.fn();

vi.mock('@/lib/security-runtime', () => ({
  hostSecurityFetchRuleCatalog: (...args: unknown[]) => hostSecurityFetchRuleCatalogMock(...args),
  hostSecurityReadAudit: (...args: unknown[]) => hostSecurityReadAuditMock(...args),
}));

describe('security support store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostSecurityFetchRuleCatalogMock.mockReset();
    hostSecurityReadAuditMock.mockReset();
  });

  it('loadRuleCatalog filters malformed items and retains supported platforms', async () => {
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
    expect(hostSecurityFetchRuleCatalogMock).toHaveBeenCalledOnce();
  });

  it('loads bounded audit projections into state and forwards the page parameters', async () => {
    const items = [{
      ts: 1_725_000_000_000,
      toolName: 'shell.exec',
      risk: 'high',
      action: 'block',
      decision: 'rule-match',
      ruleId: 'destructive.shell',
    }];
    hostSecurityReadAuditMock.mockResolvedValue({ items });
    const { useSecuritySupportStore } = await import('@/stores/security-support-store');

    await useSecuritySupportStore.getState().loadRecentAudits({
      gatewayProcessState: 'running',
      page: 2,
      pageSize: 8,
    });

    const state = useSecuritySupportStore.getState();
    expect(hostSecurityReadAuditMock).toHaveBeenCalledWith({ page: 2, pageSize: 8 });
    expect(state.auditItems).toEqual(items);
    expect(state.loadingAudit).toBe(false);
    expect(state.auditError).toBeNull();
    expect(state.auditStale).toBe(false);
  });

  it('does not query audit state while the gateway is stopped and clears stale items', async () => {
    const { useSecuritySupportStore } = await import('@/stores/security-support-store');
    useSecuritySupportStore.setState({
      auditItems: [{ ts: 1, toolName: 'shell.exec', risk: 'high', action: 'block', decision: 'deny' }],
      auditError: 'old error',
      auditStale: true,
    });

    await useSecuritySupportStore.getState().loadRecentAudits({ gatewayProcessState: 'stopped' });

    const state = useSecuritySupportStore.getState();
    expect(hostSecurityReadAuditMock).not.toHaveBeenCalled();
    expect(state.auditItems).toEqual([]);
    expect(state.auditError).toBeNull();
    expect(state.auditStale).toBe(false);
  });

  it('clears audit state and records an unavailable error when the read fails', async () => {
    hostSecurityReadAuditMock.mockRejectedValue(new Error('audit unavailable'));
    const { useSecuritySupportStore } = await import('@/stores/security-support-store');

    await useSecuritySupportStore.getState().loadRecentAudits({ gatewayProcessState: 'running' });

    const state = useSecuritySupportStore.getState();
    expect(state.auditItems).toEqual([]);
    expect(state.loadingAudit).toBe(false);
    expect(state.auditError).toBe('audit unavailable');
    expect(state.auditStale).toBe(true);
  });

  it('only changes live UI state for policy, remediation, and emergency actions', async () => {
    const { useSecuritySupportStore } = await import('@/stores/security-support-store');

    useSecuritySupportStore.getState().setActiveSection('actionCenter');
    useSecuritySupportStore.getState().setAllowlistRegexTab('secretPatterns');
    useSecuritySupportStore.getState().setSecurityOpBusy('emergency');
    useSecuritySupportStore.getState().setSecurityOpResult('outcome_unknown');
    useSecuritySupportStore.getState().setRemediationActions([
      { id: 'r-1', title: 'A', description: 'D', risk: 'high' },
      { id: 'r-2', title: 'B', description: 'E', risk: 'low' },
    ]);
    useSecuritySupportStore.getState().setSelectedRemediationActions((prev) => prev.filter((id) => id !== 'r-2'));
    useSecuritySupportStore.getState().setLastRemediationSnapshotId('snap-1');

    const state = useSecuritySupportStore.getState();
    expect(state.activeSection).toBe('actionCenter');
    expect(state.allowlistRegexTab).toBe('secretPatterns');
    expect(state.securityOpBusy).toBe('emergency');
    expect(state.securityOpResult).toBe('outcome_unknown');
    expect(state.selectedRemediationActions).toEqual(['r-1']);
    expect(state.lastRemediationSnapshotId).toBe('snap-1');
  });
});
