import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteFleetNodeRecord, RemoteFleetSecretRef } from '../../runtime-host/application/remote-fleet/remote-fleet-model';
import type { RemoteFleetTerminalOpenRequest } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-providers';
import type {
  RemoteFleetDockerApiRequest,
  RemoteFleetDockerApiResponse,
  RemoteFleetDockerExecClient,
  RemoteFleetDockerExecStartRequest,
  RemoteFleetDockerExecStream,
} from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-docker-provider';
import { createRemoteFleetTerminalDockerProvider } from '../../runtime-host/application/remote-fleet/remote-fleet-terminal-docker-provider';
import { readRemoteFleetDockerTerminalProviderConfig } from '../../runtime-host/application/remote-fleet/remote-fleet-docker-target-config';

const now = '2026-07-08T00:00:00.000Z';
const dockerBearerToken = 'docker-terminal-bearer-secret';
const dockerBearerTokenRef: RemoteFleetSecretRef = { kind: 'secret-ref', ref: 'remote-fleet://node-1/docker-bearer-token' };

type RecordedRequest = RemoteFleetDockerApiRequest;
type RecordedStart = RemoteFleetDockerExecStartRequest;

class MockDockerExecStream extends EventEmitter implements RemoteFleetDockerExecStream {
  readonly writes: Uint8Array[] = [];
  closed = false;

  write(data: Uint8Array): void {
    this.writes.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emitData(data: string): void {
    this.emit('data', new TextEncoder().encode(data));
  }

  emitExit(event: { readonly exitCode?: number; readonly signal?: string }): void {
    this.emit('exit', event);
  }

  emitError(error: Error): void {
    this.emit('error', error);
  }
}

class RecordingDockerExecClient implements RemoteFleetDockerExecClient {
  readonly requests: RecordedRequest[] = [];
  readonly starts: RecordedStart[] = [];
  readonly stream = new MockDockerExecStream();
  private readonly responses: RemoteFleetDockerApiResponse[];

  constructor(responses: RemoteFleetDockerApiResponse[] = [dockerResponse({ status: 201, body: { Id: 'exec-123' } }), dockerResponse({ status: 200 })]) {
    this.responses = [...responses];
  }

  readonly request = vi.fn(async (input: RemoteFleetDockerApiRequest) => {
    this.requests.push(input);
    const next = this.responses.shift();
    if (!next) throw new Error('unexpected Docker API request');
    return next;
  });

