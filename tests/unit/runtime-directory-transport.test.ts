import { describe, expect, it, vi } from 'vitest';
import { createRuntimeEndpointDirectoryTransport } from '../../electron/main/runtime-host-delivery/transport/runtime-directory';

const openClawCapabilityFamilies = [
  { family: 'session', availability: 'supported' },
  { family: 'task', availability: 'supported' },
  { family: 'subagent', availability: 'supported' },
  { family: 'team', availability: 'supported' },
  { family: 'cron', availability: 'supported' },
  { family: 'workspace', availability: 'supported' },
  { family: 'skill', availability: 'supported' },
  { family: 'channel', availability: 'supported' },
  { family: 'lifecycle', availability: 'supported' },
] as const;

const matchaCapabilityFamilies = [
  { family: 'session', availability: 'supported' },
  { family: 'task', availability: 'unsupported' },
  { family: 'subagent', availability: 'unsupported' },
  { family: 'team', availability: 'supported' },
  { family: 'cron', availability: 'unsupported' },
  { family: 'workspace', availability: 'unsupported' },
  { family: 'skill', availability: 'unsupported' },
  { family: 'channel', availability: 'unsupported' },
  { family: 'lifecycle', availability: 'supported' },
] as const;

const endpoint = {
  id: 'openclaw-local',
  protocolId: 'openclaw-v4',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  endpointRef: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  source: {
    kind: 'runtime-adapter',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  location: { kind: 'local' },
  lifecycle: {
    phase: 'ready',
    connected: true,
    ready: true,
    updatedAt: null,
  },
  displayName: 'OpenClaw',
  agentIds: ['main'],
  defaultAgentId: 'main',
  agents: [{
    agentId: 'main',
    source: 'discovered',
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      approvals: true,
      replay: true,
      modelSelection: true,
    },
  }],
  acceptsDynamicAgents: true,
  capabilities: {
    chat: true,
    streaming: true,
    tools: true,
    approvals: true,
    replay: true,
    modelSelection: true,
  },
  capabilityFamilies: openClawCapabilityFamilies,
  controlState: {
    connection: null,
    readiness: { ready: true, phase: 'ready' },
    capabilities: null,
    updatedAt: null,
  },
} as const;

const matchaEndpoint = {
  ...endpoint,
  id: 'matcha-agent-local',
  protocolId: 'matcha-agent-app-server',
  runtimeAdapterId: 'matcha-agent',
  endpointRef: {
    kind: 'native-runtime',
    runtimeAdapterId: 'matcha-agent',
    runtimeInstanceId: 'local',
  },
  source: {
    kind: 'runtime-adapter',
    runtimeAdapterId: 'matcha-agent',
    runtimeInstanceId: 'local',
  },
  displayName: 'Matcha Agent',
  agentIds: ['matcha'],
  defaultAgentId: 'matcha',
  agents: [{
    agentId: 'matcha',
    source: 'discovered',
    capabilities: endpoint.capabilities,
  }],
  capabilityFamilies: matchaCapabilityFamilies,
} as const;

const issuer = {
  verificationKey: 'public',
  signDecision: vi.fn().mockReturnValue('signed-decision'),
};

