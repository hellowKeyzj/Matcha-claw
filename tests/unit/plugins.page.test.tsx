import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

function buildCatalogPayload() {
  return {
    plugins: [{
      runtime: 'openclaw',
      id: 'plugin-a',
      name: 'Plugin A',
      version: '1.0.0',
      kind: 'builtin',
      platform: 'openclaw',
      enabled: true,
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
      if (path === '/api/plugins/catalog') return buildCatalogPayload();
      if (path === '/api/plugins/configuration') return { outcome: 'configured' };
      if (path === '/api/plugins/operation') return { outcome: 'configured' };
      throw new Error(`Unexpected path: ${path}`);
    });
  });

  it('renders the catalog table with metadata after its independent load', async () => {
    const { PluginsPage } = await import('@/pages/Plugins');
    let resolveCatalog: ((value: ReturnType<typeof buildCatalogPayload>) => void) | undefined;
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') return buildRuntimePayload();
      if (path === '/api/plugins/catalog') {
        return await new Promise((resolve) => { resolveCatalog = resolve; });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    render(<MemoryRouter><PluginsPage /></MemoryRouter>);

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
    const { PluginsPage } = await import('@/pages/Plugins');
    render(<MemoryRouter><PluginsPage /></MemoryRouter>);

    const pluginSwitch = await screen.findByRole('switch');
    expect(pluginSwitch).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Uninstall' })).not.toBeInTheDocument();
  });

  it('configures a plugin through the fixed endpoint', async () => {
    const { PluginsPage } = await import('@/pages/Plugins');
    render(<MemoryRouter><PluginsPage /></MemoryRouter>);

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
