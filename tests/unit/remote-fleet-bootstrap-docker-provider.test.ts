import { describe, expect, it, vi } from 'vitest';
import { createRemoteFleetDockerBootstrapProvider } from '../../runtime-host/application/remote-fleet/remote-fleet-bootstrap-docker-provider';
import {
  readRemoteFleetDockerBootstrapProviderConfig,
  readRemoteFleetDockerConnectionProbeConfig,
} from '../../runtime-host/application/remote-fleet/remote-fleet-docker-target-config';
import type {
  RemoteFleetBootstrapCommandEnvelope,
  RemoteFleetBootstrapProviderContext,
  RemoteFleetConnectionProbeEnvelope,
  RemoteFleetConnectionProbeProvider,
} from '../../runtime-host/application/remote-fleet/remote-fleet-bootstrap';
import type {
  RemoteFleetConnectionRecord,
  RemoteFleetEnvironmentRecord,
  RemoteFleetManagedResourceRecord,
  RemoteFleetNodeRecord,
  RuntimeAgentRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';
import type { RuntimeHttpResponse } from '../../runtime-host/application/common/runtime-ports';

const now = '2026-07-07T00:00:00.000Z';
const enrollmentToken = 'mrf_ephemeral_enrollment_token';
const dockerBearerToken = 'docker-bearer-secret';
const canonicalDebianImage = 'debian:bookworm-slim';
const defaultContainerName = 'matchaclaw-debian-node-docker-1';

type RecordedDockerRequest = {
  readonly url: string;
  readonly init: RequestInit | undefined;
};

type DockerRequestKind =
  | 'imageInspect'
  | 'imagePull'
  | 'containerCreate'
  | 'containerInspect'
  | 'containerStart'
  | 'containerStop'
  | 'containerRemove'
  | 'containerExecCreate'
  | 'execStart'
  | 'execInspect'
  | 'ping';

type DockerResponseHandler = (
  request: RecordedDockerRequest,
  index: number,
) => RuntimeHttpResponse | Promise<RuntimeHttpResponse>;

function connectionRecord(overrides: Partial<RemoteFleetConnectionRecord> = {}): RemoteFleetConnectionRecord {
  return {
    id: 'connection-docker-1',
    displayName: 'Docker Connection',
    connectionKind: 'container',
    labels: [],
    enabled: true,
    publicConfig: {
      docker: {
        endpointUrl: 'http://127.0.0.1:2375',
      },
    },
    secretRefs: {},
    health: { reason: 'unknown' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function environmentRecord(overrides: Partial<RemoteFleetEnvironmentRecord> = {}): RemoteFleetEnvironmentRecord {
  return {
    id: 'environment-docker-1',
    connectionId: 'connection-docker-1',
    nodeId: 'node:docker/1',
    displayName: 'Docker Environment',
    environmentKind: 'docker-container',
    labels: [],
    enabled: true,
    publicConfig: {
      docker: {
        containerName: 'environment-runtime-container',
      },
    },
    secretRefs: {},
    lifecycle: { reason: 'registered' },
    managedResourceIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function managedResourceRecord(overrides: Partial<RemoteFleetManagedResourceRecord> = {}): RemoteFleetManagedResourceRecord {
  return {
    id: 'managed-resource-docker-1',
    connectionId: 'connection-docker-1',
    environmentId: 'environment-docker-1',
    nodeId: 'node:docker/1',
    providerKind: 'docker',
    resourceKind: 'docker-container',
    remoteResourceId: 'environment-runtime-container',
    remoteRefs: [],
    displayName: 'Docker Container',
    labels: [],
    ownership: { reason: 'matcha-managed', evidence: {} },
    cleanupPolicy: { mode: 'delete-on-environment-delete' },
    lifecycle: { reason: 'ready', observedAt: now },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function nodeRecord(overrides: Partial<RemoteFleetNodeRecord> = {}): RemoteFleetNodeRecord {
  return {
    id: 'node:docker/1',
    displayName: 'Docker Node',
    targetKind: 'container',
    labels: [],
    enabled: true,
    publicConfig: {
      docker: {
        endpointUrl: 'http://127.0.0.1:2375',
      },
    },
    secretRefs: {},
    health: { reason: 'unknown' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function agentRecord(overrides: Partial<RuntimeAgentRecord> = {}): RuntimeAgentRecord {
  return {
    id: 'agent-1',
    nodeId: 'node:docker/1',
    displayName: 'RuntimeAgent 1',
    enrollment: { reason: 'not-installed' },
    capabilities: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function connectionProbeEnvelope(overrides: Partial<RemoteFleetConnectionProbeEnvelope> = {}): RemoteFleetConnectionProbeEnvelope {
  return {
    envelopeVersion: 'remote-fleet-connection-probe/v1',
    commandId: 'connection-probe-cmd-1',
    idempotencyKey: 'connection-probe-idem-1',
    providerKind: 'docker',
    connection: connectionRecord({
      secretRefs: {
        dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connections/docker-probe/bearer' },
      },
    }),
    ...overrides,
  };
}

function bootstrapEnvelope(overrides: Partial<RemoteFleetBootstrapCommandEnvelope> = {}): RemoteFleetBootstrapCommandEnvelope {
  const node = overrides.node ?? nodeRecord();
  const agent = overrides.agent ?? agentRecord({ nodeId: node.id });
  return {
    envelopeVersion: 'remote-fleet-bootstrap-command/v1',
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    commandName: 'install-agent',
    providerKind: 'docker',
    nodeId: node.id,
    agentId: agent.id,
    node,
    agent,
    enrollment: {
      agentId: agent.id,
      nodeId: node.id,
      token: enrollmentToken,
      expiresAt: '2026-07-07T01:00:00.000Z',
      callbackUrl: 'https://matchaclaw.example.test/runtime-agent/enroll',
    },
    ...overrides,
  };
}

function response(input: {
  readonly status: number;
  readonly body?: unknown;
  readonly text?: string;
}): RuntimeHttpResponse {
  return {
    ok: input.status >= 200 && input.status < 300,
    status: input.status,
    json: async () => input.body ?? {},
    text: async () => input.text ?? '',
  };
}

function dockerPullStreamErrorResponse(message: string): RuntimeHttpResponse {
  return response({
    status: 200,
    text: `${JSON.stringify({ status: 'Pulling fs layer', id: 'layer-1' })}\n${JSON.stringify({ errorDetail: { message }, error: message })}\n`,
  });
}

function dockerMultiplexedExecOutput(payload: string, streamType = 2): string {
  return String.fromCharCode(
    streamType,
    0,
    0,
    0,
    (payload.length >>> 24) & 0xff,
    (payload.length >>> 16) & 0xff,
    (payload.length >>> 8) & 0xff,
    payload.length & 0xff,
  ) + payload;
}

function dockerPullStreamReadFailureResponse(errorName = 'AbortError'): RuntimeHttpResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => {
      const error = new Error('This operation was aborted');
      error.name = errorName;
      throw error;
    },
  };
}

function contextWithResponses(responses: RuntimeHttpResponse[]): {
  readonly context: RemoteFleetBootstrapProviderContext;
  readonly requests: RecordedDockerRequest[];
} {
  return contextWithDockerResponder(() => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected Docker API request');
    return next;
  });
}

function contextWithDockerResponder(handler: DockerResponseHandler): {
  readonly context: RemoteFleetBootstrapProviderContext;
  readonly requests: RecordedDockerRequest[];
} {
  const requests: RecordedDockerRequest[] = [];
  const httpClient = {
    request: vi.fn(async (url: string, init?: RequestInit) => {
      const request = { url, init };
      requests.push(request);
      return await handler(request, requests.length - 1);
    }),
  };

  return {
    requests,
    context: {
      httpClient,
      secrets: {
        readSecret: async (secretRefName) => ({
          resultType: 'resolved' as const,
          secretRefName,
          secretRef: { kind: 'secret-ref', ref: `remote-fleet://node/docker/${secretRefName}` },
          plaintextSecretValue: dockerBearerToken,
        }),
        readSecretRef: async (secretRef) => ({
          resultType: 'resolved' as const,
          secretRefName: secretRef.ref,
          secretRef,
          plaintextSecretValue: dockerBearerToken,
        }),
      },
    },
  };
}

function requestBody(request: RecordedDockerRequest): Record<string, unknown> {
  expect(typeof request.init?.body).toBe('string');
  return JSON.parse(request.init!.body as string) as Record<string, unknown>;
}

function dockerRequestKind(request: RecordedDockerRequest): DockerRequestKind {
  const method = request.init?.method;
  const pathname = new URL(request.url).pathname;

  if (method === 'GET' && pathname.endsWith('/_ping')) return 'ping';
  if (method === 'GET' && /\/images\/.+\/json$/.test(pathname)) return 'imageInspect';
  if (method === 'POST' && pathname.endsWith('/images/create')) return 'imagePull';
  if (method === 'POST' && pathname.endsWith('/containers/create')) return 'containerCreate';
  if (method === 'GET' && /\/containers\/.+\/json$/.test(pathname)) return 'containerInspect';
  if (method === 'POST' && /\/containers\/.+\/start$/.test(pathname)) return 'containerStart';
  if (method === 'POST' && /\/containers\/.+\/stop$/.test(pathname)) return 'containerStop';
  if (method === 'DELETE' && /\/containers\/.+$/.test(pathname)) return 'containerRemove';
  if (method === 'POST' && /\/containers\/.+\/exec$/.test(pathname)) return 'containerExecCreate';
  if (method === 'POST' && /\/exec\/.+\/start$/.test(pathname)) return 'execStart';
  if (method === 'GET' && /\/exec\/.+\/json$/.test(pathname)) return 'execInspect';

  throw new Error(`Unexpected Docker API request ${method ?? 'UNKNOWN'} ${pathname}`);
}

function imageRefFromInspectUrl(url: string): string {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/\/images\/(.+)\/json$/);
  expect(match).not.toBeNull();
  return decodeURIComponent(match![1]);
}

function imageRefFromPullUrl(url: string): string {
  const searchParams = new URL(url).searchParams;
  const fromImage = searchParams.get('fromImage');
  expect(fromImage).toBeTruthy();
  const tag = searchParams.get('tag');
  return tag ? `${fromImage}:${tag}` : fromImage!;
}

function requestHeaders(request: RecordedDockerRequest): Record<string, string> {
  return (request.init?.headers ?? {}) as Record<string, string>;
}

function expectDockerBearerTokenHeaderOnEveryRequest(requests: readonly RecordedDockerRequest[]): void {
  for (const request of requests) {
    expect(requestHeaders(request).authorization).toBe(`Bearer ${dockerBearerToken}`);
  }
}

function expectNoSecretsInRequestOrResult(
  requests: readonly RecordedDockerRequest[],
  result: unknown,
): void {
  for (const request of requests) {
    expect(request.url).not.toContain(dockerBearerToken);
    expect(request.url).not.toContain(enrollmentToken);
    if (request.init?.body !== undefined) {
      expect(String(request.init.body)).not.toContain(dockerBearerToken);
      expect(String(request.init.body)).not.toContain(enrollmentToken);
    }
  }
  expect(JSON.stringify(result)).not.toContain(enrollmentToken);
  expect(JSON.stringify(result)).not.toContain(dockerBearerToken);
}

function findOnlyRequest(requests: readonly RecordedDockerRequest[], kind: DockerRequestKind): RecordedDockerRequest {
  const matches = requests.filter((request) => dockerRequestKind(request) === kind);
  expect(matches).toHaveLength(1);
  return matches[0];
}

function dockerManagedLabels(input: {
  readonly connectionId?: string;
  readonly environmentId?: string;
  readonly nodeId?: string;
  readonly agentId?: string;
} = {}): Record<string, string> {
  return {
    'com.matchaclaw.remote-fleet.managed': 'true',
    ...(input.connectionId ? { 'com.matchaclaw.remote-fleet.connection-id': input.connectionId } : {}),
    ...(input.environmentId ? { 'com.matchaclaw.remote-fleet.environment-id': input.environmentId } : {}),
    'com.matchaclaw.remote-fleet.node-id': input.nodeId ?? 'node:docker/1',
    'com.matchaclaw.remote-fleet.agent-id': input.agentId ?? 'agent-1',
  };
}

function containerInspectBody(labels: Record<string, string>): Record<string, unknown> {
  return { Config: { Labels: labels } };
}

function expectDockerEnvironmentCreateLabels(
  request: RecordedDockerRequest,
  expectedLabels: Record<string, string>,
): void {
  expect(requestBody(request).Labels).toEqual(expectedLabels);
}

function expectDockerEnvironmentCreateBody(
  request: RecordedDockerRequest,
  expectedImage: string,
): void {
  const body = requestBody(request);
  expect(body).toMatchObject({
    Image: expectedImage,
    Entrypoint: ['/bin/sh', '-lc'],
    WorkingDir: '/workspace',
    Labels: {
      'com.matchaclaw.remote-fleet.managed': 'true',
      'com.matchaclaw.remote-fleet.node-id': 'node:docker/1',
      'com.matchaclaw.remote-fleet.agent-id': 'agent-1',
    },
  });
  expect(body.Cmd).toEqual([expect.stringContaining('sleep 2147483647')]);
  expect(body.Cmd).toEqual([expect.stringContaining('trap "exit 0" TERM INT')]);
  expect(JSON.stringify(body)).not.toContain('MATCHACLAW_REMOTE_FLEET_ENROLLMENT_TOKEN');
  expect(JSON.stringify(body)).not.toContain(enrollmentToken);
  expect(JSON.stringify(body)).not.toContain(dockerBearerToken);
}

function isDomesticDockerMirrorRef(imageRef: string): boolean {
  const normalized = imageRef.toLowerCase();
  return normalized.includes('aliyun')
    || normalized.includes('tencent')
    || normalized.includes('daocloud')
    || normalized.includes('huaweicloud')
    || normalized.includes('netease')
    || normalized.includes('ustc')
    || normalized.includes('sjtu')
    || normalized.includes('nanjing')
    || normalized.includes('bfsu')
    || normalized.includes('dockerproxy')
    || normalized.includes('mirror')
    || normalized.includes('.cn/')
    || normalized.includes('cn-');
}

describe('Remote Fleet Docker bootstrap provider', () => {
  it('merges shared connection endpoint/auth with separate Docker container environments', () => {
    const connectionPublicConfig = {
      docker: {
        endpointUrl: 'https://shared-docker.example.test:2376/api',
      },
    };
    const connectionSecretRefs = {
      dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connection-1/docker-bearer-token' },
    };

    const blueConfig = readRemoteFleetDockerBootstrapProviderConfig({
      connectionPublicConfig,
      connectionSecretRefs,
      nodePublicConfig: {
        docker: {
          endpointUrl: 'https://node-blue-docker.example.test:2376/api',
          image: 'debian:bookworm-slim',
          containerName: 'blue-runtime-container',
        },
      },
      nodeSecretRefs: {
        dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://node-blue/docker-bearer-token' },
      },
      nodeId: 'node-blue',
    });
    const greenConfig = readRemoteFleetDockerBootstrapProviderConfig({
      connectionPublicConfig,
      connectionSecretRefs,
      nodePublicConfig: {
        docker: {
          containerName: 'green-runtime-container',
        },
      },
      nodeId: 'node-green',
    });

    expect(blueConfig).toMatchObject({
      resultType: 'valid',
      config: {
        endpointUrl: 'https://shared-docker.example.test:2376/api',
        containerName: 'blue-runtime-container',
        dockerBearerTokenSecretRef: 'remote-fleet://connection-1/docker-bearer-token',
      },
    });
    expect(greenConfig).toMatchObject({
      resultType: 'valid',
      config: {
        endpointUrl: 'https://shared-docker.example.test:2376/api',
        containerName: 'green-runtime-container',
        dockerBearerTokenSecretRef: 'remote-fleet://connection-1/docker-bearer-token',
      },
    });
    if (blueConfig.resultType !== 'valid' || greenConfig.resultType !== 'valid') throw new Error('expected valid configs');
    expect(blueConfig.config.containerName).not.toBe(greenConfig.config.containerName);
  });

  it('prefers environment Docker deploy config with shared connection endpoint/auth before node fallback', () => {
    const config = readRemoteFleetDockerBootstrapProviderConfig({
      connectionPublicConfig: {
        docker: {
          endpointUrl: 'https://shared-docker.example.test:2376/api',
        },
      },
      connectionSecretRefs: {
        dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connection-1/docker-bearer-token' },
      },
      environmentPublicConfig: {
        docker: {
          image: 'registry.example.test/env-runtime:2',
          imageCandidates: ['registry.example.test/env-runtime:2', 'registry.example.test/env-runtime:1'],
          containerName: 'environment-owned-container',
        },
      },
      nodePublicConfig: {
        docker: {
          endpointUrl: 'https://node-docker.example.test:2376/api',
          image: 'registry.example.test/node-runtime:1',
          containerName: 'node-runtime-container',
        },
      },
      nodeId: 'node-with-env-config',
    });

    expect(config).toMatchObject({
      resultType: 'valid',
      config: {
        endpointUrl: 'https://shared-docker.example.test:2376/api',
        image: 'registry.example.test/env-runtime:2',
        imageCandidates: ['registry.example.test/env-runtime:2', 'registry.example.test/env-runtime:1'],
        containerName: 'environment-owned-container',
        dockerBearerTokenSecretRef: 'remote-fleet://connection-1/docker-bearer-token',
      },
    });
  });

  it('prepends the configured image to explicit pull candidates', () => {
    const config = readRemoteFleetDockerBootstrapProviderConfig({
      nodePublicConfig: {
        docker: {
          endpointUrl: 'https://docker.example.test:2376',
          image: 'registry.example.test/custom-debian:bookworm',
          imageCandidates: [
            'docker.m.daocloud.io/library/debian:bookworm-slim',
            'registry.example.test/custom-debian:bookworm',
          ],
          containerName: 'named-runtime-container',
        },
      },
      nodeId: 'node-custom-image',
    });

    expect(config).toMatchObject({
      resultType: 'valid',
      config: {
        image: 'registry.example.test/custom-debian:bookworm',
        imageCandidates: [
          'registry.example.test/custom-debian:bookworm',
          'docker.m.daocloud.io/library/debian:bookworm-slim',
        ],
        containerName: 'named-runtime-container',
      },
    });
  });

  it('rejects unsafe Docker connection publicConfig before provider execution', () => {
    const result = readRemoteFleetDockerBootstrapProviderConfig({
      connectionPublicConfig: {
        docker: {
          endpointUrl: 'https://docker.example.test:2376',
          dockerBearerToken: 'super-secret',
        },
      },
      connectionSecretRefs: {
        dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connection-1/docker-bearer-token' },
      },
      nodePublicConfig: { docker: { containerName: 'runtime-container' } },
      nodeId: 'node-1',
    });

    expect(result).toMatchObject({
      resultType: 'invalid',
      message: 'Remote Fleet Docker connection publicConfig contains unsafe credential material at publicConfig.docker.dockerBearerToken.',
    });
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it.each([
    'https://localhost:2375',
    'https://127.0.0.1:2375',
    'https://[::1]:2375',
  ])('rejects HTTPS loopback port 2375 during Docker config resolution without exposing the endpoint', (endpointUrl) => {
    const expected = {
      resultType: 'invalid',
      reason: 'endpoint-protocol-mismatch',
      message: 'Remote Fleet Docker local port 2375 must use HTTP instead of HTTPS.',
    };
    const results = [
      readRemoteFleetDockerBootstrapProviderConfig({
        nodePublicConfig: { docker: { endpointUrl } },
        nodeId: 'node-protocol-mismatch',
      }),
      readRemoteFleetDockerConnectionProbeConfig({
        connectionPublicConfig: { docker: { endpointUrl } },
        connectionSecretRefs: {},
      }),
    ];

    for (const result of results) {
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain(endpointUrl);
    }
  });

  it('allows HTTP loopback port 2375 and remote HTTPS Docker endpoints', () => {
    for (const endpointUrl of [
      'http://localhost:2375',
      'http://127.0.0.1:2375',
      'http://[::1]:2375',
      'https://docker.example.test:2376',
    ]) {
      expect(readRemoteFleetDockerBootstrapProviderConfig({
        nodePublicConfig: { docker: { endpointUrl } },
        nodeId: 'node-valid-endpoint',
      })).toMatchObject({
        resultType: 'valid',
        config: { endpointUrl },
      });
    }
  });

  it.each([
    {
      operation: 'probe-node' as const,
      endpointUrl: 'https://localhost:2375',
      invoke: async (provider: ReturnType<typeof createRemoteFleetDockerBootstrapProvider>, context: RemoteFleetBootstrapProviderContext) => (
        await provider.dispatchCommand(bootstrapEnvelope({
          commandName: 'probe-node',
          enrollment: undefined,
          node: nodeRecord({ publicConfig: { docker: { endpointUrl: 'https://localhost:2375' } } }),
        }), context)
      ),
    },
    {
      operation: 'deploy-environment' as const,
      endpointUrl: 'https://127.0.0.1:2375',
      invoke: async (provider: ReturnType<typeof createRemoteFleetDockerBootstrapProvider>, context: RemoteFleetBootstrapProviderContext) => {
        const connection = connectionRecord({ publicConfig: { docker: { endpointUrl: 'https://127.0.0.1:2375' } } });
        const environment = environmentRecord();
        const node = nodeRecord({ connectionId: connection.id, environmentId: environment.id });
        const agent = agentRecord({ connectionId: connection.id, environmentId: environment.id, nodeId: node.id });
        return await provider.dispatchCommand(bootstrapEnvelope({
          commandName: 'deploy-environment',
          connection,
          environment,
          node,
          agent,
          nodeId: node.id,
          agentId: agent.id,
          enrollment: undefined,
        }), context);
      },
    },
  ])('$operation rejects a mismatched Docker endpoint before HTTP, with a fixed safe error projection', async ({ endpointUrl, invoke }) => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const { context, requests } = contextWithResponses([]);

    const result = await invoke(provider, context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      reason: 'endpoint-protocol-mismatch',
      message: 'Remote Fleet Docker local port 2375 must use HTTP instead of HTTPS.',
    });
    expect(requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(endpointUrl);
    expect(JSON.stringify(result)).not.toContain(dockerBearerToken);
    expect(JSON.stringify(result)).not.toContain(enrollmentToken);
    expect(JSON.stringify(result)).not.toContain('TLS');
  });

  it.each([
    'https://localhost:2375',
    'https://127.0.0.1:2375',
    'https://[::1]:2375',
  ])('rejects connection probes with a mismatched Docker endpoint before HTTP, with no endpoint or token projection', async (endpointUrl) => {
    const provider = createRemoteFleetDockerBootstrapProvider() as RemoteFleetConnectionProbeProvider;
    const { context, requests } = contextWithResponses([]);

    const result = await provider.probeConnection(connectionProbeEnvelope({
      connection: connectionRecord({ publicConfig: { docker: { endpointUrl } } }),
    }), context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'connection-probe-cmd-1',
      providerKind: 'docker',
      reason: 'endpoint-protocol-mismatch',
    });
    expect(requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(endpointUrl);
    expect(JSON.stringify(result)).not.toContain(dockerBearerToken);
    expect(JSON.stringify(result)).not.toContain(enrollmentToken);
    expect(JSON.stringify(result)).not.toContain('TLS');
  });

  it('accepts a legacy connection.endpointUrl for Docker probe config resolution', () => {
    const endpointUrl = 'https://legacy-docker.example.test:2376/api';

    expect(readRemoteFleetDockerConnectionProbeConfig({
      connectionPublicConfig: {},
      connectionEndpointUrl: endpointUrl,
      connectionSecretRefs: {},
    })).toEqual({
      resultType: 'valid',
      config: { endpointUrl },
    });
  });

  it('deploy-environment resolves a legacy top-level connection endpoint with environment Docker deployment config', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const endpointUrl = 'https://legacy-docker.example.test:2376/api';
    const connection = connectionRecord({ publicConfig: {}, endpointUrl });
    const environment = environmentRecord({
      publicConfig: {
        docker: {
          image: 'registry.example.test/legacy-runtime:2',
          containerName: 'legacy-top-level-endpoint-container',
        },
      },
    });
    const node = nodeRecord({
      connectionId: connection.id,
      environmentId: environment.id,
      publicConfig: { docker: {} },
    });
    const agent = agentRecord({ connectionId: connection.id, environmentId: environment.id, nodeId: node.id });
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'imageInspect') return response({ status: 200, body: { Id: 'legacy-runtime-image' } });
      if (kind === 'containerCreate') return response({ status: 201, body: { Id: 'legacy-top-level-container' } });
      if (kind === 'containerStart') return response({ status: 204 });
      throw new Error(`unexpected Docker request: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope({
      commandName: 'deploy-environment',
      connection,
      environment,
      node,
      agent,
      nodeId: node.id,
      agentId: agent.id,
      enrollment: undefined,
    }), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      remoteResourceId: 'legacy-top-level-container',
    });
    expect(requests.map(dockerRequestKind)).toEqual(['imageInspect', 'containerCreate', 'containerStart']);
    expect(requests.every((request) => request.url.startsWith(endpointUrl))).toBe(true);
    expect(new URL(findOnlyRequest(requests, 'containerCreate').url).searchParams.get('name')).toBe('legacy-top-level-endpoint-container');
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('deploy-environment uses environment Docker containerName and returns a managed resource', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const connection = connectionRecord();
    const environment = environmentRecord({
      publicConfig: {
        docker: {
          image: 'registry.example.test/runtime:1',
          containerName: 'env-runtime-one',
        },
      },
    });
    const node = nodeRecord({ connectionId: connection.id, environmentId: environment.id });
    const agent = agentRecord({ connectionId: connection.id, environmentId: environment.id, nodeId: node.id });
    const expectedLabels = dockerManagedLabels({
      connectionId: connection.id,
      environmentId: environment.id,
      nodeId: node.id,
      agentId: agent.id,
    });
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'imageInspect') return response({ status: 200, body: { Id: 'runtime-image-id' } });
      if (kind === 'containerCreate') return response({ status: 201, body: { Id: 'container-env-1' } });
      if (kind === 'containerStart') return response({ status: 204 });
      throw new Error(`unexpected Docker request: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope({
      commandName: 'deploy-environment',
      connection,
      environment,
      node,
      agent,
      nodeId: node.id,
      agentId: agent.id,
      enrollment: undefined,
    }), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      remoteResourceId: 'container-env-1',
      managedResources: [
        {
          providerKind: 'docker',
          resourceKind: 'docker-container',
          remoteResourceId: 'container-env-1',
          remoteRefs: [
            {
              providerKind: 'docker',
              resourceKind: 'docker-container',
              remoteResourceId: 'container-env-1',
              name: 'container-env-1',
            },
          ],
          ownership: { reason: 'matcha-managed', evidence: expectedLabels },
          cleanupPolicy: { mode: 'delete-on-environment-delete' },
          displayName: 'Docker container container-env-1',
        },
      ],
    });
    const createRequest = findOnlyRequest(requests, 'containerCreate');
    expect(new URL(createRequest.url).searchParams.get('name')).toBe('env-runtime-one');
    expectDockerEnvironmentCreateLabels(createRequest, expectedLabels);
    expect(requests.map(dockerRequestKind)).toEqual(['imageInspect', 'containerCreate', 'containerStart']);
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('deploy-environment lets one Docker connection host multiple environment container names', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const connection = connectionRecord();
    const createNames: string[] = [];

    for (const environmentId of ['environment-blue', 'environment-green']) {
      const environment = environmentRecord({
        id: environmentId,
        connectionId: connection.id,
        publicConfig: {
          docker: {
            image: 'registry.example.test/runtime:1',
            containerName: `${environmentId}-container`,
          },
        },
      });
      const node = nodeRecord({ id: `${environmentId}-node`, connectionId: connection.id, environmentId });
      const agent = agentRecord({ id: `${environmentId}-agent`, nodeId: node.id, connectionId: connection.id, environmentId });
      const { context, requests } = contextWithDockerResponder((request) => {
        const kind = dockerRequestKind(request);
        if (kind === 'imageInspect') return response({ status: 200, body: { Id: 'runtime-image-id' } });
        if (kind === 'containerCreate') return response({ status: 201, body: { Id: `${environmentId}-created` } });
        if (kind === 'containerStart') return response({ status: 204 });
        throw new Error(`unexpected Docker request: ${kind}`);
      });

      const result = await provider.dispatchCommand(bootstrapEnvelope({
        commandName: 'deploy-environment',
        connection,
        environment,
        node,
        agent,
        nodeId: node.id,
        agentId: agent.id,
        enrollment: undefined,
      }), context);

      expect(result).toMatchObject({ resultType: 'completed', remoteResourceId: `${environmentId}-created` });
      createNames.push(new URL(findOnlyRequest(requests, 'containerCreate').url).searchParams.get('name') ?? '');
    }

    expect(createNames).toEqual(['environment-blue-container', 'environment-green-container']);
    expect(new Set(createNames).size).toBe(2);
  });

  it('probes Docker Engine with /_ping and returns a safe completed summary', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const { context, requests } = contextWithResponses([response({ status: 200, text: 'OK' })]);

    const result = await provider.dispatchCommand(bootstrapEnvelope({ commandName: 'probe-node', enrollment: undefined }), context);

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      message: 'Docker Engine is reachable.',
      outputSummary: 'Docker Engine /_ping returned 200 OK.',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://127.0.0.1:2375/_ping');
    expect(requests[0].init).toMatchObject({ method: 'GET' });
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('probes a Docker connection with its connection-only config secret ref and returns no token', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider() as RemoteFleetConnectionProbeProvider;
    const { context, requests } = contextWithResponses([response({ status: 200, text: 'OK' })]);
    const readSecret = vi.fn(context.secrets.readSecret);
    const readSecretRef = vi.fn(context.secrets.readSecretRef);
    const connectionSecretRef = { kind: 'secret-ref', ref: 'remote-fleet://connection/docker-probe/bearer' } as const;
    const token = 'connection-probe-bearer-secret';
    const probeContext: RemoteFleetBootstrapProviderContext = {
      ...context,
      secrets: {
        readSecret,
        readSecretRef: async (secretRef) => {
          readSecretRef(secretRef);
          return {
            resultType: 'resolved',
            secretRefName: secretRef.ref,
            secretRef,
            plaintextSecretValue: token,
          };
        },
      },
    };

    const result = await provider.probeConnection(connectionProbeEnvelope({
      connection: connectionRecord({
        secretRefs: { dockerBearerToken: connectionSecretRef },
      }),
    }), probeContext);

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'connection-probe-cmd-1',
      providerKind: 'docker',
    });
    expect(readSecretRef).toHaveBeenCalledTimes(1);
    expect(readSecretRef).toHaveBeenCalledWith(connectionSecretRef);
    expect(readSecret).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://127.0.0.1:2375/_ping');
    expect(requests[0].init).toMatchObject({
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(enrollmentToken);
  });

  it('falls back to the top-level Docker connection endpoint for a completed /_ping probe', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider() as RemoteFleetConnectionProbeProvider;
    const endpointUrl = 'https://top-level-docker.example.test:2376/api';
    const { context, requests } = contextWithResponses([response({ status: 200, text: 'OK' })]);

    const result = await provider.probeConnection(connectionProbeEnvelope({
      connection: connectionRecord({ publicConfig: {}, endpointUrl }),
    }), context);

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'connection-probe-cmd-1',
      providerKind: 'docker',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${endpointUrl}/_ping`);
    expect(requests[0].init).toMatchObject({ method: 'GET' });
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('prefers the Docker connection publicConfig endpoint over a different top-level endpoint', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider() as RemoteFleetConnectionProbeProvider;
    const publicConfigEndpointUrl = 'https://public-config-docker.example.test:2376/api';
    const { context, requests } = contextWithResponses([response({ status: 200, text: 'OK' })]);

    const result = await provider.probeConnection(connectionProbeEnvelope({
      connection: connectionRecord({
        endpointUrl: 'https://top-level-docker.example.test:2376/other-api',
        publicConfig: { docker: { endpointUrl: publicConfigEndpointUrl } },
      }),
    }), context);

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'connection-probe-cmd-1',
      providerKind: 'docker',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${publicConfigEndpointUrl}/_ping`);
    expect(requests[0].init).toMatchObject({ method: 'GET' });
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('rejects a top-level Docker connection endpoint with userinfo before sending a request', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider() as RemoteFleetConnectionProbeProvider;
    const credential = 'top-level-docker-credential';
    const { context, requests } = contextWithResponses([]);

    const result = await provider.probeConnection(connectionProbeEnvelope({
      connection: connectionRecord({
        publicConfig: {},
        endpointUrl: `https://docker-user:${credential}@docker.example.test:2376`,
      }),
    }), context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'connection-probe-cmd-1',
      providerKind: 'docker',
      reason: 'invalid-config',
    });
    expect(requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain(dockerBearerToken);
    expect(JSON.stringify(result)).not.toContain(enrollmentToken);
  });

  it('keeps the Docker connection probe failure result token-free when /_ping rejects bearer auth', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider() as RemoteFleetConnectionProbeProvider;
    const providerFailureToken = 'docker-connection-probe-error-token-9081';
    const { context, requests } = contextWithDockerResponder((request) => {
      expect(request.url).toBe('http://127.0.0.1:2375/_ping');
      expect(request.init).toMatchObject({
        method: 'GET',
        headers: { authorization: `Bearer ${dockerBearerToken}` },
      });
      return response({ status: 401, text: `Unauthorized bearer=${providerFailureToken}; supplied=${dockerBearerToken}` });
    });

    const result = await provider.probeConnection(connectionProbeEnvelope(), context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'connection-probe-cmd-1',
      providerKind: 'docker',
      reason: 'auth',
    });
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(providerFailureToken);
    expect(JSON.stringify(result)).not.toContain(dockerBearerToken);
    expect(JSON.stringify(result)).not.toContain(enrollmentToken);
  });

  it('uses the locally available default candidate image without pulling it', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const node = nodeRecord({
      secretRefs: {
        dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://node/docker/bearer' },
      },
    });
    const inspectedImageRefs: string[] = [];
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      const requestIndex = requests.length - 1;
      if (requestIndex === 0 && kind === 'imageInspect') {
        inspectedImageRefs.push(imageRefFromInspectUrl(request.url));
        return response({ status: 200, body: { Id: 'local-image-id' } });
      }
      if (requestIndex === 1 && kind === 'containerCreate') return response({ status: 201, body: { Id: 'container-123' } });
      if (requestIndex === 2 && kind === 'containerStart') return response({ status: 204 });
      if (requestIndex === 3 && kind === 'containerExecCreate') return response({ status: 201, body: { Id: 'setup-exec-1' } });
      if (requestIndex === 4 && kind === 'execStart') return response({ status: 200 });
      if (requestIndex === 5 && kind === 'execInspect') return response({ status: 200, body: { ExitCode: 0 } });
      throw new Error(`unexpected Docker request order at ${requestIndex}: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope({ node, nodeId: node.id }), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      message: 'Docker environment container started.',
      remoteResourceId: 'container-123',
    });
    const setupCommand = requestBody(findOnlyRequest(requests, 'containerExecCreate')).Cmd;
    expect(setupCommand).toEqual([
      '/bin/sh',
      '-lc',
      expect.stringContaining('mirrors.tuna.tsinghua.edu.cn/debian'),
    ]);
    expect(setupCommand).toEqual([
      '/bin/sh',
      '-lc',
      expect.stringContaining('mirrors.ustc.edu.cn/debian'),
    ]);
    expect(setupCommand).toEqual([
      '/bin/sh',
      '-lc',
      expect.stringContaining('mirrors.aliyun.com/debian'),
    ]);
    expect(setupCommand).toEqual([
      '/bin/sh',
      '-lc',
      expect.stringContaining('deb.debian.org/debian'),
    ]);
    expect(setupCommand).toEqual([
      '/bin/sh',
      '-lc',
      expect.stringContaining('Acquire::Retries=5'),
    ]);
    expect(requestBody(findOnlyRequest(requests, 'execStart'))).toEqual({ Detach: false, Tty: false });
    expect(requests.map(dockerRequestKind)).toEqual([
      'imageInspect',
      'containerCreate',
      'containerStart',
      'containerExecCreate',
      'execStart',
      'execInspect',
    ]);
    expect(requests.some((request) => dockerRequestKind(request) === 'imagePull')).toBe(false);
    const createRequest = findOnlyRequest(requests, 'containerCreate');
    expect(new URL(createRequest.url).searchParams.get('name')).toBe(defaultContainerName);
    expectDockerEnvironmentCreateBody(createRequest, inspectedImageRefs[0]);
    if (result.resultType === 'completed') {
      expect(result.outputSummary).toContain(inspectedImageRefs[0]);
      expect(result.outputSummary).toContain('ready for terminal sessions');
    }
    expectDockerBearerTokenHeaderOnEveryRequest(requests);
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('derives managed container names from node id so one Docker endpoint can host multiple nodes', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const createNames: string[] = [];

    for (const nodeId of ['node-docker-a', 'node-docker-b']) {
      const node = nodeRecord({ id: nodeId });
      const agent = agentRecord({ id: `${nodeId}:agent`, nodeId });
      const { context, requests } = contextWithDockerResponder((request) => {
        const kind = dockerRequestKind(request);
        if (kind === 'imageInspect') return response({ status: 200, body: { Id: 'local-image-id' } });
        if (kind === 'containerCreate') return response({ status: 201, body: { Id: `${nodeId}-container` } });
        if (kind === 'containerStart') return response({ status: 204 });
        if (kind === 'containerExecCreate') return response({ status: 201, body: { Id: `${nodeId}-setup-exec` } });
        if (kind === 'execStart') return response({ status: 200 });
        if (kind === 'execInspect') return response({ status: 200, body: { ExitCode: 0 } });
        throw new Error(`unexpected Docker request: ${kind}`);
      });

      const result = await provider.dispatchCommand(bootstrapEnvelope({ node, agent, nodeId }), context);

      expect(result).toMatchObject({
        resultType: 'completed',
        commandId: 'cmd-1',
        providerKind: 'docker',
        message: 'Docker environment container started.',
        remoteResourceId: `${nodeId}-container`,
      });
      createNames.push(new URL(findOnlyRequest(requests, 'containerCreate').url).searchParams.get('name') ?? '');
    }

    expect(createNames).toEqual([
      'matchaclaw-debian-node-docker-a',
      'matchaclaw-debian-node-docker-b',
    ]);
    expect(new Set(createNames).size).toBe(2);
  });

  it('uses a locally available canonical Debian image after mirror candidates miss without pulling', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const inspectedImageRefs: string[] = [];
    let canonicalImageWasFound = false;
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'imageInspect') {
        const imageRef = imageRefFromInspectUrl(request.url);
        inspectedImageRefs.push(imageRef);
        if (imageRef === canonicalDebianImage) {
          canonicalImageWasFound = true;
          return response({ status: 200, body: { Id: 'debian-local-image' } });
        }
        return response({ status: 404 });
      }
      if (!canonicalImageWasFound) throw new Error(`Docker image ${canonicalDebianImage} was not inspected before ${kind}`);
      if (kind === 'containerCreate') return response({ status: 201, body: { Id: 'container-123' } });
      if (kind === 'containerStart') return response({ status: 204 });
      if (kind === 'containerExecCreate') return response({ status: 201, body: { Id: 'setup-exec-1' } });
      if (kind === 'execStart') return response({ status: 200 });
      if (kind === 'execInspect') return response({ status: 200, body: { ExitCode: 0 } });
      throw new Error(`unexpected Docker request after local canonical image: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope(), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      message: 'Docker environment container started.',
      remoteResourceId: 'container-123',
    });
    expect(inspectedImageRefs).toContain(canonicalDebianImage);
    expect(requests.some((request) => dockerRequestKind(request) === 'imagePull')).toBe(false);
    expectDockerEnvironmentCreateBody(findOnlyRequest(requests, 'containerCreate'), canonicalDebianImage);
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('pulls default candidates only after all local image candidates miss and creates with the resolved image', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const node = nodeRecord({
      secretRefs: {
        dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://node/docker/bearer' },
      },
    });
    const inspectedImageRefs: string[] = [];
    const pulledImageRefs: string[] = [];
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'imageInspect') {
        const imageRef = imageRefFromInspectUrl(request.url);
        inspectedImageRefs.push(imageRef);
        return response({ status: pulledImageRefs.includes(imageRef) ? 200 : 404, body: { Id: 'pulled-image-id' } });
      }
      if (kind === 'imagePull') {
        pulledImageRefs.push(imageRefFromPullUrl(request.url));
        return response({ status: 200, body: [{ status: 'Downloaded newer image' }] });
      }
      if (kind === 'containerCreate') return response({ status: 201, body: { Id: 'container-123' } });
      if (kind === 'containerStart') return response({ status: 204 });
      if (kind === 'containerExecCreate') return response({ status: 201, body: { Id: 'setup-exec-1' } });
      if (kind === 'execStart') return response({ status: 200 });
      if (kind === 'execInspect') return response({ status: 200, body: { ExitCode: 0 } });
      throw new Error(`unexpected Docker request: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope({ node, nodeId: node.id }), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      message: 'Docker environment container started.',
      remoteResourceId: 'container-123',
    });
    expect(inspectedImageRefs).toContain(canonicalDebianImage);
    expect(inspectedImageRefs.some((imageRef) => imageRef !== canonicalDebianImage && isDomesticDockerMirrorRef(imageRef))).toBe(true);
    expect(pulledImageRefs).toHaveLength(1);
    expect(pulledImageRefs[0]).toBe(inspectedImageRefs[0]);
    expect(pulledImageRefs[0]).not.toBe(canonicalDebianImage);
    expect(isDomesticDockerMirrorRef(pulledImageRefs[0])).toBe(true);

    const firstPullIndex = requests.findIndex((request) => dockerRequestKind(request) === 'imagePull');
    const firstCreateIndex = requests.findIndex((request) => dockerRequestKind(request) === 'containerCreate');
    expect(firstPullIndex).toBeGreaterThan(0);
    expect(firstCreateIndex).toBeGreaterThan(firstPullIndex);
    expect(requests.slice(0, firstPullIndex).map(dockerRequestKind).every((kind) => kind === 'imageInspect')).toBe(true);
    expectDockerEnvironmentCreateBody(findOnlyRequest(requests, 'containerCreate'), pulledImageRefs[0]);
    expectDockerBearerTokenHeaderOnEveryRequest(requests);
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('continues to the canonical Debian pull when the first default mirror returns HTTP 200 with a stream error', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const inspectedImageRefs: string[] = [];
    const pulledImageRefs: string[] = [];
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'imageInspect') {
        const imageRef = imageRefFromInspectUrl(request.url);
        inspectedImageRefs.push(imageRef);
        return response({ status: pulledImageRefs.includes(imageRef) ? 200 : 404, body: { Id: 'pulled-image-id' } });
      }
      if (kind === 'imagePull') {
        const imageRef = imageRefFromPullUrl(request.url);
        pulledImageRefs.push(imageRef);
        if (pulledImageRefs.length === 1) {
          expect(imageRef).not.toBe(canonicalDebianImage);
          expect(isDomesticDockerMirrorRef(imageRef)).toBe(true);
          return dockerPullStreamErrorResponse('manifest unknown');
        }
        expect(imageRef).toBe(canonicalDebianImage);
        return response({ status: 200, text: `${JSON.stringify({ status: 'Downloaded newer image', id: canonicalDebianImage })}\n` });
      }
      if (kind === 'containerCreate') return response({ status: 201, body: { Id: 'container-123' } });
      if (kind === 'containerStart') return response({ status: 204 });
      if (kind === 'containerExecCreate') return response({ status: 201, body: { Id: 'setup-exec-1' } });
      if (kind === 'execStart') return response({ status: 200 });
      if (kind === 'execInspect') return response({ status: 200, body: { ExitCode: 0 } });
      throw new Error(`unexpected Docker request: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope(), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      message: 'Docker environment container started.',
      remoteResourceId: 'container-123',
    });
    expect(inspectedImageRefs).toEqual([
      pulledImageRefs[0],
      pulledImageRefs[1],
      pulledImageRefs[1],
    ]);
    expect(pulledImageRefs).toHaveLength(2);
    expect(pulledImageRefs[1]).toBe(canonicalDebianImage);
    expectDockerEnvironmentCreateBody(findOnlyRequest(requests, 'containerCreate'), canonicalDebianImage);
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('treats aborted Docker pull stream reads as pull failures and continues to the next image candidate', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const inspectedImageRefs: string[] = [];
    const pulledImageRefs: string[] = [];
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'imageInspect') {
        const imageRef = imageRefFromInspectUrl(request.url);
        inspectedImageRefs.push(imageRef);
        return response({ status: pulledImageRefs.includes(imageRef) ? 200 : 404, body: { Id: 'pulled-image-id' } });
      }
      if (kind === 'imagePull') {
        const imageRef = imageRefFromPullUrl(request.url);
        pulledImageRefs.push(imageRef);
        return pulledImageRefs.length === 1
          ? dockerPullStreamReadFailureResponse('AbortError')
          : response({ status: 200, text: `${JSON.stringify({ status: 'Downloaded newer image', id: imageRef })}\n` });
      }
      if (kind === 'containerCreate') return response({ status: 201, body: { Id: 'container-123' } });
      if (kind === 'containerStart') return response({ status: 204 });
      if (kind === 'containerExecCreate') return response({ status: 201, body: { Id: 'setup-exec-1' } });
      if (kind === 'execStart') return response({ status: 200 });
      if (kind === 'execInspect') return response({ status: 200, body: { ExitCode: 0 } });
      throw new Error(`unexpected Docker request: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope(), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      message: 'Docker environment container started.',
      remoteResourceId: 'container-123',
    });
    expect(pulledImageRefs).toHaveLength(2);
    expect(pulledImageRefs[1]).toBe(canonicalDebianImage);
    expect(inspectedImageRefs).toContain(canonicalDebianImage);
    expectDockerEnvironmentCreateBody(findOnlyRequest(requests, 'containerCreate'), canonicalDebianImage);
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('fails before container create when every image candidate pull returns HTTP 200 with a stream error', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const node = nodeRecord({
      secretRefs: {
        dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://node/docker/bearer' },
      },
    });
    const pulledImageRefs: string[] = [];
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'imageInspect') return response({ status: 404 });
      if (kind === 'imagePull') {
        const imageRef = imageRefFromPullUrl(request.url);
        pulledImageRefs.push(imageRef);
        return dockerPullStreamErrorResponse(`pull access denied for ${imageRef}; bearer=${dockerBearerToken}; enrollment=${enrollmentToken}`);
      }
      if (kind === 'containerCreate') return response({ status: 500 });
      throw new Error(`unexpected Docker request before image resolution failure: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope({ node, nodeId: node.id }), context);

    expect(result).toMatchObject({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      reason: 'remote-error',
    });
    expect(result.message).toContain('Docker Engine could not find or pull any configured image candidate.');
    expect(pulledImageRefs).toHaveLength(2);
    expect(pulledImageRefs).toContain(canonicalDebianImage);
    expect(requests.some((request) => dockerRequestKind(request) === 'containerCreate')).toBe(false);
    expectDockerBearerTokenHeaderOnEveryRequest(requests);
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('captures Docker setup exec output when Debian environment setup fails', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const node = nodeRecord({
      secretRefs: {
        dockerBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://node/docker/bearer' },
      },
    });
    const setupOutput = `Temporary failure resolving deb.debian.org bearer=${dockerBearerToken} enrollment=${enrollmentToken}`;
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'imageInspect') return response({ status: 200, body: { Id: 'local-image-id' } });
      if (kind === 'containerCreate') return response({ status: 201, body: { Id: 'container-123' } });
      if (kind === 'containerStart') return response({ status: 204 });
      if (kind === 'containerExecCreate') return response({ status: 201, body: { Id: 'setup-exec-1' } });
      if (kind === 'execStart') return response({ status: 200, text: dockerMultiplexedExecOutput(setupOutput) });
      if (kind === 'execInspect') return response({ status: 200, body: { ExitCode: 100 } });
      throw new Error(`unexpected Docker request: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope({ node, nodeId: node.id }), context);

    expect(result).toMatchObject({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      reason: 'remote-error',
    });
    expect(result.message).toContain('Docker environment setup exited with code 100.');
    expect(result.message).toContain('Temporary failure resolving deb.debian.org');
    expect(requestBody(findOnlyRequest(requests, 'execStart'))).toEqual({ Detach: false, Tty: false });
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('continues to start the configured container when Docker create returns 409 for an owned container', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const node = nodeRecord({
      publicConfig: {
        docker: {
          endpointUrl: 'http://127.0.0.1:2375',
          containerName: 'existing-environment',
        },
      },
    });
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'imageInspect') return response({ status: 200, body: { Id: 'local-image-id' } });
      if (kind === 'containerCreate') return response({ status: 409 });
      if (kind === 'containerInspect') return response({ status: 200, body: containerInspectBody(dockerManagedLabels()) });
      if (kind === 'containerStart') return response({ status: 304 });
      if (kind === 'containerExecCreate') return response({ status: 201, body: { Id: 'setup-exec-1' } });
      if (kind === 'execStart') return response({ status: 200 });
      if (kind === 'execInspect') return response({ status: 200, body: { ExitCode: 0 } });
      throw new Error(`unexpected Docker request: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope({ node, nodeId: node.id }), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      message: 'Docker environment container started.',
      remoteResourceId: 'existing-environment',
    });
    const createRequest = findOnlyRequest(requests, 'containerCreate');
    const startRequest = findOnlyRequest(requests, 'containerStart');
    expect(new URL(createRequest.url).searchParams.get('name')).toBe('existing-environment');
    expect(new URL(startRequest.url).pathname).toBe('/containers/existing-environment/start');
    expect(requests.map(dockerRequestKind)).toEqual([
      'imageInspect',
      'containerCreate',
      'containerInspect',
      'containerStart',
      'containerExecCreate',
      'execStart',
      'execInspect',
    ]);
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('fails without starting an existing Docker container when 409 labels do not match', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const connection = connectionRecord();
    const environment = environmentRecord({
      publicConfig: {
        docker: {
          image: 'registry.example.test/runtime:1',
          containerName: 'claimed-by-someone-else',
        },
      },
    });
    const node = nodeRecord({ connectionId: connection.id, environmentId: environment.id });
    const agent = agentRecord({ connectionId: connection.id, environmentId: environment.id, nodeId: node.id });
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'imageInspect') return response({ status: 200, body: { Id: 'runtime-image-id' } });
      if (kind === 'containerCreate') return response({ status: 409 });
      if (kind === 'containerInspect') {
        return response({
          status: 200,
          body: containerInspectBody(dockerManagedLabels({
            connectionId: 'other-connection',
            environmentId: 'other-environment',
            nodeId: node.id,
            agentId: agent.id,
          })),
        });
      }
      throw new Error(`unexpected Docker request: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope({
      commandName: 'deploy-environment',
      connection,
      environment,
      node,
      agent,
      nodeId: node.id,
      agentId: agent.id,
      enrollment: undefined,
    }), context);

    expect(result).toMatchObject({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      reason: 'invalid-config',
      message: 'Docker container claimed-by-someone-else already exists but is not owned by this Remote Fleet environment.',
    });
    expect(requests.map(dockerRequestKind)).toEqual(['imageInspect', 'containerCreate', 'containerInspect']);
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('delete-environment stops and force-removes an owned Docker container', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const connection = connectionRecord();
    const environment = environmentRecord();
    const node = nodeRecord({ connectionId: connection.id, environmentId: environment.id });
    const agent = agentRecord({ connectionId: connection.id, environmentId: environment.id, nodeId: node.id });
    const managedResource = managedResourceRecord({
      connectionId: connection.id,
      environmentId: environment.id,
      nodeId: node.id,
      remoteResourceId: 'owned-env-container',
    });
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'containerInspect') {
        return response({
          status: 200,
          body: containerInspectBody(dockerManagedLabels({
            connectionId: connection.id,
            environmentId: environment.id,
            nodeId: node.id,
            agentId: agent.id,
          })),
        });
      }
      if (kind === 'containerStop') return response({ status: 304 });
      if (kind === 'containerRemove') return response({ status: 204 });
      throw new Error(`unexpected Docker request: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope({
      commandName: 'delete-environment',
      connection,
      environment,
      managedResource,
      node,
      agent,
      nodeId: node.id,
      agentId: agent.id,
      enrollment: undefined,
    }), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      message: 'Docker environment container deleted.',
      remoteResourceId: 'owned-env-container',
    });
    expect(requests.map(dockerRequestKind)).toEqual(['containerInspect', 'containerStop', 'containerRemove']);
    expect(new URL(findOnlyRequest(requests, 'containerRemove').url).searchParams.get('force')).toBe('true');
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('delete-environment refuses to remove a Docker container with mismatched labels', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const connection = connectionRecord();
    const environment = environmentRecord();
    const node = nodeRecord({ connectionId: connection.id, environmentId: environment.id });
    const agent = agentRecord({ connectionId: connection.id, environmentId: environment.id, nodeId: node.id });
    const managedResource = managedResourceRecord({
      connectionId: connection.id,
      environmentId: environment.id,
      nodeId: node.id,
      remoteResourceId: 'external-container',
    });
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'containerInspect') {
        return response({
          status: 200,
          body: containerInspectBody({
            'com.matchaclaw.remote-fleet.managed': 'true',
            'com.matchaclaw.remote-fleet.connection-id': connection.id,
            'com.matchaclaw.remote-fleet.environment-id': 'other-environment',
            'com.matchaclaw.remote-fleet.node-id': node.id,
            'com.matchaclaw.remote-fleet.agent-id': agent.id,
          }),
        });
      }
      throw new Error(`unexpected Docker request: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope({
      commandName: 'delete-environment',
      connection,
      environment,
      managedResource,
      node,
      agent,
      nodeId: node.id,
      agentId: agent.id,
      enrollment: undefined,
    }), context);

    expect(result).toMatchObject({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      reason: 'invalid-config',
      message: 'Docker container external-container is not owned by this Remote Fleet environment; refusing to delete it.',
    });
    expect(requests.map(dockerRequestKind)).toEqual(['containerInspect']);
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('delete-environment treats a missing Docker container as completed', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const connection = connectionRecord();
    const environment = environmentRecord();
    const node = nodeRecord({ connectionId: connection.id, environmentId: environment.id });
    const agent = agentRecord({ connectionId: connection.id, environmentId: environment.id, nodeId: node.id });
    const managedResource = managedResourceRecord({
      connectionId: connection.id,
      environmentId: environment.id,
      nodeId: node.id,
      remoteResourceId: 'already-gone-container',
    });
    const { context, requests } = contextWithDockerResponder((request) => {
      const kind = dockerRequestKind(request);
      if (kind === 'containerInspect') return response({ status: 404 });
      throw new Error(`unexpected Docker request: ${kind}`);
    });

    const result = await provider.dispatchCommand(bootstrapEnvelope({
      commandName: 'delete-environment',
      connection,
      environment,
      managedResource,
      node,
      agent,
      nodeId: node.id,
      agentId: agent.id,
      enrollment: undefined,
    }), context);

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      message: 'Docker environment container is already absent.',
      remoteResourceId: 'already-gone-container',
    });
    expect(requests.map(dockerRequestKind)).toEqual(['containerInspect']);
    expectNoSecretsInRequestOrResult(requests, result);
  });

  it('rejects Docker endpoint URLs with userinfo or credential query material before sending requests', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const unsafeUserInfoNode = nodeRecord({
      publicConfig: { docker: { endpointUrl: 'https://user:password@docker.example.test:2376' } },
    });
    const unsafeQueryNode = nodeRecord({
      publicConfig: { docker: { endpointUrl: 'https://docker.example.test:2376?token=sk-plaintexttoken' } },
    });
    const { context, requests } = contextWithResponses([]);

    await expect(provider.dispatchCommand(bootstrapEnvelope({ node: unsafeUserInfoNode, nodeId: unsafeUserInfoNode.id }), context)).resolves.toMatchObject({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      reason: 'invalid-config',
      message: 'Remote Fleet Docker endpointUrl must not contain username or password credentials.',
    });
    await expect(provider.dispatchCommand(bootstrapEnvelope({ node: unsafeQueryNode, nodeId: unsafeQueryNode.id }), context)).resolves.toMatchObject({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      reason: 'invalid-config',
      message: 'Remote Fleet Docker publicConfig contains unsafe credential material at publicConfig.docker.endpointUrl.',
    });
    expect(requests).toEqual([]);
  });

  it('rejects Docker bearer token secret refs outside the Remote Fleet secret namespace', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const node = nodeRecord({
      secretRefs: {
        dockerBearerToken: { kind: 'secret-ref', ref: 'vault://node/docker/bearer' },
      },
    });
    const { context, requests } = contextWithResponses([]);

    const result = await provider.dispatchCommand(bootstrapEnvelope({ node, nodeId: node.id }), context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      reason: 'auth',
      message: 'Docker bearer token secretRef is not allowed by Remote Fleet secret policy.',
    });
    expect(requests).toEqual([]);
  });

  it('returns typed invalid-config for unsupported unix socket Docker endpoints', async () => {
    const provider = createRemoteFleetDockerBootstrapProvider();
    const node = nodeRecord({
      publicConfig: { docker: { endpointUrl: 'unix:///var/run/docker.sock' } },
    });
    const { context, requests } = contextWithResponses([]);

    const result = await provider.dispatchCommand(bootstrapEnvelope({ node, nodeId: node.id }), context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'cmd-1',
      providerKind: 'docker',
      reason: 'invalid-config',
      message: 'Remote Fleet Docker endpointUrl must use http:// or https://; unix socket endpoints are not supported.',
    });
    expect(requests).toEqual([]);
  });
});
