import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { runtimeInstanceScope, runtimeScopeQuery } from '@/types/desktop/runtime-address';
import type { RuntimeEndpointSummary } from '@/types/runtime-topology';

const hostApiFetchMock = vi.fn();
const scope = runtimeInstanceScope({ kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' });
const catalogPath = `/api/plugins/catalog?${runtimeScopeQuery(scope)}`;
const receipt = { callId: 'a'.repeat(32), accepted: true } as const;
const endpoint: RuntimeEndpointSummary = {
  id: 'openclaw-local',
  protocolId: 'openclaw',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  endpointRef: scope.endpoint,
  source: { kind: 'runtime-adapter', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' },
  location: { kind: 'local' },
  lifecycle: { phase: 'ready', connected: true, ready: true, updatedAt: null },
  displayName: 'OpenClaw',
  agentIds: ['main'],
  defaultAgentId: 'main',
  agents: [],
  acceptsDynamicAgents: false,
  capabilities: { chat: true, streaming: true, tools: true, approvals: true, replay: true, modelSelection: true, supportsGoal: false },
  capabilityFamilies: [{ family: 'session', availability: 'supported' }],
  controlState: { connection: null, readiness: { ready: true, phase: 'ready' }, capabilities: null, updatedAt: null },
};

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  hostApiFetchDecoded: async (path: string, decode: (value: unknown) => unknown, options: unknown) => (
    decode(await hostApiFetchMock(path, options))
  ),
  hostRuntimeEndpointsList: async () => ({ endpoints: [endpoint] }),
}));

async function mountPage() {
  const [{ createPluginHost }, { PluginHostProvider }, { applicationShellPlugin }, { agentsPlugin }, { nativePluginsPlugin }, { PluginsPage }] = await Promise.all([
    import('@/plugin-host/core'),
    import('@/plugin-host/react'),
    import('@/app/extensions'),
    import('@/plugins/agents/plugin'),
    import('@/plugins/native-plugins/plugin'),
    import('@/plugins/native-plugins/page'),
  ]);
  const host = createPluginHost([applicationShellPlugin, agentsPlugin, nativePluginsPlugin]);
  return render(<PluginHostProvider host={host}><MemoryRouter initialEntries={['/plugins']}><PluginsPage /></MemoryRouter></PluginHostProvider>);
}

function buildCatalogPayload() {
  return {
    success: true,
    execution: { enabledPluginIds: ['plugin-a'] },
    plugins: [{
      runtime: 'openclaw',
      id: 'plugin-a',
      name: 'Plugin A',
      version: '1.0.0',
      kind: 'builtin',
      platform: 'openclaw',
      enabled: true,
      installed: true,
      updateAvailable: false,
      companionSkillReady: true,
      description: 'Plugin description',
      companionSkillSlugs: ['skill-a', 'skill-b'],
    }],
  };
}

function buildRuntimePayload() {
  return {
    success: true,
    state: {
      lifecycle: 'running',
      runtimeLifecycle: 'running',
      activePluginCount: 1,
      enabledPluginIds: ['plugin-a'],
    },
    health: {
      ok: true,
      lifecycle: 'running',
      activePluginCount: 1,
      degradedPlugins: [],
    },
    execution: {
      enabledPluginIds: ['plugin-a'],
    },
  };
}

describe('plugins page', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') return buildRuntimePayload();
      if (path === catalogPath) return buildCatalogPayload();
      if (path === '/api/plugins/configuration') return receipt;
      if (path === '/api/calls/get') return {
        callId: receipt.callId, module: 'plugins', command: 'plugins.configuration', status: 'succeeded',
        start: 1, end: 2, revision: 1,
        detail: { kind: 'configuration', pluginId: 'plugin-a', enabled: false, outcome: 'configured' },
      };
      throw new Error(`Unexpected path: ${path}`);
    });
    const { useRuntimeEndpointsStore } = await import('@/stores/runtime-endpoints');
    await useRuntimeEndpointsStore.getState().refresh();
  });

  it('renders the catalog table with metadata after its independent load', async () => {
    let resolveCatalog: ((value: ReturnType<typeof buildCatalogPayload>) => void) | undefined;
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') return buildRuntimePayload();
      if (path === catalogPath) {
        return await new Promise((resolve) => { resolveCatalog = resolve; });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    await mountPage();

    expect(screen.queryByText('Runtime Status')).not.toBeInTheDocument();
    expect(screen.queryByText('Plugin A')).not.toBeInTheDocument();

    resolveCatalog?.(buildCatalogPayload());

    expect(await screen.findByText('Plugin A')).toBeInTheDocument();
    expect(screen.getByText('Plugin description')).toBeInTheDocument();
    expect(screen.getByText('OpenClaw')).toBeInTheDocument();
    expect(screen.getByText('Builtin')).toBeInTheDocument();
    expect(screen.getByText('1.0.0')).toBeInTheDocument();
    expect(screen.getByText(/skill-a, skill-b/)).toBeInTheDocument();
    expect(screen.queryByText('runtime')).not.toBeInTheDocument();
    expect(screen.queryByText('General')).not.toBeInTheDocument();
  });

  it('renders the catalog enable switch without exposing plugin operations', async () => {
    await mountPage();

    const pluginSwitch = await screen.findByRole('switch');
    expect(pluginSwitch).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Uninstall' })).not.toBeInTheDocument();
  });

  it('configures a plugin through the fixed endpoint', async () => {
    await mountPage();

    const pluginSwitch = await screen.findByRole('switch');
    fireEvent.click(pluginSwitch);

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/configuration', {
        method: 'POST',
        body: JSON.stringify({ runtime: 'openclaw', pluginId: 'plugin-a', enabled: false }),
      });
    });
  });
});
