import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import '@/i18n';
import { RemoteFleetPage } from '@/pages/RemoteFleet';
import { useRemoteFleetStore, type RemoteFleetState } from '@/stores/remote-fleet';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastWarningMock = vi.hoisted(() => vi.fn());
const terminalInstances = vi.hoisted(() => [] as Array<{
  open: ReturnType<typeof vi.fn>;
  loadAddon: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onResize: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  writeln: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  cols: number;
  rows: number;
  element?: HTMLElement;
}>);
const fitAddonInstances = vi.hoisted(() => [] as Array<{
  fit: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}>);
const resizeObserverInstances = vi.hoisted(() => [] as Array<{
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  trigger: () => void;
}>);
const websocketInstances = vi.hoisted(() => [] as Array<{
  url: string;
  binaryType: BinaryType;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  emit: (type: string, event: unknown) => void;
}>);

vi.mock('@/lib/host-api', () => ({
  resolveHostApiBase: async () => 'http://127.0.0.1:3917',
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
    warning: (...args: unknown[]) => toastWarningMock(...args),
  },
}));

vi.mock('@xterm/xterm', () => {
  function TerminalMock(this: unknown) {
    const instance = {
      open: vi.fn((element: HTMLElement) => {
        const terminalElement = document.createElement('div');
        element.appendChild(terminalElement);
        instance.element = terminalElement;
      }),
      loadAddon: vi.fn(),
      onData: vi.fn(),
      onResize: vi.fn(),
      clear: vi.fn(),
      focus: vi.fn(),
      write: vi.fn(),
      writeln: vi.fn(),
      dispose: vi.fn(),
      cols: 80,
      rows: 24,
      element: undefined as HTMLElement | undefined,
    };
    terminalInstances.push(instance);
    return instance;
  }
  return { Terminal: vi.fn(TerminalMock) };
});

vi.mock('@xterm/addon-fit', () => {
  function FitAddonMock(this: unknown) {
    const instance = {
      fit: vi.fn(),
      dispose: vi.fn(),
    };
    fitAddonInstances.push(instance);
    return instance;
  }
  return { FitAddon: vi.fn(FitAddonMock) };
});

vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class ResizeObserverStub {
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    resizeObserverInstances.push({
      observe: this.observe,
      disconnect: this.disconnect,
      trigger: () => callback([], this as unknown as ResizeObserver),
    });
  }
}

const sshConnection = {
  id: 'connection-ssh-1',
  displayName: 'SSH Bastion connection',
  connectionKind: 'ssh-host',
  targetKind: 'ssh-host',
  endpointUrl: 'ssh://ops@example.internal:22',
  status: 'online',
  labels: ['ssh'],
};

const vmConnection = {
  id: 'connection-vm-1',
  displayName: 'Build VM connection',
  connectionKind: 'vm',
  targetKind: 'vm',
  endpointUrl: 'ssh://build-vm-01.internal:22',
  status: 'online',
  labels: ['vm'],
};

const containerConnection = {
  id: 'connection-1',
  displayName: 'Docker Prod',
  connectionKind: 'container',
  targetKind: 'container',
  endpointUrl: 'https://docker.example.internal:2376',
  status: 'online',
  labels: ['container'],
  enabled: true,
  secretRefs: { dockerBearerToken: { kind: 'secret-ref', ref: 'secret-ref-should-not-render' } },
  publicConfig: { docker: { endpointUrl: 'https://docker.example.internal:2376', token: 'provider-token-should-not-render' } },
};

const sshEnvironment = {
  id: 'environment-ssh-1',
  connectionId: sshConnection.id,
  nodeId: 'ssh-node-1',
  displayName: 'SSH workspace',
  environmentKind: 'ssh-workdir',
  targetKind: 'ssh-host',
  status: 'environment-ready',
  labels: ['ssh'],
  managedResourceIds: ['managed-resource-ssh-1'],
};

const vmEnvironment = {
  id: 'environment-vm-1',
  connectionId: vmConnection.id,
  nodeId: 'vm-node-1',
  displayName: 'Build VM workspace',
  environmentKind: 'vm-workdir',
  targetKind: 'vm',
  status: 'environment-ready',
  labels: ['vm'],
  managedResourceIds: ['managed-resource-vm-1'],
};

const containerEnvironment = {
  id: 'environment-1',
  connectionId: containerConnection.id,
  nodeId: 'container-node-1',
  displayName: 'Debian environment',
  environmentKind: 'docker-container',
  targetKind: 'container',
  status: 'environment-ready',
  labels: ['container'],
  managedResourceIds: ['managed-resource-1'],
};

const sshManagedResource = {
  id: 'managed-resource-ssh-1',
  connectionId: sshConnection.id,
  environmentId: sshEnvironment.id,
  nodeId: 'ssh-node-1',
  providerKind: 'ssh',
  resourceKind: 'ssh-agent-installation',
  displayName: 'SSH agent installation',
  status: 'running',
  ownership: 'external',
  cleanupPolicy: 'retain',
};

const vmManagedResource = {
  id: 'managed-resource-vm-1',
  connectionId: vmConnection.id,
  environmentId: vmEnvironment.id,
  nodeId: 'vm-node-1',
  providerKind: 'vm',
  resourceKind: 'vm-agent-installation',
  displayName: 'VM agent installation',
  status: 'running',
  ownership: 'external',
  cleanupPolicy: 'retain',
};

const containerManagedResource = {
  id: 'managed-resource-1',
  connectionId: containerConnection.id,
  environmentId: containerEnvironment.id,
  nodeId: 'container-node-1',
  providerKind: 'docker',
  resourceKind: 'docker-container',
  remoteResourceId: 'matchaclaw-debian-node-1',
  displayName: 'Debian container',
  status: 'running',
  ownership: 'managed',
  cleanupPolicy: 'retain',
};

const sshNode = {
  id: 'ssh-node-1',
  connectionId: sshConnection.id,
  environmentId: sshEnvironment.id,
  managedResourceId: sshManagedResource.id,
  displayName: 'SSH Bastion',
  targetKind: 'ssh-host',
  endpointUrl: 'ssh://ops@example.internal:22',
  status: 'online',
  labels: ['ssh'],
};

const vmNode = {
  id: 'vm-node-1',
  connectionId: vmConnection.id,
  environmentId: vmEnvironment.id,
  managedResourceId: vmManagedResource.id,
  displayName: 'Build VM',
  targetKind: 'vm',
  endpointUrl: 'ssh://build-vm-01.internal:22',
  status: 'online',
  labels: ['vm'],
};

const containerNode = {
  id: 'container-node-1',
  connectionId: containerConnection.id,
  environmentId: containerEnvironment.id,
  managedResourceId: containerManagedResource.id,
  displayName: 'Debian runtime node',
  targetKind: 'container',
  endpointUrl: 'https://docker.example.internal:2376',
  status: 'online',
  labels: ['container'],
};

const snapshotProjection = {
  connections: [sshConnection, vmConnection, containerConnection],
  environments: [sshEnvironment, vmEnvironment, containerEnvironment],
  managedResources: [sshManagedResource, vmManagedResource, containerManagedResource],
  nodes: [sshNode, vmNode, containerNode],
  agents: [{ id: 'agent-1', nodeId: 'ssh-node-1', connectionId: sshConnection.id, environmentId: sshEnvironment.id, managedResourceId: sshManagedResource.id, status: 'enrolled' }],
  runtimes: [{ id: 'runtime-1', nodeId: 'ssh-node-1', agentId: 'agent-1', connectionId: sshConnection.id, environmentId: sshEnvironment.id, managedResourceId: sshManagedResource.id, status: 'running', endpointId: 'endpoint-1' }],
  endpoints: [{ id: 'endpoint-1', nodeId: 'ssh-node-1', runtimeId: 'runtime-1', connectionId: sshConnection.id, environmentId: sshEnvironment.id, managedResourceId: sshManagedResource.id, status: 'ready', protocol: 'ssh' }],
  capabilities: [{ id: 'capability-1', nodeId: 'ssh-node-1', runtimeId: 'runtime-1', endpointId: 'endpoint-1', connectionId: sshConnection.id, environmentId: sshEnvironment.id, managedResourceId: sshManagedResource.id, operationIds: ['remoteFleet.runtime.start'], status: 'current' }],
  commands: [{ id: 'command-1', nodeId: 'ssh-node-1', runtimeId: 'runtime-1', endpointId: 'endpoint-1', connectionId: sshConnection.id, environmentId: sshEnvironment.id, managedResourceId: sshManagedResource.id, command: 'remoteFleet.runtime.start', status: 'succeeded' }],
  leases: [{ id: 'lease-1', endpointId: 'endpoint-1', ownerKind: 'runtime', ownerId: 'runtime-1', status: 'active' }],
  sessions: [],
  auditEvents: [{ id: 'audit-1', eventName: 'remoteFleet.command.succeeded', nodeId: 'ssh-node-1', runtimeId: 'runtime-1', endpointId: 'endpoint-1', connectionId: sshConnection.id, environmentId: sshEnvironment.id, managedResourceId: sshManagedResource.id, commandId: 'command-1', occurredAt: '2026-01-01T00:01:00.000Z' }],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const metricsProjection = {
  nodes: { totalCount: 3, countByStatus: { online: 3 }, countByTargetKind: { 'ssh-host': 1, vm: 1, container: 1 } },
  agents: { totalCount: 1, countByStatus: { enrolled: 1 } },
  runtimes: { totalCount: 1, countByStatus: { running: 1 }, countByRuntimeKind: { openclaw: 1 } },
  endpoints: { totalCount: 1, countByStatus: { ready: 1 }, drainingEndpoints: [], retiredEndpoints: [] },
  capabilities: { totalCount: 1, countByStatus: { current: 1 }, staleCount: 0 },
  commands: { totalCount: 1, countByStatus: { succeeded: 1 }, recentFailureCount: 0 },
  leases: { totalCount: 1, countByStatus: { active: 1 }, activeCount: 1 },
  auditEvents: { totalCount: 1, countByEventName: { 'remoteFleet.command.succeeded': 1 } },
};

function resetRemoteFleetStore() {
  act(() => {
    useRemoteFleetStore.setState({
      metrics: null,
      connections: [],
      environments: [],
      managedResources: [],
      nodes: [],
      agents: [],
      runtimes: [],
      endpoints: [],
      capabilities: [],
      commands: [],
      leases: [],
      sessions: [],
      auditEvents: [],
      ready: false,
      loading: false,
      mutatingAction: null,
      error: null,
    } as Partial<RemoteFleetState>);
  });
}

function renderRemoteFleetPage(width = 1280) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  return render(
    <MemoryRouter>
      <RemoteFleetPage />
    </MemoryRouter>,
  );
}

function hostApiCallIndex(path: string): number {
  return hostApiFetchMock.mock.calls.findIndex(([callPath]) => callPath === path);
}

