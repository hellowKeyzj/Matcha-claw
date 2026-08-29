import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runtimeEndpointBadgeVariant,
  runtimeEndpointStatusLabel,
  useRuntimeEndpointsStore,
} from '@/stores/runtime-endpoints';
import type { RuntimeEndpointSummary } from '@/types/runtime-topology';

const hostRuntimeEndpointsListMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostRuntimeEndpointsList: (...args: unknown[]) => hostRuntimeEndpointsListMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: vi.fn(() => () => {}),
}));

function buildEndpoint(overrides: Partial<RuntimeEndpointSummary> = {}): RuntimeEndpointSummary {
  return {
    id: 'matcha-agent-local',
    protocolId: 'matcha-agent',
    runtimeAdapterId: 'matcha-agent',
    runtimeInstanceId: 'local',
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
    location: { kind: 'local' },
    lifecycle: {
      phase: 'ready',
      connected: true,
      ready: true,
      updatedAt: null,
    },
    displayName: 'Matcha Agent',
    agentIds: ['matcha'],
    defaultAgentId: 'matcha',
    agents: [],
    acceptsDynamicAgents: false,
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      approvals: true,
      replay: true,
      modelSelection: true,
    },
    capabilityFamilies: [{ family: 'session', availability: 'supported' }],
    controlState: {
      connection: null,
      readiness: { ready: true, phase: 'ready' },
      capabilities: null,
      updatedAt: null,
    },
    ...overrides,
  };
}

describe('runtime endpoints store', () => {
  beforeEach(() => {
    hostRuntimeEndpointsListMock.mockReset();
    useRuntimeEndpointsStore.setState({
      status: 'idle',
      error: null,
      endpoints: [],
      hasLoadedOnce: false,
    });
  });

  it('keeps previous endpoints while the directory is starting', async () => {
    const endpoint = buildEndpoint();
    useRuntimeEndpointsStore.setState({
      status: 'ready',
      error: null,
      endpoints: [endpoint],
      hasLoadedOnce: true,
    });
    hostRuntimeEndpointsListMock.mockRejectedValueOnce(new Error('Runtime endpoint directory is unavailable'));

    await useRuntimeEndpointsStore.getState().refresh();

    expect(useRuntimeEndpointsStore.getState()).toMatchObject({
      status: 'loading',
      error: null,
      endpoints: [endpoint],
      hasLoadedOnce: true,
    });
  });

  it('treats Host API proxy startup failures as pending directory reads', async () => {
    hostRuntimeEndpointsListMock.mockRejectedValueOnce(
      Object.assign(new Error('Host API request is unavailable.'), { code: 'UNAVAILABLE' }),
    );

    await useRuntimeEndpointsStore.getState().refresh();

    expect(useRuntimeEndpointsStore.getState()).toMatchObject({
      status: 'loading',
      error: null,
      endpoints: [],
      hasLoadedOnce: false,
    });
  });

  it('labels each runtime endpoint from its own readiness', () => {
    const ready = buildEndpoint();
    const starting = buildEndpoint({
      lifecycle: { phase: 'connecting', connected: true, ready: false, updatedAt: null },
      controlState: {
        connection: null,
        readiness: { ready: false, phase: 'starting', retryable: true },
        capabilities: null,
        updatedAt: null,
      },
    });

    expect(runtimeEndpointStatusLabel(ready)).toBe('running');
    expect(runtimeEndpointBadgeVariant(ready)).toBe('success');
    expect(runtimeEndpointStatusLabel(starting)).toBe('starting');
    expect(runtimeEndpointBadgeVariant(starting)).toBe('outline');
  });
});