  readonly start = vi.fn(async (input: RemoteFleetDockerExecStartRequest) => {
    this.starts.push(input);
    return { resultType: 'opened' as const, stream: this.stream };
  });
}

function dockerResponse(input: {
  readonly status: number;
  readonly body?: unknown;
  readonly text?: string;
}): RemoteFleetDockerApiResponse {
  return {
    ok: input.status >= 200 && input.status < 300,
    status: input.status,
    json: async () => input.body ?? {},
    text: async () => input.text ?? JSON.stringify(input.body ?? {}),
  };
}

function nodeRecord(overrides: Partial<RemoteFleetNodeRecord> = {}): RemoteFleetNodeRecord {
  return {
    id: 'node-1',
    displayName: 'Docker Node',
    targetKind: 'container',
    labels: [],
    enabled: true,
    publicConfig: {
      docker: {
        endpointUrl: 'https://docker.example.test:2376/api',
        containerName: 'debian-env-container',
        terminal: { command: ['/bin/bash', '-l'] },
      },
    },
    secretRefs: {
      dockerBearerToken: dockerBearerTokenRef,
    },
    health: { reason: 'unknown' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function openRequest(overrides: Partial<RemoteFleetTerminalOpenRequest> = {}): RemoteFleetTerminalOpenRequest {
  const node = overrides.node ?? nodeRecord();
  return {
    session: {
      id: 'terminal-session-1',
      nodeId: node.id,
      targetKind: node.targetKind,
      status: 'opening',
      createdAt: now,
      updatedAt: now,
    },
    node,
    rows: 24,
    cols: 80,
    secretResolver: {
      resolveSecret: vi.fn(async (input) => ({
        resultType: 'resolved' as const,
        secretRef: input.secretRef,
        plaintextSecretValue: dockerBearerToken,
      })),
    },
    ...overrides,
  };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function requestUrl(request: RemoteFleetDockerApiRequest): string {
  return new URL(request.path, request.endpointUrl).toString();
}

function expectJsonDoesNotLeakSecrets(value: unknown, secrets: readonly string[]): void {
  const textValue = JSON.stringify(value);
  for (const secret of secrets) {
    expect(textValue).not.toContain(secret);
  }
}

describe('Remote Fleet Docker terminal provider', () => {
  it('merges shared connection endpoint/auth with separate Docker terminal environments', () => {
    const connectionPublicConfig = {
      docker: {
        endpointUrl: 'https://shared-docker.example.test:2376/api',
      },
    };
    const connectionSecretRefs = {
      dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connection-1/docker-bearer-token' },
    };

    const blueConfig = readRemoteFleetDockerTerminalProviderConfig({
      connectionPublicConfig,
      connectionSecretRefs,
      nodePublicConfig: {
        docker: {
          endpointUrl: 'https://node-blue-docker.example.test:2376/api',
          containerName: 'blue-runtime-container',
          terminal: { command: ['sh'] },
        },
      },
      nodeSecretRefs: {
        dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://node-blue/docker-bearer-token' },
      },
      nodeId: 'node-blue',
    });
    const greenConfig = readRemoteFleetDockerTerminalProviderConfig({
      connectionPublicConfig,
      connectionSecretRefs,
      nodePublicConfig: {
        docker: {
          containerName: 'green-runtime-container',
          terminal: { command: ['bash'] },
        },
      },
      nodeId: 'node-green',
    });

    expect(blueConfig).toMatchObject({
      resultType: 'valid',
      config: {
        endpointUrl: 'https://shared-docker.example.test:2376/api',
        containerRef: 'blue-runtime-container',
        terminalCommand: ['sh'],
        dockerBearerTokenSecretRef: 'remote-fleet://connection-1/docker-bearer-token',
      },
    });
    expect(greenConfig).toMatchObject({
      resultType: 'valid',
      config: {
        endpointUrl: 'https://shared-docker.example.test:2376/api',
        containerRef: 'green-runtime-container',
        terminalCommand: ['bash'],
        dockerBearerTokenSecretRef: 'remote-fleet://connection-1/docker-bearer-token',
      },
    });
    if (blueConfig.resultType !== 'valid' || greenConfig.resultType !== 'valid') throw new Error('expected valid configs');
    expect(blueConfig.config.containerRef).not.toBe(greenConfig.config.containerRef);
  });

  it('rejects unsafe Docker connection publicConfig without leaking token material', () => {
    const result = readRemoteFleetDockerTerminalProviderConfig({
      connectionPublicConfig: {
        docker: {
          endpointUrl: 'https://docker.example.test:2376',
          dockerBearerToken: 'super-secret',
        },
      },
      connectionSecretRefs: {
        dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connection-1/docker-bearer-token' },
      },
      nodePublicConfig: {
        docker: {
          containerName: 'runtime-container',
          terminal: { command: 'sh' },
        },
      },
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      resultType: 'invalid',
      message: 'Remote Fleet Docker connection publicConfig contains unsafe credential material at publicConfig.docker.dockerBearerToken.',
    });
    expectJsonDoesNotLeakSecrets(result, ['super-secret']);
  });

  it.each([
    'http://127.0.0.1:2375',
    'https://docker.example.test:2376',
  ])('does not reject supported Docker endpoint protocols during terminal config resolution: %s', (endpointUrl) => {
    expect(readRemoteFleetDockerTerminalProviderConfig({
      nodePublicConfig: {
        docker: {
          endpointUrl,
          containerName: 'runtime-container',
        },
      },
      nodeId: 'node-valid-endpoint',
    })).toMatchObject({
      resultType: 'valid',
      config: { endpointUrl },
    });
  });

  it('opens a Docker terminal from the legacy top-level connection endpoint URL', async () => {
    const endpointUrl = 'https://legacy-docker.example.test:2376/api';
    const execClient = new RecordingDockerExecClient();
    const provider = createRemoteFleetTerminalDockerProvider({ execClient });

    const result = await provider.open(openRequest({
      connection: {
        id: 'connection-1',
        displayName: 'Legacy Docker connection',
        connectionKind: 'container',
        endpointUrl,
        labels: [],
        enabled: true,
        publicConfig: {},
        secretRefs: {},
        health: { reason: 'unknown' },
        createdAt: now,
        updatedAt: now,
      },
      node: nodeRecord({
        publicConfig: {
          docker: {
            containerName: 'legacy-endpoint-container',
          },
        },
        secretRefs: {},
      }),
      secretResolver: undefined,
    }));

    expect(result.resultType).toBe('opened');
    expect(execClient.requests).toHaveLength(2);
    expect(execClient.starts).toHaveLength(1);
    expect(execClient.requests[0]).toMatchObject({
      endpointUrl,
      path: '/containers/legacy-endpoint-container/exec',
    });
    expect(execClient.starts[0]).toMatchObject({ endpointUrl, execId: 'exec-123' });
  });

  it('uses the linked environment Docker container rather than the default node container', async () => {
    const execClient = new RecordingDockerExecClient();
    const provider = createRemoteFleetTerminalDockerProvider({ execClient });

    const result = await provider.open(openRequest({
      environment: {
        id: 'environment-terminal-target',
        connectionId: 'connection-terminal-target',
        nodeId: 'node-1',
        displayName: 'Environment Terminal Target',
        environmentKind: 'docker-container',
        labels: [],
        enabled: true,
        publicConfig: {
          docker: {
            containerName: 'environment-container',
            terminal: { command: ['sh'] },
          },
        },
        secretRefs: {},
        lifecycle: { reason: 'deployed' },
        managedResourceIds: [],
        createdAt: now,
        updatedAt: now,
      },
    }));

    expect(result).toMatchObject({ resultType: 'opened', containerRef: 'environment-container' });
    expect(execClient.requests[0]).toMatchObject({
      path: '/containers/environment-container/exec',
      body: { Cmd: ['sh'] },
    });
  });

  it('creates and starts a Docker exec session with bearer auth in headers, not URLs', async () => {
    const execClient = new RecordingDockerExecClient();
    const request = openRequest();
    const provider = createRemoteFleetTerminalDockerProvider({ execClient });

    const result = await provider.open(request);

    expect(result.resultType).toBe('opened');
    expect(request.secretResolver?.resolveSecret).toHaveBeenCalledWith({
      secretRef: dockerBearerTokenRef.ref,
      purpose: 'terminal-session',
      commandExecutionId: 'terminal-session-1',
    });
    expect(execClient.requests).toHaveLength(2);
    expect(execClient.starts).toHaveLength(1);
    expect(execClient.requests[0]).toMatchObject({
      endpointUrl: 'https://docker.example.test:2376/api',
      path: '/containers/debian-env-container/exec',
      method: 'POST',
      bearerToken: dockerBearerToken,
      body: {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: ['/bin/bash', '-l'],
      },
    });
    expect(execClient.starts[0]).toEqual({
      endpointUrl: 'https://docker.example.test:2376/api',
      execId: 'exec-123',
      bearerToken: dockerBearerToken,
      body: { Detach: false, Tty: true },
    });
    expect(execClient.requests[1]).toMatchObject({
      path: '/exec/exec-123/resize',
      method: 'POST',
      bearerToken: dockerBearerToken,
      query: { h: '24', w: '80' },
    });
    expect(requestUrl(execClient.requests[0])).not.toContain(dockerBearerToken);
    expect(requestUrl(execClient.requests[1])).not.toContain(dockerBearerToken);
    if (result.resultType !== 'opened') throw new Error('expected opened terminal');
    expectJsonDoesNotLeakSecrets({ resultType: result.resultType, execId: result.execId, containerRef: result.containerRef }, [dockerBearerToken]);
  });

  it('uses containerId and default shell when terminal command is omitted', async () => {
    const execClient = new RecordingDockerExecClient();
    const provider = createRemoteFleetTerminalDockerProvider({ execClient });

    const result = await provider.open(openRequest({
      node: nodeRecord({
        publicConfig: {
          docker: {
            endpointUrl: 'http://127.0.0.1:2375',
            containerId: 'container-abcdef',
          },
        },
        secretRefs: {},
      }),
      secretResolver: undefined,
      rows: 40,
      cols: 120,
    }));

    expect(result.resultType).toBe('opened');
    expect(execClient.requests[0]).toMatchObject({
      path: '/containers/container-abcdef/exec',
      body: {
        Cmd: ['/bin/sh', '-l'],
      },
    });
    expect(execClient.starts[0].bearerToken).toBeUndefined();
    expect(execClient.requests[1]).toMatchObject({ query: { h: '40', w: '120' } });
  });

  it('defaults to the Matcha-managed container name for registered nodes', async () => {
    const execClient = new RecordingDockerExecClient();
    const provider = createRemoteFleetTerminalDockerProvider({ execClient });

    const result = await provider.open(openRequest({
      node: nodeRecord({
        id: 'node-1',
        publicConfig: {
          docker: {
            endpointUrl: 'http://127.0.0.1:2375',
          },
        },
        secretRefs: {},
      }),
      secretResolver: undefined,
    }));

    expect(result.resultType).toBe('opened');
    expect(execClient.requests[0]).toMatchObject({
      path: '/containers/matchaclaw-debian-node-1/exec',
      body: {
        Cmd: ['/bin/sh', '-l'],
      },
    });
  });

  it('forwards write, resize, data, error, exit and close through the stream handle', async () => {
    const execClient = new RecordingDockerExecClient([dockerResponse({ status: 201, body: { Id: 'exec-456' } }), dockerResponse({ status: 200 }), dockerResponse({ status: 200 })]);
    const provider = createRemoteFleetTerminalDockerProvider({ execClient });
    const result = await provider.open(openRequest());
    expect(result.resultType).toBe('opened');
    if (result.resultType !== 'opened') throw new Error('expected opened terminal');

    const data: string[] = [];
    const errors: string[] = [];
    const exits: unknown[] = [];
    result.handle.onData((chunk) => data.push(text(chunk)));
    result.handle.onError((error) => errors.push(error.message));
    result.handle.onExit((event) => exits.push(event));

    result.handle.write(new TextEncoder().encode('pwd\n'));
    result.handle.resize({ rows: 50, cols: 140 });
    execClient.stream.emitData('hello');
    execClient.stream.emitError(new Error('stream failed'));
    execClient.stream.emitExit({ exitCode: 137, signal: 'SIGKILL' });
    result.handle.close();

    expect(execClient.stream.writes.map(text)).toEqual(['pwd\n']);
    expect(execClient.requests[2]).toMatchObject({
      path: '/exec/exec-456/resize',
      query: { h: '50', w: '140' },
    });
    expect(data).toEqual(['hello']);
    expect(errors).toEqual(['stream failed']);
    expect(exits).toEqual([{ exitCode: 137, signal: 'SIGKILL' }]);
    expect(execClient.stream.closed).toBe(false);
  });

  it('accepts Docker Engine HTTP 101 upgrade streams as opened terminal exec sessions', async () => {
    let upgradedSocket: Socket | null = null;
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/containers/debian-env-container/exec') {
        req.resume();
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Id: 'exec-101' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/exec/exec-101/resize?h=24&w=80') {
        req.resume();
        res.writeHead(200);
        res.end('');
        return;
      }
      res.writeHead(404);
      res.end('');
    });
    server.on('upgrade', (req, socket) => {
      expect(req.url).toBe('/exec/exec-101/start');
      upgradedSocket = socket;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
      const provider = createRemoteFleetTerminalDockerProvider();
      const result = await provider.open(openRequest({
        node: nodeRecord({
          publicConfig: {
            docker: {
              endpointUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
              containerName: 'debian-env-container',
            },
          },
          secretRefs: {},
        }),
        secretResolver: undefined,
      }));

      expect(result.resultType).toBe('opened');
      if (result.resultType !== 'opened') throw new Error('expected opened terminal');
      const data = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for upgraded terminal stream data')), 5_000);
        result.handle.onData((chunk) => {
          clearTimeout(timer);
          resolve(text(chunk));
        });
        result.handle.onError((error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      expect(upgradedSocket).not.toBeNull();
      upgradedSocket!.write('terminal-ready');
      await expect(data).resolves.toBe('terminal-ready');
      result.handle.close();
    } finally {
      upgradedSocket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('blocks an HTTPS loopback port 2375 endpoint before resolving secrets or calling Docker exec', async () => {
    const endpointUrl = 'https://127.0.0.1:2375';
    const execClient = new RecordingDockerExecClient();
    const request = openRequest({
      node: nodeRecord({
        publicConfig: {
          docker: {
            endpointUrl,
            containerName: 'runtime-container',
          },
        },
      }),
    });
    const provider = createRemoteFleetTerminalDockerProvider({ execClient });

    const result = await provider.open(request);

    expect(result).toEqual({
      resultType: 'failed',
      providerKind: 'docker',
      reason: 'endpoint-protocol-mismatch',
      message: 'Remote Fleet Docker local port 2375 must use HTTP instead of HTTPS.',
    });
    expect(execClient.request).not.toHaveBeenCalled();
    expect(execClient.start).not.toHaveBeenCalled();
    expect(request.secretResolver?.resolveSecret).not.toHaveBeenCalled();
    expectJsonDoesNotLeakSecrets(result, [endpointUrl, dockerBearerToken, 'TLS']);
  });

  it('rejects unsafe endpoint, unsafe container refs, and disallowed token refs before Docker API calls', async () => {
    const execClient = new RecordingDockerExecClient();
    const provider = createRemoteFleetTerminalDockerProvider({ execClient });

    const unsafeEndpoint = await provider.open(openRequest({
      node: nodeRecord({
        publicConfig: { docker: { endpointUrl: 'https://user:password@docker.example.test:2376', containerName: 'runtime-agent' } },
      }),
    }));
    const unsafeContainer = await provider.open(openRequest({
      node: nodeRecord({
        publicConfig: { docker: { endpointUrl: 'https://docker.example.test:2376', containerId: '../container' } },
      }),
    }));
    const disallowedSecret = await provider.open(openRequest({
      node: nodeRecord({
        secretRefs: { dockerBearerToken: { kind: 'secret-ref', ref: 'vault://docker-token' } },
      }),
    }));

    expect(unsafeEndpoint).toMatchObject({ resultType: 'failed', reason: 'invalid-config' });
    expect(unsafeContainer).toMatchObject({ resultType: 'failed', reason: 'invalid-config' });
    expect(disallowedSecret).toMatchObject({ resultType: 'failed', reason: 'auth' });
    expect(execClient.requests).toHaveLength(0);
    expect(execClient.starts).toHaveLength(0);
    expectJsonDoesNotLeakSecrets(unsafeEndpoint, ['user:password']);
    expectJsonDoesNotLeakSecrets(disallowedSecret, [dockerBearerToken]);
  });
});