function hostApiRequestBody(path: string): unknown {
  const call = hostApiFetchMock.mock.calls.find(([callPath]) => callPath === path);
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1]?.body ?? '{}')) as unknown;
}

function hostApiCallCount(path: string): number {
  return hostApiFetchMock.mock.calls.filter(([callPath]) => callPath === path).length;
}

function submitContainerRegistration(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Add remote' }));
  fireEvent.change(screen.getByLabelText('Target kind'), { target: { value: 'container' } });
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Debian environment' } });
  fireEvent.change(screen.getByLabelText('Docker endpoint'), { target: { value: 'https://docker.example.internal:2376' } });
  fireEvent.change(screen.getByLabelText('Container name or ID'), { target: { value: 'matchaclaw-debian-node-1' } });
  fireEvent.change(screen.getByLabelText('Image'), { target: { value: 'debian:bookworm-slim' } });
  fireEvent.change(screen.getByLabelText('Pull candidate images'), {
    target: { value: 'docker.m.daocloud.io/library/debian:bookworm-slim\ndebian:bookworm-slim' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
}

function getModeControl(name: 'Resources' | 'Operations'): HTMLElement {
  return within(screen.getByRole('tablist', { name: 'Remote Fleet mode' })).getByRole('tab', { name });
}

function getResourceTypeNavigation(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Resource types' });
}

function getResourceTypeControl(name: RegExp): HTMLElement {
  return within(getResourceTypeNavigation()).getByRole('button', { name });
}

function getResourceIndex(): HTMLElement {
  return screen.getByRole('heading', { name: 'Resource index' }).closest('section')!;
}

function getIndexedResource(name: RegExp): HTMLElement {
  return within(getResourceIndex()).getByRole('button', { name });
}

function getResourceDetailPanel(): HTMLElement {
  const detailTablist = screen.getByRole('tablist', { name: 'Detail' });
  return detailTablist.closest('section') ?? detailTablist.parentElement!;
}

function activateControl(element: HTMLElement) {
  fireEvent.click(element);
}

async function openMoreActions(detailPanel: HTMLElement) {
  fireEvent.pointerDown(within(detailPanel).getByRole('button', { name: 'More actions' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  });
  await waitFor(() => expect(screen.getByRole('menu')).toBeInTheDocument());
}

function deletionSnapshot(input: Partial<typeof snapshotProjection> = {}) {
  return {
    connections: [],
    environments: [],
    managedResources: [],
    nodes: [],
    agents: [],
    runtimes: [],
    endpoints: [],
    capabilities: [],
    commands: [],
    leases: [],
    sessions: [],
    auditEvents: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...input,
  };
}

describe('remote fleet page node console', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostApiFetchMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    toastWarningMock.mockReset();
    terminalInstances.length = 0;
    fitAddonInstances.length = 0;
    resizeObserverInstances.length = 0;
    websocketInstances.length = 0;
    vi.stubGlobal('ResizeObserver', ResizeObserverStub as unknown as typeof ResizeObserver);
    function WebSocketMock(this: unknown, url: string) {
      const listeners = new Map<string, Array<(event: unknown) => void>>();
      const instance = {
        url,
        binaryType: 'blob' as BinaryType,
        readyState: 1,
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
          if (type === 'open') listener({});
        }),
        emit: (type: string, event: unknown) => {
          for (const listener of listeners.get(type) ?? []) {
            listener(event);
          }
        },
      };
      websocketInstances.push(instance);
      return instance;
    }
    vi.stubGlobal('WebSocket', vi.fn(WebSocketMock));
    resetRemoteFleetStore();
  });

  it('renders the compact toolbar and wide resource workspace without duplicate metrics actions', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot');
      expect(useRemoteFleetStore.getState().ready).toBe(true);
    });

    expect(screen.getByRole('heading', { name: 'Remote runtimes' })).toBeInTheDocument();
    expect(getModeControl('Resources')).toHaveAttribute('aria-selected', 'true');
    expect(getModeControl('Operations')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('button', { name: 'Refresh snapshot' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add remote' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load metrics' })).not.toBeInTheDocument();

    const resourceTypes = getResourceTypeNavigation();
    expect(within(resourceTypes).getByText('Infrastructure')).toBeInTheDocument();
    expect(within(resourceTypes).getByText('Execution')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Resource index' })).toBeInTheDocument();
    expect(screen.getByRole('tablist', { name: 'Detail' })).toBeInTheDocument();
    expect(within(resourceTypes).getByRole('button', { name: /Connections/ })).toHaveAttribute('aria-current', 'page');
    expect(getIndexedResource(/SSH Bastion connection/)).toBeInTheDocument();

    activateControl(getResourceTypeControl(/Environments/));
    expect(getIndexedResource(/Debian environment/)).toBeInTheDocument();
    activateControl(getResourceTypeControl(/Resources/));
    expect(getIndexedResource(/Debian container/)).toBeInTheDocument();
    expect(screen.queryByText('Legacy environment')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /K8s Prod/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Operations' })).not.toBeInTheDocument();
  });

  it('updates resource detail selection while preserving the controlled detail tab', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'SSH Bastion connection' })).toBeInTheDocument());

    const detailPanel = getResourceDetailPanel();
    activateControl(within(detailPanel).getByRole('tab', { name: 'Commands' }));
    expect(within(detailPanel).getByRole('tab', { name: 'Commands' })).toHaveAttribute('aria-selected', 'true');
    expect(within(detailPanel).getByRole('heading', { name: 'Commands' })).toBeInTheDocument();

    fireEvent.click(getIndexedResource(/Build VM connection/));

    expect(within(detailPanel).getByRole('heading', { name: 'Build VM connection' })).toBeInTheDocument();
    expect(within(detailPanel).getByRole('tab', { name: 'Commands' })).toHaveAttribute('aria-selected', 'true');
    expect(within(detailPanel).getByRole('heading', { name: 'Commands' })).toBeInTheDocument();
  });

  it('checks the selected connection through its dedicated probe route and renders the returned snapshot', async () => {
    const selectedConnection = { ...sshConnection, status: 'offline' };
    const initialSnapshot = {
      ...snapshotProjection,
      connections: [selectedConnection, vmConnection, containerConnection],
    };
    const connectionProbeSnapshot = {
      ...initialSnapshot,
      connections: initialSnapshot.connections.map((connection) => (
        connection.id === selectedConnection.id ? { ...connection, status: 'online' } : connection
      )),
    };

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return initialSnapshot;
      if (path === '/api/remote-fleet/probe-connection') return { snapshot: connectionProbeSnapshot };
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'SSH Bastion connection' })).toBeInTheDocument());

    const detailPanel = getResourceDetailPanel();
    expect(getResourceTypeControl(/Connections/)).toHaveAttribute('aria-current', 'page');
    expect(within(detailPanel).getByText('Connection')).toBeInTheDocument();
    expect(within(detailPanel).getByRole('heading', { name: 'SSH Bastion connection' })).toBeInTheDocument();
    expect(within(detailPanel).getAllByText('Offline').length).toBeGreaterThan(0);

    fireEvent.click(within(detailPanel).getByRole('button', { name: 'Check connection' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/probe-connection')).toBe(1));

    const connectionProbeCall = hostApiFetchMock.mock.calls.find(([path]) => path === '/api/remote-fleet/probe-connection');
    expect(connectionProbeCall?.[1]).toMatchObject({ method: 'POST' });
    expect(hostApiRequestBody('/api/remote-fleet/probe-connection')).toEqual({ connectionId: selectedConnection.id });
    expect(within(detailPanel).getAllByText('Online').length).toBeGreaterThan(0);
    expect(getResourceTypeControl(/Connections/)).toHaveAttribute('aria-current', 'page');
    expect(within(detailPanel).getByText('Connection')).toBeInTheDocument();
    expect(within(detailPanel).getByRole('heading', { name: 'SSH Bastion connection' })).toBeInTheDocument();
    expect(hostApiCallIndex('/api/remote-fleet/probe')).toBe(-1);
    expect(hostApiCallIndex('/api/remote-fleet/install-agent')).toBe(-1);
    expect(hostApiCallIndex('/api/remote-fleet/issue-enrollment-token')).toBe(-1);
    expect(hostApiFetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/remote-fleet/snapshot',
      '/api/remote-fleet/probe-connection',
    ]);
  });

  it('renders static terminal guidance for an agent without secondary resource navigation', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'SSH Bastion connection' })).toBeInTheDocument());

    activateControl(getResourceTypeControl(/Agents/));
    fireEvent.click(getIndexedResource(/agent-1/));
    const detailPanel = getResourceDetailPanel();
    activateControl(within(detailPanel).getByRole('tab', { name: 'Terminal' }));

    expect(within(detailPanel).getAllByText('Terminal access is not opened directly from an agent. Select the related runtime in Resource Index to use its terminal target.').length).toBeGreaterThan(0);
    expect(within(detailPanel).getByText('runtime-1')).toBeInTheDocument();
    expect(within(detailPanel).queryByRole('button', { name: 'Open related runtime' })).not.toBeInTheDocument();
    expect(within(detailPanel).queryByRole('button', { name: 'Open terminal' })).not.toBeInTheDocument();
    expect(within(detailPanel).getByRole('heading', { name: 'agent-1' })).toBeInTheDocument();
    expect(hostApiCallIndex('/api/remote-fleet/terminal/open')).toBe(-1);
    expect(websocketInstances).toHaveLength(0);
    expect(useRemoteFleetStore.getState().sessions).toEqual([]);
  });

  it('renders one primary empty state for an empty fleet', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') {
        return {
          ...snapshotProjection,
          connections: [],
          environments: [],
          managedResources: [],
          nodes: [],
          agents: [],
          runtimes: [],
          endpoints: [],
          capabilities: [],
          commands: [],
          leases: [],
          auditEvents: [],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(screen.getByText('Connect your first remote environment')).toBeInTheDocument());

    expect(screen.getAllByText('Connect your first remote environment')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Add connection' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Resource index' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Detail' })).not.toBeInTheDocument();
    expect(screen.queryByText('No matching resources')).not.toBeInTheDocument();
    expect(screen.queryByText('No object selected')).not.toBeInTheDocument();
  });

  it('registers an SSH host connection and environment before allowing deployment', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return { ...snapshotProjection, connections: [], environments: [], nodes: [] };
      if (path === '/api/remote-fleet/register-connection') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: object };
        return { success: true, connection: { id: 'connection-ssh-registration', ...body.connection } };
      }
      if (path === '/api/remote-fleet/register-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environment?: object };
        return { success: true, environment: { id: 'environment-ssh-registration', ...body.environment } };
      }
      if (path === '/api/remote-fleet/deploy-environment') {
        return { success: true, command: { id: 'deploy-ssh-registration', status: 'queued' } };
      }
      if (path === '/api/remote-fleet/register') {
        return { success: true };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot'));

    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'SSH Bastion' } });
    fireEvent.change(screen.getByLabelText('Host / IP'), { target: { value: 'ssh.example.internal' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '22' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ops' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/register-environment')).toBe(1));

    expect(hostApiCallIndex('/api/remote-fleet/register-connection')).toBeGreaterThan(-1);
    expect(hostApiCallIndex('/api/remote-fleet/register-environment')).toBeGreaterThan(hostApiCallIndex('/api/remote-fleet/register-connection'));
    expect(hostApiCallIndex('/api/remote-fleet/register')).toBe(-1);
    expect(hostApiRequestBody('/api/remote-fleet/register-connection')).toEqual({
      connection: expect.objectContaining({
        targetKind: 'ssh-host',
        endpointUrl: 'ssh://ssh.example.internal:22',
      }),
    });
    expect(hostApiRequestBody('/api/remote-fleet/register-environment')).toEqual({
      environment: expect.objectContaining({
        connectionId: 'connection-ssh-registration',
        targetKind: 'ssh-host',
      }),
    });

    const deployNow = within(screen.getByRole('dialog')).getByRole('button', { name: 'Deploy now' });
    expect(deployNow).toBeEnabled();
    fireEvent.click(deployNow);

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/deploy-environment')).toBe(1));
    expect(hostApiRequestBody('/api/remote-fleet/deploy-environment')).toEqual({ environmentId: 'environment-ssh-registration' });
  });

  it('registers a VM connection and environment before allowing deployment', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return { ...snapshotProjection, connections: [], environments: [], nodes: [] };
      if (path === '/api/remote-fleet/register-connection') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: object };
        return { success: true, connection: { id: 'connection-vm-registration', ...body.connection } };
      }
      if (path === '/api/remote-fleet/register-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environment?: object };
        return { success: true, environment: { id: 'environment-vm-registration', ...body.environment } };
      }
      if (path === '/api/remote-fleet/deploy-environment') {
        return { success: true, command: { id: 'deploy-vm-registration', status: 'queued' } };
      }
      if (path === '/api/remote-fleet/register') {
        return { success: true };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot'));

    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }));
    fireEvent.change(screen.getByLabelText('Target kind'), { target: { value: 'vm' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Build VM' } });
    fireEvent.change(screen.getByLabelText('Host / IP'), { target: { value: 'build-vm-01.internal' } });
    fireEvent.change(screen.getByLabelText('SSH port'), { target: { value: '22' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'matcha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/register-environment')).toBe(1));

    expect(hostApiCallIndex('/api/remote-fleet/register-connection')).toBeGreaterThan(-1);
    expect(hostApiCallIndex('/api/remote-fleet/register-environment')).toBeGreaterThan(hostApiCallIndex('/api/remote-fleet/register-connection'));
    expect(hostApiCallIndex('/api/remote-fleet/register')).toBe(-1);
    expect(hostApiRequestBody('/api/remote-fleet/register-connection')).toEqual({
      connection: expect.objectContaining({
        targetKind: 'vm',
        endpointUrl: 'ssh://build-vm-01.internal:22',
      }),
    });
    expect(hostApiRequestBody('/api/remote-fleet/register-environment')).toEqual({
      environment: expect.objectContaining({
        connectionId: 'connection-vm-registration',
        targetKind: 'vm',
      }),
    });

    const deployNow = within(screen.getByRole('dialog')).getByRole('button', { name: 'Deploy now' });
    expect(deployNow).toBeEnabled();
    fireEvent.click(deployNow);

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/deploy-environment')).toBe(1));
    expect(hostApiRequestBody('/api/remote-fleet/deploy-environment')).toEqual({ environmentId: 'environment-vm-registration' });
  });

  it('registers a Kubernetes connection and environment before allowing deployment', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return { ...snapshotProjection, connections: [], environments: [], managedResources: [], nodes: [] };
      if (path === '/api/remote-fleet/write-credential') {
        return {
          credentialName: 'kubeBearerToken',
          credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/k8s-prod/kubeBearerToken' },
        };
      }
      if (path === '/api/remote-fleet/register-connection') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: object };
        return { success: true, connection: { id: 'connection-k8s-registration', ...body.connection } };
      }
      if (path === '/api/remote-fleet/register-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environment?: object };
        return { success: true, environment: { id: 'environment-k8s-registration', ...body.environment } };
      }
      if (path === '/api/remote-fleet/deploy-environment') {
        return { success: true, command: { id: 'deploy-k8s-registration', status: 'queued' } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot'));

    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }));
    fireEvent.change(screen.getByLabelText('Target kind'), { target: { value: 'k8s-pod' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Kubernetes prod' } });
    fireEvent.change(screen.getByLabelText('Kubernetes API server URL'), { target: { value: 'https://k8s.example.internal' } });
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'matcha-runtime' } });
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'kubernetes-bearer-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/register-environment')).toBe(1));

    expect(hostApiCallIndex('/api/remote-fleet/write-credential')).toBeGreaterThan(-1);
    expect(hostApiRequestBody('/api/remote-fleet/write-credential')).toEqual({
      operationId: expect.stringMatching(/\S/),
      credentialId: 'Kubernetes-prod',
      credentialName: 'kubeBearerToken',
      plaintextValue: 'kubernetes-bearer-token',
    });
    expect(hostApiCallIndex('/api/remote-fleet/register-connection')).toBeGreaterThan(hostApiCallIndex('/api/remote-fleet/write-credential'));
    expect(hostApiCallIndex('/api/remote-fleet/register-environment')).toBeGreaterThan(hostApiCallIndex('/api/remote-fleet/register-connection'));
    expect(hostApiRequestBody('/api/remote-fleet/register-connection')).toEqual({
      connection: expect.objectContaining({
        targetKind: 'k8s-pod',
        endpointUrl: 'https://k8s.example.internal',
        secretRefs: {
          kubeBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://credentials/k8s-prod/kubeBearerToken' },
        },
        publicConfig: { k8s: { apiServerUrl: 'https://k8s.example.internal' } },
      }),
    });
    expect(hostApiRequestBody('/api/remote-fleet/register-environment')).toEqual({
      environment: expect.objectContaining({
        connectionId: 'connection-k8s-registration',
        environmentKind: 'k8s-workload',
        targetKind: 'k8s-pod',
        publicConfig: { k8s: { namespace: 'matcha-runtime' } },
      }),
    });
    expect(JSON.stringify(hostApiRequestBody('/api/remote-fleet/register-connection'))).not.toContain('kubernetes-bearer-token');

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Deploy now' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/deploy-environment')).toBe(1));
    expect(hostApiRequestBody('/api/remote-fleet/deploy-environment')).toEqual({ environmentId: 'environment-k8s-registration' });
  });

  it('reuses credential operation IDs when registration fails before retrying', async () => {
    let registrationAttempt = 0;
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return { ...snapshotProjection, connections: [], environments: [], managedResources: [], nodes: [] };
      if (path === '/api/remote-fleet/write-credential') {
        return {
          credentialName: 'kubeBearerToken',
          credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/k8s-retry/kubeBearerToken' },
        };
      }
      if (path === '/api/remote-fleet/register-connection') {
        registrationAttempt += 1;
        if (registrationAttempt === 1) throw new Error('registration failed');
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: object };
        return { success: true, connection: { id: 'connection-k8s-retry', ...body.connection } };
      }
      if (path === '/api/remote-fleet/register-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environment?: object };
        return { success: true, environment: { id: 'environment-k8s-retry', ...body.environment } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot'));

    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }));
    fireEvent.change(screen.getByLabelText('Target kind'), { target: { value: 'k8s-pod' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Kubernetes retry' } });
    fireEvent.change(screen.getByLabelText('Kubernetes API server URL'), { target: { value: 'https://k8s-retry.example.internal' } });
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'matcha-runtime' } });
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'kubernetes-retry-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Failed to save connection'));
    expect(screen.getByLabelText('Bearer token')).toHaveValue('kubernetes-retry-token');
    const firstCredentialWrite = hostApiRequestBody('/api/remote-fleet/write-credential') as { operationId: string };
    expect(firstCredentialWrite.operationId).toMatch(/\S/);
    expect(document.body.innerHTML).not.toContain(firstCredentialWrite.operationId);
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain('kubernetes-retry-token');

    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/register-environment')).toBe(1));
    const credentialWrites = hostApiFetchMock.mock.calls
      .filter(([path]) => path === '/api/remote-fleet/write-credential')
      .map(([, init]) => JSON.parse(String(init?.body ?? '{}')) as { operationId: string; plaintextValue: string });
    expect(credentialWrites).toEqual([
      { operationId: firstCredentialWrite.operationId, credentialId: 'Kubernetes-retry', credentialName: 'kubeBearerToken', plaintextValue: 'kubernetes-retry-token' },
      { operationId: firstCredentialWrite.operationId, credentialId: 'Kubernetes-retry', credentialName: 'kubeBearerToken', plaintextValue: 'kubernetes-retry-token' },
    ]);
    expect(screen.queryByLabelText('Bearer token')).not.toBeInTheDocument();
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain('kubernetes-retry-token');
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain(firstCredentialWrite.operationId);
  });

  it('updates a reused container connection with newly written credentials before registering its environment', async () => {
    const reusableConnection = {
      id: 'connection-container-reusable',
      displayName: 'Reusable Docker connection',
      connectionKind: 'container',
      targetKind: 'container',
      endpointUrl: 'http://docker.example.internal:2375',
      enabled: true,
      status: 'online',
    };

    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') {
        return {
          ...snapshotProjection,
          connections: [reusableConnection],
          environments: [],
          managedResources: [],
          nodes: [],
          agents: [],
          runtimes: [],
          endpoints: [],
          capabilities: [],
          commands: [],
          leases: [],
          auditEvents: [],
        };
      }
      if (path === '/api/remote-fleet/write-credential') {
        return {
          credentialName: 'dockerBearerToken',
          credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/reusable-docker/dockerBearerToken' },
        };
      }
      if (path === '/api/remote-fleet/register-connection') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: object };
        return { success: true, connection: { ...reusableConnection, ...body.connection } };
      }
      if (path === '/api/remote-fleet/register-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environment?: object };
        return { success: true, environment: { id: 'environment-reused-container', ...body.environment } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: reusableConnection.displayName })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }));
    fireEvent.change(screen.getByLabelText('Target kind'), { target: { value: 'container' } });
    fireEvent.change(screen.getByLabelText('Docker endpoint'), { target: { value: reusableConnection.endpointUrl } });
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'bearer-token' } });
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'replacement-docker-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/register-environment')).toBe(1));

    expect(hostApiCallCount('/api/remote-fleet/write-credential')).toBe(1);
    expect(hostApiCallCount('/api/remote-fleet/register-connection')).toBe(1);
    expect(hostApiCallIndex('/api/remote-fleet/register-connection')).toBeGreaterThan(hostApiCallIndex('/api/remote-fleet/write-credential'));
    expect(hostApiCallIndex('/api/remote-fleet/register-environment')).toBeGreaterThan(hostApiCallIndex('/api/remote-fleet/register-connection'));
    expect(hostApiRequestBody('/api/remote-fleet/register-connection')).toEqual({
      connection: expect.objectContaining({
        id: reusableConnection.id,
        connectionKind: 'container',
        endpointUrl: reusableConnection.endpointUrl,
        secretRefs: {
          dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://credentials/reusable-docker/dockerBearerToken' },
        },
      }),
    });
    expect(JSON.stringify(hostApiRequestBody('/api/remote-fleet/register-connection'))).not.toContain('replacement-docker-token');
    expect(hostApiRequestBody('/api/remote-fleet/register-environment')).toEqual({
      environment: expect.objectContaining({
        connectionId: reusableConnection.id,
        targetKind: 'container',
      }),
    });
    expect(JSON.stringify(hostApiRequestBody('/api/remote-fleet/register-environment'))).not.toContain('replacement-docker-token');
  });

  it('registers a Custom connection and environment without offering deployment', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return { ...snapshotProjection, connections: [], environments: [], managedResources: [], nodes: [] };
      if (path === '/api/remote-fleet/register-connection') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: object };
        return { success: true, connection: { id: 'connection-custom-registration', ...body.connection } };
      }
      if (path === '/api/remote-fleet/register-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environment?: object };
        return { success: true, environment: { id: 'environment-custom-registration', ...body.environment } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot'));

    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }));
    fireEvent.change(screen.getByLabelText('Target kind'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Custom runtime' } });
    fireEvent.change(screen.getByLabelText('Custom endpoint URL'), { target: { value: 'https://custom.example.internal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/register-environment')).toBe(1));

    expect(hostApiCallIndex('/api/remote-fleet/register-connection')).toBeGreaterThan(-1);
    expect(hostApiCallIndex('/api/remote-fleet/register-environment')).toBeGreaterThan(hostApiCallIndex('/api/remote-fleet/register-connection'));
    expect(hostApiCallIndex('/api/remote-fleet/write-credential')).toBe(-1);
    expect(hostApiCallIndex('/api/remote-fleet/deploy-environment')).toBe(-1);
    expect(hostApiRequestBody('/api/remote-fleet/register-connection')).toEqual({
      connection: expect.objectContaining({
        displayName: 'Custom runtime',
        connectionKind: 'custom',
        targetKind: 'custom',
        endpointUrl: 'https://custom.example.internal',
      }),
    });
    expect(hostApiRequestBody('/api/remote-fleet/register-environment')).toEqual({
      environment: expect.objectContaining({
        connectionId: 'connection-custom-registration',
        displayName: 'Custom runtime',
        environmentKind: 'custom',
        targetKind: 'custom',
      }),
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('hides unavailable actions and preserves terminal guidance for Custom connections', async () => {
    const customConnectionByKind = {
      id: 'connection-custom-by-kind',
      displayName: 'Custom connection kind endpoint',
      connectionKind: 'custom',
      targetKind: 'ssh-host',
      endpointUrl: 'https://custom-kind.example.internal',
      status: 'registered',
    };
    const customConnectionByTarget = {
      id: 'connection-custom-by-target',
      displayName: 'Custom target kind endpoint',
      connectionKind: 'ssh-host',
      targetKind: 'custom',
      endpointUrl: 'https://custom-target.example.internal',
      status: 'registered',
    };
    const customEnvironment = {
      id: 'environment-custom-1',
      connectionId: customConnectionByKind.id,
      displayName: 'Custom environment',
      environmentKind: 'custom',
      targetKind: 'custom',
      status: 'registered',
    };
    const externalRuntimeGuidance = 'Custom targets are managed by an external runtime, so connection checks and environment deployment are unavailable here. Select a related runtime or endpoint in Resource Index to review status and advertised capabilities.';

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') {
        return {
          ...snapshotProjection,
          connections: [customConnectionByKind, customConnectionByTarget],
          environments: [customEnvironment],
          managedResources: [],
          nodes: [],
          agents: [],
          runtimes: [],
          endpoints: [],
          capabilities: [],
          commands: [],
          leases: [],
          auditEvents: [],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: customConnectionByKind.displayName })).toBeInTheDocument());

    const detailPanel = getResourceDetailPanel();
    const associations = within(detailPanel).getByRole('heading', { name: 'Associations' }).closest('section')!;
    expect(within(detailPanel).queryByRole('button', { name: 'Check connection' })).not.toBeInTheDocument();
    await openMoreActions(detailPanel);
    expect(screen.getByRole('menuitem', { name: 'Delete connection' })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(within(associations).getByText(externalRuntimeGuidance)).toBeInTheDocument();
    expect(within(associations).queryByRole('button', { name: 'Deploy environment' })).not.toBeInTheDocument();
    expect(within(detailPanel).queryByRole('button', { name: /Open related/ })).not.toBeInTheDocument();

    activateControl(within(detailPanel).getByRole('tab', { name: 'Terminal' }));
    expect(within(detailPanel).getByText('This connection has no node terminal target. Select a related node, runtime, or endpoint in Resource Index instead.')).toBeInTheDocument();
    expect(within(detailPanel).queryByRole('button', { name: 'Open terminal' })).not.toBeInTheDocument();

    activateControl(getResourceTypeControl(/Connections/));
    fireEvent.click(getIndexedResource(/Custom target kind endpoint/));
    expect(within(getResourceDetailPanel()).queryByRole('button', { name: 'Check connection' })).not.toBeInTheDocument();
    expect(hostApiCallIndex('/api/remote-fleet/probe-connection')).toBe(-1);
    expect(hostApiCallIndex('/api/remote-fleet/deploy-environment')).toBe(-1);
  });

  it('keeps deletion but not deployment for a Custom environment', async () => {
    const customConnection = {
      id: 'connection-custom-1',
      displayName: 'Custom endpoint',
      connectionKind: 'custom',
      targetKind: 'custom',
      endpointUrl: 'https://custom.example.internal',
      status: 'registered',
    };
    const customEnvironment = {
      id: 'environment-custom-1',
      connectionId: customConnection.id,
      displayName: 'Custom environment',
      environmentKind: 'custom',
      targetKind: 'custom',
      status: 'registered',
    };
    const externalRuntimeGuidance = 'Custom targets are managed by an external runtime, so connection checks and environment deployment are unavailable here. Select a related runtime or endpoint in Resource Index to review status and advertised capabilities.';

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') {
        return {
          ...snapshotProjection,
          connections: [customConnection],
          environments: [customEnvironment],
          managedResources: [],
          nodes: [],
          agents: [],
          runtimes: [],
          endpoints: [],
          capabilities: [],
          commands: [],
          leases: [],
          auditEvents: [],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getResourceTypeControl(/Environments/)).toBeInTheDocument());
    activateControl(getResourceTypeControl(/Environments/));
    fireEvent.click(getIndexedResource(/Custom environment/));

    const detailPanel = getResourceDetailPanel();
    expect(within(detailPanel).getByText(externalRuntimeGuidance)).toBeInTheDocument();
    expect(within(detailPanel).queryByRole('button', { name: 'Deploy environment' })).not.toBeInTheDocument();
    expect(within(detailPanel).getByRole('button', { name: 'More actions' })).toBeInTheDocument();
    fireEvent.pointerDown(within(detailPanel).getByRole('button', { name: 'More actions' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Delete environment' })).toBeInTheDocument());
    expect(within(detailPanel).queryByRole('button', { name: /Open related/ })).not.toBeInTheDocument();
    expect(hostApiCallIndex('/api/remote-fleet/deploy-environment')).toBe(-1);
  });

  it('uses the canonical failed deploy command status instead of HTTP success for its toast', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      if (path === '/api/remote-fleet/deploy-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environmentId?: string };
        return { success: true, command: { id: 'deploy-command-failed', environmentId: body.environmentId, command: 'remoteFleet.environment.deploy', status: 'failed' } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getResourceTypeControl(/Environments/)).toBeInTheDocument());
    activateControl(getResourceTypeControl(/Environments/));
    fireEvent.click(getIndexedResource(/Debian environment/));
    fireEvent.click(within(getResourceDetailPanel()).getByRole('button', { name: 'Deploy environment' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/deploy-environment')).toBe(1));
    expect(toastErrorMock).toHaveBeenCalledWith('Failed to deploy environment');
    expect(toastSuccessMock).not.toHaveBeenCalledWith('Environment deploy command submitted');
  });

  it('blocks Docker HTTPS loopback port 2375 before credential writes or registration', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return { ...snapshotProjection, connections: [], environments: [], managedResources: [], nodes: [] };
      if (path === '/api/remote-fleet/write-credential') {
        return {
          credentialName: 'dockerBearerToken',
          credentialRef: { kind: 'secret-ref', ref: 'remote-fleet://credentials/loopback/dockerBearerToken' },
        };
      }
      if (path === '/api/remote-fleet/register-connection') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: object };
        return { success: true, connection: { id: 'connection-loopback-2375', ...body.connection } };
      }
      if (path === '/api/remote-fleet/register-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environment?: object };
        return { success: true, environment: { id: 'environment-loopback-2375', ...body.environment } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot'));

    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }));
    fireEvent.change(screen.getByLabelText('Target kind'), { target: { value: 'container' } });
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'bearer-token' } });
    fireEvent.change(screen.getByLabelText('Docker endpoint'), { target: { value: 'https://127.0.0.1:2375' } });
    fireEvent.change(screen.getByLabelText('Container name or ID'), { target: { value: 'matchaclaw-loopback' } });
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'docker-bearer-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(hostApiCallIndex('/api/remote-fleet/write-credential')).toBe(-1);
    expect(hostApiCallIndex('/api/remote-fleet/register-connection')).toBe(-1);
    expect(hostApiCallIndex('/api/remote-fleet/register-environment')).toBe(-1);
  });

  it('edits a container connection through a same-ID upsert without environment side effects', async () => {
    const editableContainerConnection = {
      ...containerConnection,
      labels: ['production', 'container'],
      enabled: false,
    };
    const editSnapshot = {
      ...snapshotProjection,
      connections: [sshConnection, vmConnection, editableContainerConnection],
    };

    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return editSnapshot;
      if (path === '/api/remote-fleet/register-connection') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: object };
        return { success: true, connection: { ...body.connection, id: editableContainerConnection.id } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getIndexedResource(/Docker Prod/)).toBeInTheDocument());
    fireEvent.click(getIndexedResource(/Docker Prod/));

    const detailPanel = getResourceDetailPanel();
    fireEvent.click(within(detailPanel).getByRole('button', { name: 'Edit connection' }));

    const registrationSheet = screen.getByRole('dialog');
    expect(within(registrationSheet).getByLabelText('Target kind')).toHaveValue('container');
    expect(within(registrationSheet).getByLabelText('Target kind')).toBeDisabled();
    expect(within(registrationSheet).getByLabelText('Display name')).toHaveValue('Docker Prod');
    expect(within(registrationSheet).getByLabelText('Docker endpoint')).toHaveValue('https://docker.example.internal:2376');

    expect(within(registrationSheet).getByLabelText('Labels')).toHaveValue('production, container');
    expect(within(registrationSheet).getByRole('switch')).not.toBeChecked();

    fireEvent.change(within(registrationSheet).getByLabelText('Docker endpoint'), { target: { value: 'http://127.0.0.1:2375' } });
    fireEvent.click(within(registrationSheet).getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith('Connection saved. Check the connection to verify it.'));

    expect(hostApiRequestBody('/api/remote-fleet/register-connection')).toEqual({
      connection: expect.objectContaining({
        id: editableContainerConnection.id,
        displayName: 'Docker Prod',
        connectionKind: 'container',
        targetKind: 'container',
        endpointUrl: 'http://127.0.0.1:2375',
        labels: ['production', 'container'],
        enabled: false,
        publicConfig: {
          docker: expect.objectContaining({
            endpointUrl: 'http://127.0.0.1:2375',
            authMethod: 'none',
          }),
        },
      }),
    });
    expect(hostApiCallCount('/api/remote-fleet/register-environment')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/deploy-environment')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/write-credential')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/delete-connection')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/delete-environment')).toBe(0);
    expect(hostApiCallIndex('/api/remote-fleet/register')).toBe(-1);
  });

  it('edits an SSH connection through a same-ID upsert without exposing or replacing its credentials', async () => {
    const editableSshConnection = {
      ...sshConnection,
      endpointUrl: 'ssh://ops@example.internal:2222',
      labels: ['production', 'ssh'],
      enabled: false,
    };
    const editSnapshot = {
      ...snapshotProjection,
      connections: [editableSshConnection, vmConnection, containerConnection],
    };

    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return editSnapshot;
      if (path === '/api/remote-fleet/register-connection') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: object };
        return { success: true, connection: { ...body.connection, id: editableSshConnection.id } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getIndexedResource(/SSH Bastion connection/)).toBeInTheDocument());

    const detailPanel = getResourceDetailPanel();
    fireEvent.click(within(detailPanel).getByRole('button', { name: 'Edit connection' }));

    const registrationSheet = screen.getByRole('dialog');
    expect(within(registrationSheet).getByLabelText('Target kind')).toHaveValue('ssh-host');
    expect(within(registrationSheet).getByLabelText('Target kind')).toBeDisabled();
    expect(within(registrationSheet).getByLabelText('Display name')).toHaveValue('SSH Bastion connection');
    expect(within(registrationSheet).getByLabelText('Host / IP')).toHaveValue('example.internal');
    expect(within(registrationSheet).getByLabelText('Port')).toHaveValue('2222');
    expect(within(registrationSheet).getByLabelText('Username')).toHaveValue('ops');
    expect(within(registrationSheet).getByLabelText('Password')).toHaveValue('');
    expect(within(registrationSheet).getByLabelText('Labels')).toHaveValue('production, ssh');
    expect(within(registrationSheet).getByRole('switch')).not.toBeChecked();

    fireEvent.change(within(registrationSheet).getByLabelText('Display name'), { target: { value: 'SSH Bastion repaired' } });
    fireEvent.click(within(registrationSheet).getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith('Connection saved. Check the connection to verify it.'));

    expect(hostApiRequestBody('/api/remote-fleet/register-connection')).toEqual({
      connection: expect.objectContaining({
        id: editableSshConnection.id,
        displayName: 'SSH Bastion repaired',
        connectionKind: 'ssh-host',
        targetKind: 'ssh-host',
        endpointUrl: 'ssh://example.internal:2222',
        labels: ['production', 'ssh'],
        enabled: false,
        publicConfig: {
          ssh: {
            host: 'example.internal',
            port: 2222,
            username: 'ops',
          },
        },
      }),
    });
    const registrationBody = JSON.stringify(hostApiRequestBody('/api/remote-fleet/register-connection'));
    expect(registrationBody).not.toContain('ssh-password-secret');
    expect(registrationBody).not.toContain('ssh-private-key');
    expect(registrationBody).not.toContain('secret-ref');
    expect(hostApiCallCount('/api/remote-fleet/register-environment')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/deploy-environment')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/write-credential')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/delete-connection')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/delete-environment')).toBe(0);
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain('secret-ref');
  });

  it('blocks HTTPS loopback port 2375 while editing a container connection before every API side effect', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getIndexedResource(/Docker Prod/)).toBeInTheDocument());
    fireEvent.click(getIndexedResource(/Docker Prod/));

    const detailPanel = getResourceDetailPanel();
    fireEvent.click(within(detailPanel).getByRole('button', { name: 'Edit connection' }));

    const registrationSheet = screen.getByRole('dialog');
    fireEvent.change(within(registrationSheet).getByLabelText('Docker endpoint'), { target: { value: 'https://127.0.0.1:2375' } });
    fireEvent.click(within(registrationSheet).getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('Local Docker on port 2375 must use HTTP. Change https:// to http://, then save.'));
    expect(hostApiCallCount('/api/remote-fleet/register-connection')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/register-environment')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/deploy-environment')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/write-credential')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/delete-connection')).toBe(0);
    expect(hostApiCallCount('/api/remote-fleet/delete-environment')).toBe(0);
  });

  it('registers a container connection before creating its managed environment', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return { ...snapshotProjection, connections: [], environments: [], managedResources: [], nodes: [] };
      if (path === '/api/remote-fleet/register-connection') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: unknown };
        return { success: true, connection: { id: 'connection-1', ...(body.connection as object) } };
      }
      if (path === '/api/remote-fleet/register-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environment?: unknown };
        return { success: true, environment: { id: 'environment-1', ...(body.environment as object) } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot'));

    fireEvent.click(screen.getByRole('button', { name: 'Add remote' }));
    fireEvent.change(screen.getByLabelText('Target kind'), { target: { value: 'container' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Debian environment' } });
    fireEvent.change(screen.getByLabelText('Docker endpoint'), { target: { value: 'https://docker.example.internal:2376' } });
    fireEvent.change(screen.getByLabelText('Container name or ID'), { target: { value: 'matchaclaw-debian-node-1' } });
    fireEvent.change(screen.getByLabelText('Image'), { target: { value: 'debian:bookworm-slim' } });
    fireEvent.change(screen.getByLabelText('Pull candidate images'), {
      target: { value: 'docker.m.daocloud.io/library/debian:bookworm-slim\ndebian:bookworm-slim' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/register-environment', expect.any(Object)));

    expect(hostApiCallIndex('/api/remote-fleet/register-connection')).toBeGreaterThan(-1);
    expect(hostApiCallIndex('/api/remote-fleet/register-environment')).toBeGreaterThan(hostApiCallIndex('/api/remote-fleet/register-connection'));
    expect(hostApiCallIndex('/api/remote-fleet/register')).toBe(-1);
    expect(hostApiRequestBody('/api/remote-fleet/register-connection')).toEqual({
      connection: expect.objectContaining({
        displayName: 'Debian environment',
        connectionKind: 'container',
        targetKind: 'container',
        endpointUrl: 'https://docker.example.internal:2376',
        enabled: true,
        publicConfig: expect.objectContaining({
          docker: expect.objectContaining({
            endpointUrl: 'https://docker.example.internal:2376',
          }),
        }),
      }),
    });
    expect(hostApiRequestBody('/api/remote-fleet/register-environment')).toEqual({
      environment: expect.objectContaining({
        connectionId: 'connection-1',
        displayName: 'Debian environment',
        environmentKind: 'docker-container',
        targetKind: 'container',
        enabled: true,
        publicConfig: expect.objectContaining({
          docker: {
            containerName: 'matchaclaw-debian-node-1',
            image: 'debian:bookworm-slim',
            imageCandidates: [
              'docker.m.daocloud.io/library/debian:bookworm-slim',
              'debian:bookworm-slim',
            ],
          },
        }),
      }),
    });
    expect(JSON.stringify(hostApiRequestBody('/api/remote-fleet/register-connection'))).not.toContain('dockerBearerToken');
    expect(JSON.stringify(hostApiRequestBody('/api/remote-fleet/register-environment'))).not.toContain('dockerBearerToken');
    expect(screen.queryByText('dockerBearerToken')).not.toBeInTheDocument();
  });

  it('keeps the completed container registration sheet open until the user explicitly deploys the new environment', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') {
        return { ...snapshotProjection, connections: [], environments: [], managedResources: [], nodes: [] };
      }
      if (path === '/api/remote-fleet/register-connection') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: object };
        return { success: true, connection: { id: 'connection-1', ...body.connection } };
      }
      if (path === '/api/remote-fleet/register-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environment?: object };
        return { success: true, environment: { id: 'environment-1', ...body.environment } };
      }
      if (path === '/api/remote-fleet/deploy-environment') {
        return { success: true, command: { id: 'deploy-command-1', status: 'queued' } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot'));
    submitContainerRegistration();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/register-environment', expect.any(Object)));

    const registrationSheet = screen.getByRole('dialog');
    const deployNow = within(registrationSheet).getByRole('button', { name: 'Deploy now' });
    expect(deployNow).toBeEnabled();
    expect(hostApiCallIndex('/api/remote-fleet/deploy-environment')).toBe(-1);

    fireEvent.click(deployNow);

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/deploy-environment', expect.any(Object)));

    expect(hostApiRequestBody('/api/remote-fleet/deploy-environment')).toEqual({ environmentId: 'environment-1' });
    expect(hostApiCallIndex('/api/remote-fleet/register-connection')).toBeGreaterThan(-1);
    expect(hostApiCallIndex('/api/remote-fleet/register-environment')).toBeGreaterThan(hostApiCallIndex('/api/remote-fleet/register-connection'));
    expect(hostApiCallIndex('/api/remote-fleet/deploy-environment')).toBeGreaterThan(hostApiCallIndex('/api/remote-fleet/register-environment'));
    expect(hostApiCallIndex('/api/remote-fleet/install-agent')).toBe(-1);
    expect(hostApiCallIndex('/api/remote-fleet/issue-enrollment-token')).toBe(-1);
  });

  it('retries deployment from the completed registration sheet without registering the connection or environment again', async () => {
    let deploymentAttempt = 0;
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') {
        return { ...snapshotProjection, connections: [], environments: [], managedResources: [], nodes: [] };
      }
      if (path === '/api/remote-fleet/register-connection') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { connection?: object };
        return { success: true, connection: { id: 'connection-1', ...body.connection } };
      }
      if (path === '/api/remote-fleet/register-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environment?: object };
        return { success: true, environment: { id: 'environment-1', ...body.environment } };
      }
      if (path === '/api/remote-fleet/deploy-environment') {
        deploymentAttempt += 1;
        if (deploymentAttempt === 1) throw new Error('deploy failed: token=should-not-render');
        return { success: true, command: { id: 'deploy-command-2', status: 'queued' } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot'));
    submitContainerRegistration();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/register-environment', expect.any(Object)));

    const registrationSheet = screen.getByRole('dialog');
    fireEvent.click(within(registrationSheet).getByRole('button', { name: 'Deploy now' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/deploy-environment')).toBe(1));
    expect(within(registrationSheet).getByText('Deployment failed. Review the environment configuration and try again.')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('deploy failed: token=should-not-render');
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain('deploy failed: token=should-not-render');

    const retryDeploy = within(registrationSheet).getByRole('button', { name: 'Deploy now' });
    await waitFor(() => expect(retryDeploy).toBeEnabled());
    fireEvent.click(retryDeploy);

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/deploy-environment')).toBe(2));

    expect(hostApiCallCount('/api/remote-fleet/register-connection')).toBe(1);
    expect(hostApiCallCount('/api/remote-fleet/register-environment')).toBe(1);
    expect(hostApiFetchMock.mock.calls
      .map(([path]) => path)
      .filter((path) => path === '/api/remote-fleet/register-connection'
        || path === '/api/remote-fleet/register-environment'
        || path === '/api/remote-fleet/deploy-environment'))
      .toEqual([
        '/api/remote-fleet/register-connection',
        '/api/remote-fleet/register-environment',
        '/api/remote-fleet/deploy-environment',
        '/api/remote-fleet/deploy-environment',
      ]);
    expect(hostApiCallIndex('/api/remote-fleet/install-agent')).toBe(-1);
    expect(hostApiCallIndex('/api/remote-fleet/issue-enrollment-token')).toBe(-1);
  });

  it('deploys a connected container environment directly from its connection detail', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      if (path === '/api/remote-fleet/deploy-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environmentId?: string };
        return { success: true, command: { id: 'deploy-command-1', environmentId: body.environmentId, command: 'remoteFleet.environment.deploy', status: 'queued' } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getResourceTypeControl(/Connections/)).toBeInTheDocument());

    activateControl(getResourceTypeControl(/Connections/));
    fireEvent.click(getIndexedResource(/Docker Prod/));

    const detailPanel = getResourceDetailPanel();
    const associations = within(detailPanel).getByRole('heading', { name: 'Associations' }).closest('section')!;
    expect(within(associations).getByText('Debian environment')).toBeInTheDocument();
    const deployEnvironment = within(associations).getByRole('button', { name: 'Deploy environment' });
    expect(deployEnvironment).toBeEnabled();
    expect(within(detailPanel).queryByRole('heading', { name: 'Remote status' })).not.toBeInTheDocument();
    expect(within(detailPanel).queryByRole('button', { name: 'Debian environment' })).not.toBeInTheDocument();

    fireEvent.click(deployEnvironment);

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/deploy-environment', expect.any(Object)));

    expect(hostApiRequestBody('/api/remote-fleet/deploy-environment')).toEqual({ environmentId: 'environment-1' });
    expect(hostApiCallIndex('/api/remote-fleet/install-agent')).toBe(-1);
    expect(hostApiCallIndex('/api/remote-fleet/issue-enrollment-token')).toBe(-1);
    expect(toastSuccessMock).toHaveBeenCalledWith('Environment deploy command submitted');
  });

  it('deploys a container environment without issuing enrollment tokens or installing a node agent', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      if (path === '/api/remote-fleet/deploy-environment') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { environmentId?: string };
        return { success: true, command: { id: 'deploy-command-1', environmentId: body.environmentId, command: 'remoteFleet.environment.deploy', status: 'queued' } };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getResourceTypeControl(/Environments/)).toBeInTheDocument());

    activateControl(getResourceTypeControl(/Environments/));
    fireEvent.click(getIndexedResource(/Debian environment/));

    expect(screen.getAllByRole('button', { name: 'Deploy environment' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Issue token' })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Deploy environment' })[0]!);

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/deploy-environment', expect.any(Object)));

    expect(hostApiRequestBody('/api/remote-fleet/deploy-environment')).toEqual({ environmentId: 'environment-1' });
    expect(hostApiCallIndex('/api/remote-fleet/install-agent')).toBe(-1);
    expect(hostApiCallIndex('/api/remote-fleet/issue-enrollment-token')).toBe(-1);
    expect(toastSuccessMock).toHaveBeenCalledWith('Environment deploy command submitted');
  });

  it('keeps enrollment token affordances absent while retaining the install agent control', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getResourceTypeControl(/Nodes/)).toBeInTheDocument());
    activateControl(getResourceTypeControl(/Nodes/));
    fireEvent.click(getIndexedResource(/SSH Bastion/));

    const nodeDetailPanel = getResourceDetailPanel();
    fireEvent.pointerDown(within(nodeDetailPanel).getByRole('button', { name: 'More actions' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    });
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Install agent' })).toBeInTheDocument());
    expect(screen.queryByRole('menuitem', { name: /issue token/i })).not.toBeInTheDocument();
    expect(within(nodeDetailPanel).queryByText(/enrollment token/i)).not.toBeInTheDocument();

    expect(hostApiCallIndex('/api/remote-fleet/issue-enrollment-token')).toBe(-1);
  });

  it('opens terminal from a Resource Index node detail without storing the ticket', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      if (path === '/api/remote-fleet/terminal/open') {
        return {
          session: {
            id: 'terminal-session-1',
            nodeId: 'ssh-node-1',
            targetKind: 'ssh-host',
            status: 'connected',
            password: 'session-password-secret',
            secret: 'session-secret-value',
            stdout: 'raw stdout',
            stderr: 'raw stderr',
            ticket: 'session-ticket-secret',
          },
          terminalConnection: {
            sessionId: 'terminal-session-1',
            ticket: 'terminal-ticket-secret',
            websocketPath: '/api/remote-fleet/terminal/stream?sessionId=terminal-session-1&ticket=terminal-ticket-secret',
            expiresAt: '2026-07-08T00:00:30.000Z',
          },
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getResourceTypeControl(/Nodes/)).toBeInTheDocument());
    activateControl(getResourceTypeControl(/Nodes/));
    fireEvent.click(getIndexedResource(/SSH Bastion/));

    const detailPanel = getResourceDetailPanel();
    await waitFor(() => expect(within(detailPanel).getByRole('heading', { name: 'SSH Bastion' })).toBeInTheDocument());
    expect(within(detailPanel).getByText('Node')).toBeInTheDocument();
    activateControl(within(detailPanel).getByRole('tab', { name: 'Terminal' }));
    fireEvent.click(within(detailPanel).getByRole('button', { name: 'Open terminal' }));

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/terminal/open', expect.any(Object)));

    expect(hostApiRequestBody('/api/remote-fleet/terminal/open')).toEqual({
      nodeId: 'ssh-node-1',
      size: { rows: 24, cols: 80 },
    });
    expect(screen.getByLabelText('Remote Fleet terminal')).toBeInTheDocument();
    expect(websocketInstances[0]?.url).toBe('ws://127.0.0.1:3917/api/remote-fleet/terminal/stream?sessionId=terminal-session-1&ticket=terminal-ticket-secret');
    expect(useRemoteFleetStore.getState().sessions).toEqual([
      { id: 'terminal-session-1', nodeId: 'ssh-node-1', targetKind: 'ssh-host', status: 'connected' },
    ]);
    const renderedDom = document.body.innerHTML;
    const storeSnapshot = JSON.stringify(useRemoteFleetStore.getState());
    for (const sensitiveValue of [
      'terminal-ticket-secret',
      'session-ticket-secret',
      'session-password-secret',
      'session-secret-value',
      'raw stdout',
      'raw stderr',
    ]) {
      expect(renderedDom).not.toContain(sensitiveValue);
      expect(storeSnapshot).not.toContain(sensitiveValue);
    }
  });

  it('renders operations left navigation and automatically loads overview metrics once', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      if (path === '/api/remote-fleet/metrics') return metricsProjection;
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot'));
    expect(hostApiCallIndex('/api/remote-fleet/metrics')).toBe(-1);

    activateControl(getModeControl('Operations'));

    const operationsNavigation = screen.getByRole('navigation', { name: 'Operations' });
    const operationsTablist = within(operationsNavigation).getByRole('tablist');
    expect(within(operationsTablist).getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(within(operationsTablist).getByRole('tab', { name: 'Commands' })).toBeInTheDocument();
    expect(within(operationsTablist).getByRole('tab', { name: 'Audit' })).toBeInTheDocument();
    expect(within(operationsTablist).queryByRole('tab', { name: 'Advanced operations' })).not.toBeInTheDocument();
    expect(within(operationsTablist).queryByRole('tab', { name: 'Metrics' })).not.toBeInTheDocument();
    expect(within(operationsTablist).queryByRole('tab', { name: 'Gaps' })).not.toBeInTheDocument();

    const activePanel = screen.getByRole('tabpanel');
    expect(within(activePanel).getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(within(activePanel).getByRole('heading', { name: 'Data coverage' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load metrics' })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/metrics');
      expect(useRemoteFleetStore.getState().metrics).toEqual(metricsProjection);
    });

    expect(hostApiFetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/remote-fleet/snapshot',
      '/api/remote-fleet/metrics',
    ]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('keeps detail selection scoped to the active resource type when the selected type is empty', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') {
        return {
          ...snapshotProjection,
          environments: [],
          managedResources: [],
          agents: [],
          runtimes: [],
          endpoints: [],
          capabilities: [],
          commands: [],
          leases: [],
          auditEvents: [],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'SSH Bastion connection' })).toBeInTheDocument());

    activateControl(getResourceTypeControl(/Environments/));

    await waitFor(() => expect(screen.getByText('No object selected')).toBeInTheDocument());
    expect(getResourceTypeControl(/Environments/)).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('status')).toHaveTextContent('0 of 0');
    expect(screen.getByText('Resources of this type will appear here.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'SSH Bastion connection' })).not.toBeInTheDocument();
  });

  it('does not treat blank resource search as an active filter and exposes live result count', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getIndexedResource(/SSH Bastion connection/)).toBeInTheDocument());

    const resultCount = screen.getByRole('status');
    expect(resultCount).toHaveAttribute('aria-live', 'polite');
    expect(resultCount).toHaveTextContent('3 of 3');

    fireEvent.change(screen.getByRole('textbox', { name: 'Search resources' }), { target: { value: '   ' } });

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('3 of 3'));
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    expect(screen.queryByText('Change or clear the filters to see more resources.')).not.toBeInTheDocument();
  });

  it('resets stale resource filters when switching to a type with different status buckets', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getIndexedResource(/SSH Bastion connection/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Status filter'), { target: { value: 'online' } });
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();

    activateControl(getResourceTypeControl(/Agents/));

    await waitFor(() => expect(getIndexedResource(/agent-1/)).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('1 of 1');
    expect(screen.queryByText('No matching resources')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('keeps commands and audit operations in failed state with retry controls when history loading fails', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      if (path === '/api/remote-fleet/metrics') return metricsProjection;
      if (path === '/api/remote-fleet/list-commands') throw new Error('commands failed with token=password');
      if (path === '/api/remote-fleet/list-audit-events') throw new Error('audit failed with stdout=raw stderr=raw');
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/snapshot'));
    activateControl(getModeControl('Operations'));

    const operationsNavigation = screen.getByRole('navigation', { name: 'Operations' });
    const operationsTabs = within(operationsNavigation).getByRole('tablist');
    fireEvent.click(within(operationsTabs).getByRole('tab', { name: 'Commands' }));

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/list-commands'));
    await waitFor(() => expect(within(screen.getByRole('tabpanel')).getByText('Operations could not be loaded.')).toBeInTheDocument());
    expect(within(screen.getByRole('tabpanel')).getByText('Retry loading command summaries.')).toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel')).queryByText('Not loaded yet')).not.toBeInTheDocument();

    fireEvent.click(within(operationsTabs).getByRole('tab', { name: 'Audit' }));

    await waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('/api/remote-fleet/list-audit-events'));
    const auditPanel = screen.getByRole('tabpanel');
    expect(within(auditPanel).getByLabelText('Event filter')).toBeInTheDocument();
    expect(within(auditPanel).getByRole('option', { name: 'All events' })).toBeInTheDocument();
    expect(within(auditPanel).queryByLabelText('Status filter')).not.toBeInTheDocument();
    await waitFor(() => expect(within(auditPanel).getByText('Operations could not be loaded.')).toBeInTheDocument());
    expect(within(auditPanel).getByText('Retry loading audit summaries.')).toBeInTheDocument();
    expect(within(auditPanel).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('keeps terminal control error payloads out of the DOM, store, and xterm output', async () => {
    const rawTerminalError = 'terminal.error token=password stdout=raw-output stderr=raw-error';
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      if (path === '/api/remote-fleet/terminal/open') {
        return {
          session: {
            id: 'terminal-session-raw-error',
            nodeId: 'ssh-node-1',
            targetKind: 'ssh-host',
            status: 'connected',
          },
          terminalConnection: {
            sessionId: 'terminal-session-raw-error',
            ticket: 'terminal-ticket-raw-error',
            websocketPath: '/api/remote-fleet/terminal/stream?sessionId=terminal-session-raw-error&ticket=terminal-ticket-raw-error',
            expiresAt: '2026-07-08T00:00:30.000Z',
          },
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getIndexedResource(/SSH Bastion connection/)).toBeInTheDocument());
    activateControl(within(getResourceDetailPanel()).getByRole('tab', { name: 'Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));

    await waitFor(() => expect(websocketInstances).toHaveLength(1));
    act(() => {
      websocketInstances[0]!.emit('message', {
        data: JSON.stringify({
          type: 'terminal.error',
          message: rawTerminalError,
          stdout: rawTerminalError,
          stderr: rawTerminalError,
        }),
      });
    });

    await waitFor(() => expect(screen.getByText('The remote terminal reported an error. Close the terminal or reconnect.')).toBeInTheDocument());

    expect(document.body.innerHTML).not.toContain(rawTerminalError);
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain(rawTerminalError);
    expect(terminalInstances[0]?.write).not.toHaveBeenCalled();
    expect(terminalInstances[0]?.writeln).not.toHaveBeenCalled();
  });

  it('does not project raw terminal open errors into the store or UI', async () => {
    const rawOpenError = 'open failed token=password stdout=raw-output stderr=raw-error';
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      if (path === '/api/remote-fleet/terminal/open') throw new Error(rawOpenError);
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getIndexedResource(/SSH Bastion connection/)).toBeInTheDocument());
    activateControl(within(getResourceDetailPanel()).getByRole('tab', { name: 'Terminal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));

    await waitFor(() => expect(screen.getByText('The terminal could not be opened. Confirm the target is available and terminal access is enabled, then try again.')).toBeInTheDocument());

    expect(useRemoteFleetStore.getState().error).toBe('打开 Remote Fleet 终端失败');
    expect(document.body.innerHTML).not.toContain(rawOpenError);
    expect(JSON.stringify(useRemoteFleetStore.getState())).not.toContain(rawOpenError);
    expect(terminalInstances[0]?.write).not.toHaveBeenCalled();
    expect(terminalInstances[0]?.writeln).not.toHaveBeenCalled();
  });

  it('requires Resource Index node selection before opening a terminal for a connection with multiple nodes', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') {
        return {
          ...snapshotProjection,
          nodes: [
            sshNode,
            {
              ...sshNode,
              id: 'ssh-node-2',
              displayName: 'SSH worker node',
              managedResourceId: 'managed-resource-ssh-2',
            },
            vmNode,
            containerNode,
          ],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'SSH Bastion connection' })).toBeInTheDocument());
    const connectionDetailPanel = getResourceDetailPanel();
    activateControl(within(connectionDetailPanel).getByRole('tab', { name: 'Terminal' }));

    expect(within(connectionDetailPanel).getByText('This connection has multiple nodes. Select a node in Resource Index, then open its terminal.')).toBeInTheDocument();
    expect(within(connectionDetailPanel).queryByRole('button', { name: 'Open terminal' })).not.toBeInTheDocument();
    expect(within(connectionDetailPanel).queryByRole('button', { name: /Open related/ })).not.toBeInTheDocument();
    expect(hostApiCallIndex('/api/remote-fleet/terminal/open')).toBe(-1);
    expect(websocketInstances).toHaveLength(0);

    activateControl(getResourceTypeControl(/Nodes/));
    fireEvent.click(getIndexedResource(/SSH Bastion/));

    const nodeDetailPanel = getResourceDetailPanel();
    await waitFor(() => expect(within(nodeDetailPanel).getByRole('heading', { name: 'SSH Bastion' })).toBeInTheDocument());
    expect(within(nodeDetailPanel).getByRole('button', { name: 'Open terminal' })).toBeInTheDocument();
    expect(within(nodeDetailPanel).queryByRole('button', { name: /Open related/ })).not.toBeInTheDocument();
    expect(hostApiCallIndex('/api/remote-fleet/terminal/open')).toBe(-1);
    expect(websocketInstances).toHaveLength(0);
  });

  it('renders endpoint and connection URLs without credentials or query while preserving ports', async () => {
    const sensitiveConnection = {
      ...sshConnection,
      id: 'connection-sensitive-url',
      displayName: 'Sensitive URL connection',
      endpointUrl: 'ssh://ops:password@example.internal:2222/work?token=connection-token',
    };
    const sensitiveNode = {
      ...sshNode,
      id: 'node-sensitive-url',
      connectionId: sensitiveConnection.id,
      endpointUrl: sensitiveConnection.endpointUrl,
    };
    const sensitiveRuntime = {
      ...snapshotProjection.runtimes[0]!,
      id: 'runtime-sensitive-url',
      connectionId: sensitiveConnection.id,
      nodeId: sensitiveNode.id,
      endpointId: 'endpoint-sensitive-url',
    };
    const sensitiveEndpoint = {
      ...snapshotProjection.endpoints[0]!,
      id: 'endpoint-sensitive-url',
      connectionId: sensitiveConnection.id,
      nodeId: sensitiveNode.id,
      runtimeId: sensitiveRuntime.id,
      url: 'https://user:password@runtime.example.internal:8443/sessions?ticket=endpoint-ticket&token=endpoint-token',
    };

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') {
        return {
          ...snapshotProjection,
          connections: [sensitiveConnection],
          environments: [],
          managedResources: [],
          nodes: [sensitiveNode],
          agents: [],
          runtimes: [sensitiveRuntime],
          endpoints: [sensitiveEndpoint],
          capabilities: [],
          commands: [],
          leases: [],
          auditEvents: [],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sensitive URL connection' })).toBeInTheDocument());
    expect(screen.getByText('example.internal:2222/work')).toBeInTheDocument();

    activateControl(getResourceTypeControl(/Endpoints/));
    await waitFor(() => expect(getIndexedResource(/endpoint-sensitive-url/)).toBeInTheDocument());
    fireEvent.click(getIndexedResource(/endpoint-sensitive-url/));

    expect(screen.getByText('runtime.example.internal:8443/sessions')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('ops:password');
    expect(document.body.innerHTML).not.toContain('user:password');
    expect(document.body.innerHTML).not.toContain('connection-token');
    expect(document.body.innerHTML).not.toContain('endpoint-ticket');
    expect(document.body.innerHTML).not.toContain('endpoint-token');
  });

  it('redacts sensitive resource kind and environment labels in Resource Index filters', async () => {
    const sensitiveResourceKind = 'token=managed-resource-kind';
    const sensitiveEnvironmentName = 'password=sensitive-environment';
    const sensitiveEnvironment = {
      ...sshEnvironment,
      id: 'environment-sensitive',
      connectionId: 'connection-unrelated',
      displayName: sensitiveEnvironmentName,
    };
    const sensitiveManagedResource = {
      ...sshManagedResource,
      id: 'managed-resource-sensitive',
      connectionId: sensitiveEnvironment.connectionId,
      environmentId: sensitiveEnvironment.id,
      displayName: 'Sensitive resource projection',
      resourceKind: sensitiveResourceKind,
      providerKind: undefined,
    };

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') {
        return {
          ...snapshotProjection,
          environments: [sshEnvironment, sensitiveEnvironment],
          managedResources: [sshManagedResource, sensitiveManagedResource],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getResourceTypeControl(/Resources/)).toBeInTheDocument());
    activateControl(getResourceTypeControl(/Resources/));

    const resourceIndex = getResourceIndex();
    const kindFilter = within(resourceIndex).getByLabelText('Kind filter');
    const environmentFilter = within(resourceIndex).getByLabelText('Environment filter');
    expect(within(kindFilter).getByRole('option', { name: '••••••' })).toHaveValue('••••••');
    expect(within(environmentFilter).getByRole('option', { name: '••••••' })).toHaveValue('environment-sensitive');

    fireEvent.change(kindFilter, { target: { value: '••••••' } });

    await waitFor(() => expect(within(resourceIndex).getByRole('status')).toHaveTextContent('1 of 2'));
    expect(within(resourceIndex).getByRole('button', { name: /Sensitive resource projection/ })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(sensitiveResourceKind);
    expect(document.body.innerHTML).not.toContain(sensitiveEnvironmentName);
  });

  it('keeps destructive environment delete out of the primary action slot', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return snapshotProjection;
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getResourceTypeControl(/Environments/)).toBeInTheDocument());

    activateControl(getResourceTypeControl(/Environments/));
    fireEvent.click(getIndexedResource(/Debian environment/));

    const detailPanel = getResourceDetailPanel();
    expect(within(detailPanel).getByRole('button', { name: 'Deploy environment' })).toBeInTheDocument();
    expect(within(detailPanel).getByRole('button', { name: 'More actions' })).toBeInTheDocument();
    expect(within(detailPanel).queryByRole('button', { name: 'Delete environment' })).not.toBeInTheDocument();
  });

  it('confirms a standalone connection delete from More actions and applies the returned snapshot', async () => {
    const disposableConnection = {
      id: 'connection-disposable',
      displayName: 'Disposable SSH connection',
      connectionKind: 'ssh-host',
      targetKind: 'ssh-host',
      endpointUrl: 'ssh://disposable.example.internal:22',
      status: 'online',
      labels: ['test'],
    };
    const initialSnapshot = deletionSnapshot({ connections: [disposableConnection] });
    const deletedSnapshot = deletionSnapshot();

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return initialSnapshot;
      if (path === '/api/remote-fleet/delete-connection') return { snapshot: deletedSnapshot };
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getIndexedResource(/Disposable SSH connection/)).toBeInTheDocument());

    const detailPanel = getResourceDetailPanel();
    await openMoreActions(detailPanel);
    const deleteAction = screen.getByRole('menuitem', { name: 'Delete connection' });
    expect(deleteAction).toBeInTheDocument();
    fireEvent.click(deleteAction);

    const confirmationDialog = await screen.findByRole('dialog');
    expect(within(confirmationDialog).getByRole('heading', { name: 'Delete connection?' })).toBeInTheDocument();
    expect(within(confirmationDialog).getByText(/delete.*connection|connection.*deleted/i, { selector: 'p' })).toBeInTheDocument();

    fireEvent.click(within(confirmationDialog).getByRole('button', { name: 'Delete connection' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/delete-connection')).toBe(1));
    expect(hostApiRequestBody('/api/remote-fleet/delete-connection')).toEqual({ connectionId: disposableConnection.id });
    expect(useRemoteFleetStore.getState().connections).toEqual([]);
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringMatching(/connection.*deleted|deleted.*connection/i));
  });

  it('disables connection delete with guidance while the connection still has related resources', async () => {
    const connectedEnvironment = {
      id: 'environment-connected',
      connectionId: 'connection-connected',
      displayName: 'Connected environment',
      environmentKind: 'ssh-workdir',
      targetKind: 'ssh-host',
      status: 'environment-ready',
      labels: ['test'],
    };
    const connectedNode = {
      id: 'node-connected',
      connectionId: 'connection-connected',
      environmentId: connectedEnvironment.id,
      displayName: 'Connected node',
      targetKind: 'ssh-host',
      status: 'online',
      labels: ['test'],
    };
    const connectionWithAssociations = {
      id: 'connection-connected',
      displayName: 'Connected SSH connection',
      connectionKind: 'ssh-host',
      targetKind: 'ssh-host',
      endpointUrl: 'ssh://connected.example.internal:22',
      status: 'online',
      labels: ['test'],
    };

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') {
        return deletionSnapshot({
          connections: [connectionWithAssociations],
          environments: [connectedEnvironment],
          nodes: [connectedNode],
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getIndexedResource(/Connected SSH connection/)).toBeInTheDocument());

    const detailPanel = getResourceDetailPanel();
    await openMoreActions(detailPanel);
    expect(screen.queryByRole('menuitem', { name: 'Delete connection' })).toBeInTheDocument();
    expect(within(detailPanel).getByText('This connection can only be deleted after its Environments are deleted and its direct nodes and resources are removed.')).toBeInTheDocument();
    expect(hostApiCallCount('/api/remote-fleet/delete-connection')).toBe(0);
  });

  it('confirms environment deletion when its managed remote resource will be deleted', async () => {
    const managedEnvironment = {
      id: 'environment-managed-delete',
      connectionId: 'connection-managed-delete',
      displayName: 'Managed deletion environment',
      environmentKind: 'docker-container',
      targetKind: 'container',
      status: 'environment-ready',
      labels: ['test'],
      managedResourceIds: ['resource-managed-delete'],
    };
    const managedResource = {
      id: 'resource-managed-delete',
      connectionId: managedEnvironment.connectionId,
      environmentId: managedEnvironment.id,
      displayName: 'Managed remote resource',
      providerKind: 'docker',
      resourceKind: 'docker-container',
      status: 'running',
      ownership: 'matcha-managed',
      cleanupPolicy: 'delete-on-environment-delete',
    };
    const initialSnapshot = deletionSnapshot({
      connections: [{
        id: managedEnvironment.connectionId,
        displayName: 'Managed deletion connection',
        connectionKind: 'container',
        targetKind: 'container',
        endpointUrl: 'https://managed-delete.example.internal:2376',
        status: 'online',
        labels: ['test'],
      }],
      environments: [managedEnvironment],
      managedResources: [managedResource],
    });
    const deletedSnapshot = deletionSnapshot({ connections: initialSnapshot.connections });

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return initialSnapshot;
      if (path === '/api/remote-fleet/delete-environment') return { snapshot: deletedSnapshot };
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getResourceTypeControl(/Environments/)).toBeInTheDocument());
    activateControl(getResourceTypeControl(/Environments/));
    fireEvent.click(getIndexedResource(/Managed deletion environment/));

    await openMoreActions(getResourceDetailPanel());
    const deleteAction = screen.getByRole('menuitem', { name: 'Delete environment' });
    expect(deleteAction).toBeInTheDocument();
    fireEvent.click(deleteAction);

    const confirmationDialog = await screen.findByRole('dialog');
    expect(within(confirmationDialog).getByRole('heading', { name: 'Delete environment?' })).toBeInTheDocument();
    expect(within(confirmationDialog).getByText(/managed remote resources selected for deletion/i, { selector: 'p' })).toBeInTheDocument();

    fireEvent.click(within(confirmationDialog).getByRole('button', { name: 'Delete environment' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/delete-environment')).toBe(1));
    expect(hostApiRequestBody('/api/remote-fleet/delete-environment')).toEqual({ environmentId: managedEnvironment.id });
    expect(useRemoteFleetStore.getState().environments).toEqual([]);
    expect(useRemoteFleetStore.getState().managedResources).toEqual([]);
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringMatching(/environment.*deleted|deleted.*environment/i));
  });

  it('warns when environment deletion leaves an external remote resource unchanged', async () => {
    const externalEnvironment = {
      id: 'environment-external-retained',
      connectionId: 'connection-external-retained',
      displayName: 'External retention environment',
      environmentKind: 'ssh-workdir',
      targetKind: 'ssh-host',
      status: 'environment-ready',
      labels: ['test'],
      managedResourceIds: ['resource-external-retained'],
    };
    const externalResource = {
      id: 'resource-external-retained',
      connectionId: externalEnvironment.connectionId,
      environmentId: externalEnvironment.id,
      displayName: 'External remote resource',
      providerKind: 'ssh',
      resourceKind: 'ssh-agent-installation',
      status: 'running',
      ownership: 'external',
      cleanupPolicy: 'retain',
    };
    const initialSnapshot = deletionSnapshot({
      connections: [{
        id: externalEnvironment.connectionId,
        displayName: 'External retention connection',
        connectionKind: 'ssh-host',
        targetKind: 'ssh-host',
        endpointUrl: 'ssh://external-retained.example.internal:22',
        status: 'online',
        labels: ['test'],
      }],
      environments: [externalEnvironment],
      managedResources: [externalResource],
    });
    const deletedSnapshot = deletionSnapshot({
      connections: initialSnapshot.connections,
      managedResources: [externalResource],
    });

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return initialSnapshot;
      if (path === '/api/remote-fleet/delete-environment') return { snapshot: deletedSnapshot };
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getResourceTypeControl(/Environments/)).toBeInTheDocument());
    activateControl(getResourceTypeControl(/Environments/));
    fireEvent.click(getIndexedResource(/External retention environment/));

    await openMoreActions(getResourceDetailPanel());
    const deleteAction = screen.getByRole('menuitem', { name: 'Delete environment' });
    expect(deleteAction).toBeInTheDocument();
    fireEvent.click(deleteAction);

    const confirmationDialog = await screen.findByRole('dialog');
    expect(within(confirmationDialog).getByText(/remote resource.*left unchanged/i, { selector: 'p' })).toBeInTheDocument();

    fireEvent.click(within(confirmationDialog).getByRole('button', { name: 'Delete environment' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/delete-environment')).toBe(1));
    expect(useRemoteFleetStore.getState().environments).toEqual([]);
    expect(useRemoteFleetStore.getState().managedResources).toEqual([externalResource]);
    expect(toastWarningMock).toHaveBeenCalledWith(expect.stringMatching(/left unchanged/i));
  });

  it('reports environment deletion failure when an HTTP-success snapshot retains the environment as failed', async () => {
    const failedEnvironment = {
      id: 'environment-delete-failed',
      connectionId: 'connection-delete-failed',
      displayName: 'Failed deletion environment',
      environmentKind: 'docker-container',
      targetKind: 'container',
      status: 'environment-ready',
      labels: ['test'],
    };
    const initialSnapshot = deletionSnapshot({
      connections: [{
        id: failedEnvironment.connectionId,
        displayName: 'Failed deletion connection',
        connectionKind: 'container',
        targetKind: 'container',
        endpointUrl: 'https://failed-delete.example.internal:2376',
        status: 'online',
        labels: ['test'],
      }],
      environments: [failedEnvironment],
    });
    const failedDeleteSnapshot = deletionSnapshot({
      connections: initialSnapshot.connections,
      environments: [{ ...failedEnvironment, status: 'failed' }],
    });

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/remote-fleet/snapshot') return initialSnapshot;
      if (path === '/api/remote-fleet/delete-environment') return { snapshot: failedDeleteSnapshot };
      throw new Error(`unexpected path: ${path}`);
    });

    renderRemoteFleetPage();

    await waitFor(() => expect(getResourceTypeControl(/Environments/)).toBeInTheDocument());
    activateControl(getResourceTypeControl(/Environments/));
    fireEvent.click(getIndexedResource(/Failed deletion environment/));

    await openMoreActions(getResourceDetailPanel());
    const deleteAction = screen.getByRole('menuitem', { name: 'Delete environment' });
    expect(deleteAction).toBeInTheDocument();
    fireEvent.click(deleteAction);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete environment' }));

    await waitFor(() => expect(hostApiCallCount('/api/remote-fleet/delete-environment')).toBe(1));
    expect(hostApiRequestBody('/api/remote-fleet/delete-environment')).toEqual({ environmentId: failedEnvironment.id });
    expect(useRemoteFleetStore.getState().environments).toEqual([{ ...failedEnvironment, status: 'failed' }]);
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/not deleted|cleanup did not complete/i));
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });
});