describe('Electron Main runtime endpoint directory transport', () => {
  it('signs the fixed directory request and accepts both fixed peer projections', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ endpoints: [endpoint, matchaEndpoint] }),
    });
    const transport = createRuntimeEndpointDirectoryTransport(issuer, 34_101, fetcher);

    await expect(transport.list()).resolves.toEqual({
      status: 200,
      body: { endpoints: [endpoint, matchaEndpoint] },
    });
    expect(issuer.signDecision).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'electron-main-local',
      endpoint: '/api/runtime-endpoints/list',
      scope: 'runtime:endpoints:read',
      capability: 'runtime.endpoints.directory',
      subject: 'runtime-endpoint-directory',
      revision: '1',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34101/api/runtime-endpoints/list',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer signed-decision',
          'Content-Length': '0',
        },
      }),
    );
  });

  it('signs the platform tools catalog request and accepts the public projection only', async () => {
    const tools = [{
      id: 'shell',
      name: 'Shell',
      source: 'native',
      enabled: true,
      description: 'Run shell commands',
    }];
    const localIssuer = {
      verificationKey: 'public',
      signDecision: vi.fn().mockReturnValue('signed-tools-decision'),
    };
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ success: true, tools }),
    });
    const transport = createRuntimeEndpointDirectoryTransport(localIssuer, 34_101, fetcher);

    await expect(transport.listPlatformTools()).resolves.toEqual({
      status: 200,
      body: { success: true, tools },
    });
    expect(localIssuer.signDecision).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'electron-main-local',
      endpoint: '/api/platform/tools',
      scope: 'platform:tools:read',
      capability: 'platform.tools.list',
      subject: 'platform-tools',
      revision: '1',
    }));
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:34101/api/platform/tools',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer signed-tools-decision',
          'Content-Length': '0',
        },
      }),
    );
  });

  it.each([
    { success: true, tools: [{ id: 'shell', name: 'Shell', source: 'native', enabled: true, pluginId: 'private' }] },
    { success: true, tools: [{ id: '', name: 'Shell', source: 'native', enabled: true }] },
    { success: true, tools: [{ id: 'shell', name: 'Shell', source: 'native' }] },
    { success: true, tools: [{ id: 'shell', name: 'Shell', source: 'native', enabled: true, metadata: { private: true } }] },
  ])('fails closed on an unsafe platform tools projection', async (body) => {
    const transport = createRuntimeEndpointDirectoryTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    const response = await transport.listPlatformTools();
    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Platform tools catalog is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('private');
  });

  it.each([
    { endpoints: [{ ...endpoint, privateToken: 'secret' }] },
    { endpoints: [{ ...endpoint, location: { kind: 'remote' } }] },
    { endpoints: [{ ...endpoint, lifecycle: { ...endpoint.lifecycle, error: 'private' } }] },
    { endpoints: [{ ...endpoint, controlState: { ...endpoint.controlState, updatedAt: 42 } }] },
    { endpoints: [{ ...endpoint, defaultAgentId: 'other' }] },
    { endpoints: [{ ...endpoint, capabilityFamilies: openClawCapabilityFamilies.slice(0, 7) }] },
    { endpoints: [{ ...endpoint, capabilityFamilies: [{ ...openClawCapabilityFamilies[0], availability: 'unsupported' }, ...openClawCapabilityFamilies.slice(1)] }] },
    { endpoints: [{ ...endpoint, capabilityFamilies: [...openClawCapabilityFamilies, { family: 'extra', availability: 'supported' }] }] },
    { endpoints: [{ ...endpoint, capabilitySummaries: [] }] },
    { endpoints: [{ ...endpoint, endpointRef: { ...endpoint.endpointRef, runtimeAdapterId: 'matcha-agent' } }] },
    { endpoints: [] },
    { endpoints: [endpoint] },
    { endpoints: [matchaEndpoint, endpoint] },
    { endpoints: [endpoint, { ...endpoint, id: 'unexpected-peer' }] },
    { endpoints: [endpoint, endpoint] },
  ])('fails closed on an unsafe response projection', async (body) => {
    const transport = createRuntimeEndpointDirectoryTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    const response = await transport.list();
    expect(response).toEqual({
      status: 503,
      body: { success: false, error: 'Runtime endpoint directory is unavailable' },
    });
    expect(JSON.stringify(response)).not.toContain('secret');
  });

  it('redacts transport failures and unexpected statuses', async () => {
    const transport = createRuntimeEndpointDirectoryTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockRejectedValue(new Error('private native transport detail')),
    );

    await expect(transport.list()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Runtime endpoint directory is unavailable' },
    });

    const unexpected = createRuntimeEndpointDirectoryTransport(
      { verificationKey: 'public', signDecision: () => 'signed-decision' },
      34_101,
      vi.fn().mockResolvedValue({ status: 401, json: async () => ({ success: false, error: 'private' }) }),
    );
    await expect(unexpected.list()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Runtime endpoint directory is unavailable' },
    });
  });
});
