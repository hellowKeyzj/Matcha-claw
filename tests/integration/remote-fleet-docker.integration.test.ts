import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createRemoteFleetDockerBootstrapProvider } from '../../runtime-host/application/remote-fleet/remote-fleet-bootstrap-docker-provider';
import { createRemoteFleetTerminalDockerProvider } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-docker-provider';
import { RemoteFleetTerminalManager } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-manager';
import { createRemoteFleetTerminalProviderRegistry } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-providers';
import type {
  RemoteFleetBootstrapCommandEnvelope,
  RemoteFleetBootstrapProviderContext,
} from '../../runtime-host/application/remote-fleet/remote-fleet-bootstrap';
import type { RuntimeHttpResponse } from '../../runtime-host/application/common/runtime-ports';
import type {
  RemoteFleetNodeRecord,
  RuntimeAgentRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';

const runDockerE2E = process.env.MATCHACLAW_REMOTE_FLEET_DOCKER_E2E === '1';
const describeDockerE2E = runDockerE2E ? describe : describe.skip;
const dockerEndpoint = process.env.MATCHACLAW_REMOTE_FLEET_DOCKER_ENDPOINT || 'http://127.0.0.1:2375';
const e2eContainerNamePrefix = 'matchaclaw-remote-fleet-e2e-';
const now = '2026-07-09T00:00:00.000Z';

function e2eId(): string {
  return randomUUID().replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 12);
}

function dockerApiUrl(pathname: string, query: Readonly<Record<string, string>> = {}): string {
  const url = new URL(dockerEndpoint);
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  url.search = '';
  url.hash = '';
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

async function dockerRequest(pathname: string, init: RequestInit = {}, query: Readonly<Record<string, string>> = {}, timeoutMs = 120_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(dockerApiUrl(pathname, query), { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function removeE2eContainer(containerName: string): Promise<void> {
  if (!containerName.startsWith(e2eContainerNamePrefix)) {
    throw new Error(`Refusing to remove non-E2E Docker container: ${containerName}`);
  }
  const response = await dockerRequest(`/containers/${encodeURIComponent(containerName)}`, { method: 'DELETE' }, { force: '1', v: '1' });
  await response.text().catch(() => '');
}

function nodeRecord(input: { readonly nodeId: string; readonly containerName: string }): RemoteFleetNodeRecord {
  return {
    id: input.nodeId,
    displayName: 'Docker E2E Node',
    targetKind: 'container',
    labels: ['e2e'],
    enabled: true,
    publicConfig: {
      docker: {
        endpointUrl: dockerEndpoint,
        containerName: input.containerName,
      },
    },
    secretRefs: {},
    health: { reason: 'online', lastCheckedAt: now },
    createdAt: now,
    updatedAt: now,
  };
}

function agentRecord(input: { readonly agentId: string; readonly nodeId: string }): RuntimeAgentRecord {
  return {
    id: input.agentId,
    nodeId: input.nodeId,
    displayName: 'Docker E2E Agent',
    enrollment: { reason: 'not-installed' },
    capabilities: [],
    createdAt: now,
    updatedAt: now,
  };
}

function bootstrapEnvelope(input: { readonly node: RemoteFleetNodeRecord; readonly agent: RuntimeAgentRecord }): RemoteFleetBootstrapCommandEnvelope {
  return {
    envelopeVersion: 'remote-fleet-bootstrap-command/v1',
    commandId: 'cmd-docker-e2e',
    idempotencyKey: 'idem-docker-e2e',
    commandName: 'install-agent',
    providerKind: 'docker',
    nodeId: input.node.id,
    agentId: input.agent.id,
    node: input.node,
    agent: input.agent,
  };
}

function providerContext(): RemoteFleetBootstrapProviderContext {
  return {
    httpClient: {
      request: async (url, init): Promise<RuntimeHttpResponse> => await fetch(url, init),
    },
    secrets: {
      readSecret: async (secretRefName) => ({
        resultType: 'missing' as const,
        secretRefName,
      }),
    },
  };
}

async function createDetachedExec(containerName: string, command: readonly string[]): Promise<string> {
  const response = await dockerRequest(`/containers/${encodeURIComponent(containerName)}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ AttachStdout: true, AttachStderr: true, Tty: false, Cmd: command }),
  });
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  const body = await response.json() as { Id?: unknown };
  expect(typeof body.Id).toBe('string');
  return body.Id as string;
}

async function startDetachedExec(execId: string): Promise<void> {
  const response = await dockerRequest(`/exec/${encodeURIComponent(execId)}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Detach: true, Tty: false }),
  });
  await response.text().catch(() => '');
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
}

async function waitForExecExitCode(execId: string): Promise<number> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await dockerRequest(`/exec/${encodeURIComponent(execId)}/json`);
    expect(response.status).toBe(200);
    const body = await response.json() as { ExitCode?: unknown };
    if (typeof body.ExitCode === 'number') return body.ExitCode;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Docker exec did not finish: ${execId}`);
}

async function createTerminalStreamServer(manager: RemoteFleetTerminalManager): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    void manager.attachWebSocket(req, socket, head).then((handled) => {
      if (!handled && !socket.destroyed) socket.destroy();
    }).catch(() => {
      if (!socket.destroyed) socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Terminal stream server did not bind to a TCP port.');
  return { server, port: (address as AddressInfo).port };
}

async function waitForTerminalOutput(ws: WebSocket, needle: string): Promise<string> {
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for terminal output ${needle}. Last output: ${output}`)), 60_000);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      output += Buffer.from(data as Buffer).toString('utf8');
      if (output.includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    ws.on('close', () => {
      clearTimeout(timer);
      reject(new Error(`Terminal WebSocket closed before ${needle}. Last output: ${output}`));
    });
  });
  return output;
}

