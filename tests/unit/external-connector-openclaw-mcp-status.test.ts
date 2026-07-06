import { describe, expect, it } from 'vitest';
import { ExternalConnectorOpenClawMcpStatusProvider } from '../../runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-status';
import { OPENCLAW_MCP_SERVER_STATUS_REFRESH_JOB } from '../../runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-status-jobs';
import type { RuntimeJobSnapshot } from '../../runtime-host/application/common/runtime-contracts';
import type { ExternalConnectorSpec } from '../../runtime-host/application/external-connectors/external-connector-model';

const clock = {
  nowMs: () => 0,
  toIsoString: () => '2026-06-26T00:00:00.000Z',
};

const sessionIdentity = {
  endpoint: { kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
  agentId: 'agent-1',
  sessionKey: 'session-1',
};

const gatewayCapabilities = {
  methods: ['mcpServerStatus/list'],
  updatedAt: 0,
};

type SubmittedJob = RuntimeJobSnapshot & {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  result?: unknown;
};

function createJobPort() {
  let nextId = 1;
  const jobsByDedupeKey = new Map<string, SubmittedJob>();
  return {
    submitCalls: [] as Array<{ type: string; payload: unknown; options: unknown }>,
    submitMcpServerStatusRefresh(payload: { sessionKey: string }) {
      const type = OPENCLAW_MCP_SERVER_STATUS_REFRESH_JOB;
      const options = { dedupeKey: `${type}:${payload.sessionKey}` };
      this.submitCalls.push({ type, payload, options });
      const dedupeKey = options.dedupeKey;
      const existing = jobsByDedupeKey.get(dedupeKey);
      if (existing && (existing.status === 'queued' || existing.status === 'running' || existing.status === 'succeeded')) {
        return { success: true as const, job: existing };
      }
      const job: SubmittedJob = {
        id: `job-${nextId++}`,
        type,
        queue: 'low',
        status: 'queued',
        queuedAt: 0,
        attempts: 0,
        maxAttempts: 1,
      };
      jobsByDedupeKey.set(dedupeKey, job);
      return { success: true as const, job };
    },
    complete(jobId: string, result: unknown) {
      for (const job of jobsByDedupeKey.values()) {
        if (job.id === jobId) {
          job.status = 'succeeded';
          job.result = result;
          return;
        }
      }
    },
  };
}

describe('ExternalConnectorOpenClawMcpStatusProvider', () => {
  it('marks OpenClaw projected MCP connectors connected only when the refresh runtime job returns the projected server', async () => {
    const jobs = createJobPort();
    const connectors: ExternalConnectorSpec[] = [
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
      { id: 'plain-cli', kind: 'cli', command: 'gh' },
    ];
    const provider = new ExternalConnectorOpenClawMcpStatusProvider({
      clock,
      jobs,
      gateway: {
        readGatewayCapabilities: async () => gatewayCapabilities,
        gatewayRpc: async (_method, params) => {
          expect(params).toMatchObject({ sessionKey: 'session-1' });
          return {
            data: [{ name: 'docs', tools: [{ name: 'search' }, { name: 'read' }] }],
          };
        },
      },
    });

    await expect(provider.listStatuses(connectors, { sessionIdentity })).resolves.toEqual([
      {
        connectorId: 'docs',
        adapterId: 'openclaw',
        targetKind: 'session',
        resultType: 'pending',
        checkedAt: '2026-06-26T00:00:00.000Z',
        reason: 'OpenClaw MCP status refresh is running in the background',
        details: {
          serverId: 'docs',
          sessionKey: 'session-1',
          refreshJobId: 'job-1',
        },
      },
      {
        connectorId: 'plain-cli',
        adapterId: 'openclaw',
        targetKind: 'session',
        resultType: 'unsupported',
        checkedAt: '2026-06-26T00:00:00.000Z',
        reason: 'cli connectors are Matcha-owned and cannot be projected to OpenClaw MCP config directly',
        details: { sessionKey: 'session-1' },
      },
    ]);
    expect(jobs.submitCalls[0]).toMatchObject({
      type: OPENCLAW_MCP_SERVER_STATUS_REFRESH_JOB,
      payload: { sessionKey: 'session-1' },
    });

    jobs.complete('job-1', await provider.refreshOpenClawMcpServerStatusesForJob({ sessionKey: 'session-1' }));

    await expect(provider.listStatuses(connectors, { sessionIdentity })).resolves.toEqual([
      {
        connectorId: 'docs',
        adapterId: 'openclaw',
        targetKind: 'session',
        resultType: 'connected',
        checkedAt: '2026-06-26T00:00:00.000Z',
        reason: 'OpenClaw MCP status reported the server as available',
        details: {
          serverId: 'docs',
          sessionKey: 'session-1',
          toolCount: 2,
        },
      },
      {
        connectorId: 'plain-cli',
        adapterId: 'openclaw',
        targetKind: 'session',
        resultType: 'unsupported',
        checkedAt: '2026-06-26T00:00:00.000Z',
        reason: 'cli connectors are Matcha-owned and cannot be projected to OpenClaw MCP config directly',
        details: { sessionKey: 'session-1' },
      },
    ]);
  });

  it('uses the runtime endpoint session id for OpenClaw MCP status while preserving the local session identity in UI details', async () => {
    const jobs = createJobPort();
    const gatewayRpcCalls: unknown[] = [];
    const teamSessionIdentity = {
      endpoint: { kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
      agentId: 'leader',
      sessionKey: 'team-role-session-1',
    };
    const provider = new ExternalConnectorOpenClawMcpStatusProvider({
      clock,
      jobs,
      gateway: {
        readGatewayCapabilities: async () => gatewayCapabilities,
        gatewayRpc: async (_method, params) => {
          gatewayRpcCalls.push(params);
          return { data: [{ name: 'docs', tools: [{ name: 'search' }] }] };
        },
      },
    });

    await expect(provider.listStatuses([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ], {
      sessionIdentity: teamSessionIdentity,
      endpointSessionId: 'team-endpoint-session-1',
    })).resolves.toMatchObject([
      {
        connectorId: 'docs',
        resultType: 'pending',
        details: {
          sessionKey: 'team-role-session-1',
          refreshJobId: 'job-1',
        },
      },
    ]);
    expect(jobs.submitCalls[0]).toMatchObject({
      type: OPENCLAW_MCP_SERVER_STATUS_REFRESH_JOB,
      payload: { sessionKey: 'team-endpoint-session-1' },
    });

    jobs.complete('job-1', await provider.refreshOpenClawMcpServerStatusesForJob({ sessionKey: 'team-endpoint-session-1' }));
    expect(gatewayRpcCalls[0]).toMatchObject({ sessionKey: 'team-endpoint-session-1' });

    await expect(provider.listStatuses([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ], {
      sessionIdentity: teamSessionIdentity,
      endpointSessionId: 'team-endpoint-session-1',
    })).resolves.toMatchObject([
      {
        connectorId: 'docs',
        resultType: 'connected',
        details: {
          serverId: 'docs',
          sessionKey: 'team-role-session-1',
          toolCount: 1,
        },
      },
    ]);
  });

  it('does not submit OpenClaw MCP status refresh jobs for Team role local sessions without endpoint ids', async () => {
    const jobs = createJobPort();
    const gatewayRpcCalls: unknown[] = [];
    const provider = new ExternalConnectorOpenClawMcpStatusProvider({
      clock,
      jobs,
      gateway: {
        readGatewayCapabilities: async () => gatewayCapabilities,
        gatewayRpc: async (_method, params) => {
          gatewayRpcCalls.push(params);
          return { data: [{ name: 'docs', tools: [{ name: 'search' }] }] };
        },
      },
    });

    await expect(provider.listStatuses([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ], {
      sessionIdentity: {
        endpoint: { kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
        agentId: 'leader',
        sessionKey: 'team-role-session-1',
      },
    })).resolves.toEqual([
      {
        connectorId: 'docs',
        adapterId: 'openclaw',
        targetKind: 'session',
        resultType: 'unknown',
        checkedAt: '2026-06-26T00:00:00.000Z',
        reason: 'OpenClaw MCP status requires an endpoint session id for Team role sessions',
        details: {
          serverId: 'docs',
          sessionKey: 'team-role-session-1',
        },
      },
    ]);
    expect(jobs.submitCalls).toHaveLength(0);
    expect(gatewayRpcCalls).toHaveLength(0);
  });

  it('marks projected MCP connectors disconnected after the refresh runtime job omits the projected server', async () => {
    const jobs = createJobPort();
    const provider = new ExternalConnectorOpenClawMcpStatusProvider({
      clock,
      jobs,
      gateway: {
        readGatewayCapabilities: async () => gatewayCapabilities,
        gatewayRpc: async () => ({ data: [] }),
      },
    });

    await expect(provider.listStatuses([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ], { sessionIdentity })).resolves.toMatchObject([
      {
        connectorId: 'docs',
        resultType: 'pending',
        reason: 'OpenClaw MCP status refresh is running in the background',
        details: { refreshJobId: 'job-1' },
      },
    ]);

    jobs.complete('job-1', await provider.refreshOpenClawMcpServerStatusesForJob({ sessionKey: 'session-1' }));

    await expect(provider.listStatuses([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ], { sessionIdentity })).resolves.toMatchObject([
      {
        connectorId: 'docs',
        resultType: 'disconnected',
        reason: 'OpenClaw MCP status listing succeeded but did not include the projected server for this connector',
        details: { serverId: 'docs', sessionKey: 'session-1' },
      },
    ]);
  });

  it('does not call unsupported OpenClaw gateway MCP status methods from the refresh runtime job', async () => {
    const jobs = createJobPort();
    let gatewayRpcCalled = false;
    const provider = new ExternalConnectorOpenClawMcpStatusProvider({
      clock,
      jobs,
      gateway: {
        readGatewayCapabilities: async () => ({ methods: ['chat.send'], updatedAt: 0 }),
        gatewayRpc: async () => {
          gatewayRpcCalled = true;
          return { data: [] };
        },
      },
    });

    await expect(provider.listStatuses([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ], { sessionIdentity })).resolves.toMatchObject([
      {
        connectorId: 'docs',
        resultType: 'pending',
        reason: 'OpenClaw MCP status refresh is running in the background',
      },
    ]);

    jobs.complete('job-1', await provider.refreshOpenClawMcpServerStatusesForJob({ sessionKey: 'session-1' }));

    await expect(provider.listStatuses([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ], { sessionIdentity })).resolves.toMatchObject([
      {
        connectorId: 'docs',
        resultType: 'unknown',
        reason: 'OpenClaw gateway does not expose MCP status for this adapter',
      },
    ]);
    expect(gatewayRpcCalled).toBe(false);
  });

  it('returns unknown instead of connected after the refresh runtime job reports OpenClaw MCP status unavailable', async () => {
    const jobs = createJobPort();
    const provider = new ExternalConnectorOpenClawMcpStatusProvider({
      clock,
      jobs,
      gateway: {
        readGatewayCapabilities: async () => gatewayCapabilities,
        gatewayRpc: async () => {
          throw new Error('unsupported');
        },
      },
    });

    await expect(provider.listStatuses([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ], { sessionIdentity })).resolves.toMatchObject([
      {
        connectorId: 'docs',
        resultType: 'pending',
        reason: 'OpenClaw MCP status refresh is running in the background',
      },
    ]);

    jobs.complete('job-1', await provider.refreshOpenClawMcpServerStatusesForJob({ sessionKey: 'session-1' }));

    await expect(provider.listStatuses([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ], { sessionIdentity })).resolves.toMatchObject([
      {
        connectorId: 'docs',
        resultType: 'unknown',
        reason: 'OpenClaw MCP status is unavailable for this session',
      },
    ]);
  });

  it('dedupes pending OpenClaw MCP status refresh runtime jobs per session', async () => {
    const jobs = createJobPort();
    const provider = new ExternalConnectorOpenClawMcpStatusProvider({
      clock,
      jobs,
      gateway: {
        readGatewayCapabilities: async () => gatewayCapabilities,
        gatewayRpc: async () => ({ data: [{ name: 'docs', tools: [] }] }),
      },
    });

    const first = provider.listStatuses([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ], { sessionIdentity });
    const second = provider.listStatuses([
      { id: 'docs', kind: 'mcp-http', url: 'https://mcp.example.com' },
    ], { sessionIdentity });

    await expect(first).resolves.toMatchObject([{ connectorId: 'docs', resultType: 'pending', details: { refreshJobId: 'job-1' } }]);
    await expect(second).resolves.toMatchObject([{ connectorId: 'docs', resultType: 'pending', details: { refreshJobId: 'job-1' } }]);
    expect(jobs.submitCalls).toHaveLength(2);
  });
});