describeDockerE2E('Remote Fleet Docker integration', () => {
  let containerName = '';

  beforeEach(async () => {
    const ping = await dockerRequest('/_ping');
    expect(ping.status).toBe(200);
    expect((await ping.text()).trim()).toBe('OK');
    const runId = `${process.pid}-${e2eId()}`;
    containerName = `${e2eContainerNamePrefix}${runId}`;
    await removeE2eContainer(containerName).catch(() => undefined);
  });

  afterEach(async () => {
    if (containerName) await removeE2eContainer(containerName).catch(() => undefined);
    containerName = '';
  });

  it('starts a managed Debian environment and makes setup tools available', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const node = nodeRecord({ nodeId: `node-docker-e2e-${e2eId()}`, containerName });
    const agent = agentRecord({ agentId: `${node.id}:agent`, nodeId: node.id });

    const result = await provider.dispatchCommand(bootstrapEnvelope({ node, agent }), providerContext());

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-docker-e2e',
      providerKind: 'docker',
      message: 'Docker environment container started.',
    });
    if (result.resultType !== 'completed') throw new Error(result.message);
    expect(result.remoteResourceId).toBeTruthy();
    expect(result.outputSummary).toContain(containerName);
    expect(JSON.stringify(result)).not.toContain('docker-bearer-secret');

    const execId = await createDetachedExec(containerName, [
      '/bin/sh',
      '-lc',
      'cat /etc/debian_version >/dev/null && command -v git >/dev/null && command -v curl >/dev/null && command -v ssh >/dev/null',
    ]);
    await startDetachedExec(execId);
    await expect(waitForExecExitCode(execId)).resolves.toBe(0);
  }, 900_000);

  it('opens an interactive terminal to the managed Debian environment', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const node = nodeRecord({ nodeId: `node-docker-e2e-${e2eId()}`, containerName });
    const agent = agentRecord({ agentId: `${node.id}:agent`, nodeId: node.id });
    const result = await provider.dispatchCommand(bootstrapEnvelope({ node, agent }), providerContext());
    if (result.resultType !== 'completed') throw new Error(result.message);

    const manager = new RemoteFleetTerminalManager({
      providers: createRemoteFleetTerminalProviderRegistry([createRemoteFleetTerminalDockerProvider()]),
    });
    const { server, port } = await createTerminalStreamServer(manager);
    try {
      const issued = manager.issueConnectionTicket({
        reason: 'open',
        nowIso: now,
        session: {
          id: `terminal-session-${e2eId()}`,
          nodeId: node.id,
          targetKind: node.targetKind,
          status: 'opening',
          createdAt: now,
          updatedAt: now,
        },
        node,
        size: { rows: 24, cols: 80 },
      });
      expect(issued.resultType).toBe('issued');
      if (issued.resultType !== 'issued') throw new Error('terminal ticket was not issued');

      const ws = new WebSocket(`ws://127.0.0.1:${port}${issued.terminalConnection.websocketPath}`);
      await new Promise<void>((resolve, reject) => {
        ws.once('error', reject);
        ws.once('open', resolve);
      });
      const readyFrame = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for terminal.ready')), 30_000);
        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          clearTimeout(timer);
          resolve(JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as Record<string, unknown>);
        });
        ws.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      if (readyFrame.type !== 'terminal.ready') {
        throw new Error(`Expected terminal.ready, received ${JSON.stringify(readyFrame)}`);
      }

      ws.send(Buffer.from(`printf '\\144\\157\\143\\153\\145\\162\\055\\164\\145\\162\\155\\151\\156\\141\\154\\055\\145\\062\\145\\055\\157\\153\\012'\n`));
      const output = await waitForTerminalOutput(ws, 'docker-terminal-e2e-ok');
      expect(output).toContain('docker-terminal-e2e-ok');
      ws.send(JSON.stringify({ type: 'terminal.close', reason: 'e2e complete' }));
      ws.close();
    } finally {
      manager.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 900_000);
});
