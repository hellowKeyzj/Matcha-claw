import { describe, expect, it, vi } from 'vitest';
import { createRemoteFleetK8sBootstrapProvider } from '../../runtime-host/application/remote-fleet/remote-fleet-bootstrap-k8s-provider';
import { readRemoteFleetK8sBootstrapProviderConfig } from '../../runtime-host/application/remote-fleet/remote-fleet-k8s-target-config';
import type { RuntimeHttpClientPort, RuntimeHttpResponse } from '../../runtime-host/application/common/runtime-ports';
import {
  REMOTE_FLEET_BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
  createRemoteFleetConnectionProbeEnvelope,
  isRemoteFleetConnectionProbeResult,
  type RemoteFleetBootstrapCommandEnvelope,
  type RemoteFleetBootstrapCommandName,
  type RemoteFleetBootstrapCommandResult,
  type RemoteFleetBootstrapProviderContext,
  type RemoteFleetBootstrapSecretReadResult,
  type RemoteFleetConnectionProbeProvider,
  type RemoteFleetConnectionProbeResult,
} from '../../runtime-host/application/remote-fleet/remote-fleet-bootstrap';
import type {
  RemoteFleetConnectionRecord,
  RemoteFleetNodeRecord,
  RemoteFleetSecretRef,
  RuntimeAgentRecord,
} from '../../runtime-host/application/remote-fleet/remote-fleet-model';

const now = '2026-07-07T00:00:00.000Z';
const kubeBearerToken = 'kube-bearer-token-super-secret';
const enrollmentToken = 'runtime-agent-enrollment-token-super-secret';
const callbackUrl = 'https://matchaclaw.example.test/api/remote-fleet/runtime-agent/enroll';
const kubeBearerTokenRef: RemoteFleetSecretRef = { kind: 'secret-ref', ref: 'remote-fleet://node-1/kube-bearer-token' };

type RecordedHttpCall = {
  readonly url: string;
  readonly init?: RequestInit;
};

type RecordingHttpClient = RuntimeHttpClientPort & {
  readonly calls: RecordedHttpCall[];
};

function runtimeHttpResponse(input: {
  readonly status?: number;
  readonly ok?: boolean;
  readonly body?: unknown;
  readonly text?: string;
} = {}): RuntimeHttpResponse {
  const status = input.status ?? 200;
  const body = input.body ?? { kind: 'Status', status: 'Success' };
  return {
    ok: input.ok ?? (status >= 200 && status < 300),
    status,
    json: async () => body,
    text: async () => input.text ?? JSON.stringify(body),
  };
}

function createRecordingHttpClient(
  respond: (call: RecordedHttpCall) => RuntimeHttpResponse | Promise<RuntimeHttpResponse> = () => runtimeHttpResponse(),
): RecordingHttpClient {
  const calls: RecordedHttpCall[] = [];
  return {
    calls,
    request: vi.fn(async (url, init) => {
      const call = { url, init };
      calls.push(call);
      return await respond(call);
    }),
  };
}

function nodeRecord(overrides: Partial<RemoteFleetNodeRecord> = {}): RemoteFleetNodeRecord {
  return {
    id: 'node-1',
    displayName: 'Node 1',
    targetKind: 'k8s-pod',
    labels: ['remote'],
    enabled: true,
    publicConfig: {
      k8s: {
        apiServerUrl: 'https://k8s.example.test:6443',
      },
    },
    secretRefs: {
      kubeBearerToken: kubeBearerTokenRef,
    },
    health: { reason: 'unknown' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function connectionRecord(overrides: Partial<RemoteFleetConnectionRecord> = {}): RemoteFleetConnectionRecord {
  return {
    id: 'connection-1',
    displayName: 'Kubernetes connection',
    connectionKind: 'k8s-pod',
    labels: ['remote'],
    enabled: true,
    publicConfig: {
      k8s: {
        apiServerUrl: 'https://k8s.example.test:6443',
        defaultNamespace: 'runtime-agents',
      },
    },
    secretRefs: {
      kubeBearerToken: kubeBearerTokenRef,
    },
    health: { reason: 'unknown' },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function agentRecord(overrides: Partial<RuntimeAgentRecord> = {}): RuntimeAgentRecord {
  return {
    id: 'agent-1',
    nodeId: 'node-1',
    displayName: 'Agent 1',
    enrollment: { reason: 'not-installed' },
    capabilities: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function commandEnvelope(
  commandName: RemoteFleetBootstrapCommandName,
  overrides: Partial<RemoteFleetBootstrapCommandEnvelope> = {},
): RemoteFleetBootstrapCommandEnvelope {
  const node = overrides.node ?? nodeRecord();
  const agent = overrides.agent ?? agentRecord({ nodeId: node.id });
  return {
    envelopeVersion: REMOTE_FLEET_BOOTSTRAP_COMMAND_ENVELOPE_VERSION,
    commandId: `cmd-${commandName}`,
    idempotencyKey: `remote-fleet:${commandName}`,
    commandName,
    providerKind: 'k8s',
    nodeId: node.id,
    agentId: agent.id,
    node,
    agent,
    ...overrides,
  };
}

function installAgentEnvelope(
  node: RemoteFleetNodeRecord,
  input: { readonly includeCallbackUrl?: boolean } = {},
): RemoteFleetBootstrapCommandEnvelope {
  const agent = agentRecord({ nodeId: node.id });
  return commandEnvelope('install-agent', {
    commandId: 'cmd-install-agent',
    node,
    nodeId: node.id,
    agent,
    agentId: agent.id,
    enrollment: {
      agentId: agent.id,
      nodeId: node.id,
      token: enrollmentToken,
      expiresAt: '2026-07-07T00:15:00.000Z',
      ...(input.includeCallbackUrl === false ? {} : { callbackUrl }),
    },
  });
}

function createSecretReader(secretValue = kubeBearerToken): RemoteFleetBootstrapProviderContext['secrets'] & {
  readonly readSecret: ReturnType<typeof vi.fn>;
} {
  return {
    readSecret: vi.fn(async (secretRefName: string): Promise<RemoteFleetBootstrapSecretReadResult> => {
      if (secretRefName !== 'kubeBearerToken') {
        return { resultType: 'missing', secretRefName };
      }
      return {
        resultType: 'resolved',
        secretRefName,
        secretRef: kubeBearerTokenRef,
        plaintextSecretValue: secretValue,
      };
    }),
  };
}

type RecordingProviderContext = RemoteFleetBootstrapProviderContext & {
  readonly logger: {
    readonly debug: ReturnType<typeof vi.fn>;
    readonly warn: ReturnType<typeof vi.fn>;
  };
};

function providerContext(httpClient: RecordingHttpClient, secrets = createSecretReader()): RecordingProviderContext {
  return {
    httpClient,
    secrets,
    logger: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
  };
}

function createSecretReaderWithResult(readResult: RemoteFleetBootstrapSecretReadResult): RemoteFleetBootstrapProviderContext['secrets'] & {
  readonly readSecret: ReturnType<typeof vi.fn>;
} {
  return {
    readSecret: vi.fn(async () => readResult),
  };
}

function connectionProbeEnvelope(connection = connectionRecord()) {
  return createRemoteFleetConnectionProbeEnvelope({
    commandId: 'connection-probe-1',
    idempotencyKey: 'remote-fleet:probe-connection',
    connection,
  });
}

function expectConnectionProbeDoesNotLeakSensitiveValues(
  result: RemoteFleetConnectionProbeResult,
  context: RecordingProviderContext,
  sensitiveValues: readonly string[],
): void {
  expect(isRemoteFleetConnectionProbeResult(result)).toBe(true);
  const projectedValues = JSON.stringify({
    result,
    debugCalls: context.logger.debug.mock.calls,
    warnCalls: context.logger.warn.mock.calls,
  });
  for (const sensitiveValue of sensitiveValues) {
    expect(projectedValues).not.toContain(sensitiveValue);
  }
}

function headerValue(init: RequestInit | undefined, headerName: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(headerName) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const header = headers.find(([name]) => name.toLowerCase() === headerName.toLowerCase());
    return header?.[1];
  }
  const record = headers as Record<string, string>;
  const matchingName = Object.keys(record).find((name) => name.toLowerCase() === headerName.toLowerCase());
  return matchingName ? record[matchingName] : undefined;
}

function parsedRequestBody(call: RecordedHttpCall): Record<string, unknown> {
  const body = call.init?.body;
  if (typeof body === 'string') return JSON.parse(body) as Record<string, unknown>;
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  throw new Error(`Expected JSON request body for ${call.url}`);
}

function resourceIdentity(body: Record<string, unknown>): { readonly kind?: string; readonly name?: string } {
  const metadata = body.metadata as { readonly name?: unknown } | undefined;
  return {
    kind: typeof body.kind === 'string' ? body.kind : undefined,
    name: typeof metadata?.name === 'string' ? metadata.name : undefined,
  };
}

function bodyForResource(calls: readonly RecordedHttpCall[], kind: string, resourceName: string): Record<string, unknown> {
  for (const call of calls) {
    if (!call.init?.body) continue;
    const body = parsedRequestBody(call);
    const identity = resourceIdentity(body);
    if (identity.kind === kind && identity.name === resourceName) return body;
  }
  throw new Error(`Expected Kubernetes ${kind} body for resource ${resourceName}`);
}

function resourcePaths(calls: readonly RecordedHttpCall[]): string[] {
  return calls.map((call) => new URL(call.url).pathname);
}

function containerEnvFromDeploymentBody(body: Record<string, unknown>): readonly Record<string, unknown>[] {
  const spec = body.spec as { readonly template?: { readonly spec?: { readonly containers?: readonly { readonly env?: readonly Record<string, unknown>[] }[] } } } | undefined;
  return spec?.template?.spec?.containers?.[0]?.env ?? [];
}

function expectResultSummaryDoesNotLeakSecrets(
  result: RemoteFleetBootstrapCommandResult,
  secrets: readonly string[],
): void {
  const message = 'message' in result ? result.message : undefined;
  const outputSummary = result.resultType === 'completed' ? result.outputSummary : undefined;
  const summaryText = [message, outputSummary].filter(Boolean).join('\n');
  for (const secret of secrets) {
    expect(summaryText).not.toContain(secret);
  }
}

describe('Remote Fleet Kubernetes bootstrap provider', () => {
  it('merges shared connection endpoint/auth with separate Kubernetes workload environments', () => {
    const connectionPublicConfig = {
      k8s: {
        apiServerUrl: 'https://shared-k8s.example.test:6443',
        defaultNamespace: 'shared-runtime-agents',
      },
    };
    const connectionSecretRefs = {
      kubeBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connection-1/kube-bearer-token' },
    };

    const blueConfig = readRemoteFleetK8sBootstrapProviderConfig({
      connectionPublicConfig,
      connectionSecretRefs,
      nodePublicConfig: {
        k8s: {
          apiServerUrl: 'https://node-blue-k8s.example.test:6443',
          namespace: 'blue-runtime-agents',
          deploymentName: 'blue-runtime-agent',
        },
      },
      nodeSecretRefs: {
        kubeBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://node-blue/kube-bearer-token' },
      },
      nodeId: 'node-blue',
      agentId: 'agent-blue',
    });
    const greenConfig = readRemoteFleetK8sBootstrapProviderConfig({
      connectionPublicConfig,
      connectionSecretRefs,
      nodePublicConfig: {
        k8s: {
          namespace: 'green-runtime-agents',
          deploymentName: 'green-runtime-agent',
        },
      },
      nodeId: 'node-green',
      agentId: 'agent-green',
    });

    expect(blueConfig).toMatchObject({
      resultType: 'valid',
      config: {
        apiServerUrl: 'https://shared-k8s.example.test:6443',
        namespace: 'blue-runtime-agents',
        deploymentName: 'blue-runtime-agent',
        serviceName: 'blue-runtime-agent',
        kubeBearerTokenSecretRef: 'remote-fleet://connection-1/kube-bearer-token',
      },
    });
    expect(greenConfig).toMatchObject({
      resultType: 'valid',
      config: {
        apiServerUrl: 'https://shared-k8s.example.test:6443',
        namespace: 'green-runtime-agents',
        deploymentName: 'green-runtime-agent',
        serviceName: 'green-runtime-agent',
        kubeBearerTokenSecretRef: 'remote-fleet://connection-1/kube-bearer-token',
      },
    });
    if (blueConfig.resultType !== 'valid' || greenConfig.resultType !== 'valid') throw new Error('expected valid configs');
    expect(blueConfig.config.namespace).not.toBe(greenConfig.config.namespace);
    expect(blueConfig.config.deploymentName).not.toBe(greenConfig.config.deploymentName);
  });

  it('probes Kubernetes with bearer auth and the configured namespace path', async () => {
    const httpClient = createRecordingHttpClient(() => runtimeHttpResponse({ body: { metadata: { name: 'runtime-agents' } } }));
    const secrets = createSecretReader();
    const provider = createRemoteFleetK8sBootstrapProvider();
    const node = nodeRecord({
      publicConfig: {
        k8s: {
          apiServerUrl: 'https://k8s.example.test:6443',
          namespace: 'runtime-agents',
        },
      },
    });

    const result = await provider.dispatchCommand(
      commandEnvelope('probe-node', { node, nodeId: node.id }),
      providerContext(httpClient, secrets),
    );

    expect(provider.providerKind).toBe('k8s');
    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-probe-node',
      providerKind: 'k8s',
    });
    expect(secrets.readSecret).toHaveBeenCalledWith('kubeBearerToken');
    expect(httpClient.calls).toHaveLength(1);
    const call = httpClient.calls[0];
    const url = new URL(call.url);
    expect(url.origin).toBe('https://k8s.example.test:6443');
    expect(url.search).toBe('');
    expect(['/api/v1/namespaces/runtime-agents', '/version']).toContain(url.pathname);
    expect(call.init?.method ?? 'GET').toBe('GET');
    expect(headerValue(call.init, 'authorization')).toBe(`Bearer ${kubeBearerToken}`);
    expectResultSummaryDoesNotLeakSecrets(result, [kubeBearerToken]);
  });

  it('probes a Kubernetes connection through the Namespace API GET seam without projecting bearer or response secrets', async () => {
    const responseBodySecret = 'kubernetes-namespace-response-secret';
    const httpClient = createRecordingHttpClient(() => runtimeHttpResponse({
      body: { metadata: { name: 'runtime-agents' }, diagnostic: responseBodySecret },
    }));
    const secrets = createSecretReader();
    const context = providerContext(httpClient, secrets);
    const provider = createRemoteFleetK8sBootstrapProvider() as RemoteFleetConnectionProbeProvider;
    const envelope = connectionProbeEnvelope();

    const result = await provider.probeConnection(envelope, context);

    expect(result).toEqual({
      resultType: 'completed',
      commandId: 'connection-probe-1',
      providerKind: 'k8s',
    });
    expect(isRemoteFleetConnectionProbeResult(result)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(kubeBearerToken);
    expect(secrets.readSecret).toHaveBeenCalledWith('kubeBearerToken');
    expect(httpClient.calls).toHaveLength(1);
    expect(httpClient.calls[0]).toMatchObject({
      url: 'https://k8s.example.test:6443/api/v1/namespaces/runtime-agents',
      init: { method: 'GET' },
    });
    expect(headerValue(httpClient.calls[0].init, 'authorization')).toBe(`Bearer ${kubeBearerToken}`);
    expect(JSON.stringify(httpClient.calls)).toContain(kubeBearerToken);
    expectConnectionProbeDoesNotLeakSensitiveValues(result, context, [kubeBearerToken, responseBodySecret]);
  });

  it.each([401, 403])('maps Kubernetes connection probe HTTP %d to auth without projecting the response body', async (status) => {
    const responseBodySecret = `kubernetes-http-${status}-response-secret`;
    const httpClient = createRecordingHttpClient(() => runtimeHttpResponse({
      status,
      ok: false,
      body: { message: responseBodySecret },
    }));
    const context = providerContext(httpClient);
    const provider = createRemoteFleetK8sBootstrapProvider() as RemoteFleetConnectionProbeProvider;

    const result = await provider.probeConnection(connectionProbeEnvelope(), context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'connection-probe-1',
      providerKind: 'k8s',
      reason: 'auth',
    });
    expect(httpClient.calls).toHaveLength(1);
    expect(headerValue(httpClient.calls[0].init, 'authorization')).toBe(`Bearer ${kubeBearerToken}`);
    expectConnectionProbeDoesNotLeakSensitiveValues(result, context, [kubeBearerToken, responseBodySecret]);
  });

  it('returns invalid-config for a Kubernetes connection without an API server before resolving a secret or making a request', async () => {
    const httpClient = createRecordingHttpClient();
    const secrets = createSecretReader();
    const context = providerContext(httpClient, secrets);
    const provider = createRemoteFleetK8sBootstrapProvider() as RemoteFleetConnectionProbeProvider;
    const connection = connectionRecord({ publicConfig: { k8s: {} } });

    const result = await provider.probeConnection(connectionProbeEnvelope(connection), context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'connection-probe-1',
      providerKind: 'k8s',
      reason: 'invalid-config',
    });
    expect(secrets.readSecret).not.toHaveBeenCalled();
    expect(httpClient.calls).toHaveLength(0);
    expectConnectionProbeDoesNotLeakSensitiveValues(result, context, [kubeBearerToken]);
  });

  it.each([
    ['missing', { resultType: 'missing', secretRefName: 'kubeBearerToken' }, 'missing-secret'],
    ['access denied', { resultType: 'accessDenied', secretRefName: 'kubeBearerToken', secretRef: kubeBearerTokenRef }, 'auth'],
    ['unavailable', { resultType: 'unavailable', secretRefName: 'kubeBearerToken', secretRef: kubeBearerTokenRef }, 'unavailable'],
  ] as const)('maps Kubernetes connection probe secret resolver %s through the provider reason', async (_name, readResult, reason) => {
    const httpClient = createRecordingHttpClient();
    const secrets = createSecretReaderWithResult(readResult);
    const context = providerContext(httpClient, secrets);
    const provider = createRemoteFleetK8sBootstrapProvider() as RemoteFleetConnectionProbeProvider;

    const result = await provider.probeConnection(connectionProbeEnvelope(), context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'connection-probe-1',
      providerKind: 'k8s',
      reason,
    });
    expect(secrets.readSecret).toHaveBeenCalledWith('kubeBearerToken');
    expect(httpClient.calls).toHaveLength(0);
    expectConnectionProbeDoesNotLeakSensitiveValues(result, context, [kubeBearerToken]);
  });

  it.each([
    ['network error', new Error('Kubernetes socket reset'), 'network'],
    ['AbortError', Object.assign(new Error('Kubernetes request timed out'), { name: 'AbortError' }), 'timeout'],
    ['TimeoutError', Object.assign(new Error('Kubernetes request timed out'), { name: 'TimeoutError' }), 'timeout'],
  ] as const)('maps Kubernetes connection probe %s through the provider typed reason', async (_name, requestError, reason) => {
    const httpClient = createRecordingHttpClient(() => {
      throw requestError;
    });
    const context = providerContext(httpClient);
    const provider = createRemoteFleetK8sBootstrapProvider() as RemoteFleetConnectionProbeProvider;

    const result = await provider.probeConnection(connectionProbeEnvelope(), context);

    expect(result).toEqual({
      resultType: 'failed',
      commandId: 'connection-probe-1',
      providerKind: 'k8s',
      reason,
    });
    expect(httpClient.calls).toHaveLength(1);
    expect(headerValue(httpClient.calls[0].init, 'authorization')).toBe(`Bearer ${kubeBearerToken}`);
    expectConnectionProbeDoesNotLeakSensitiveValues(result, context, [kubeBearerToken]);
  });

  it('installs Secret, Deployment, and Service defaults without leaking kube or enrollment tokens', async () => {
    const deploymentName = 'matchaclaw-runtime-agent-node-id-prod';
    const serviceName = deploymentName;
    const secretName = 'matchaclaw-runtime-agent-enrollment-node-id-prod';
    const legacyLabels = {
      'app.kubernetes.io/name': 'matchaclaw-runtime-agent',
      'app.kubernetes.io/instance': deploymentName,
      'app.kubernetes.io/managed-by': 'matchaclaw',
      'matchaclaw.ai/node-id': 'node-id-prod',
      'matchaclaw.ai/agent-id': 'agent-1',
    };
    const httpClient = createRecordingHttpClient((call) => {
      const method = call.init?.method?.toUpperCase() ?? 'GET';
      const path = new URL(call.url).pathname;
      if (method === 'POST' && (
        path === '/api/v1/namespaces/default/secrets'
        || path === '/apis/apps/v1/namespaces/default/deployments'
        || path === '/api/v1/namespaces/default/services'
      )) {
        return runtimeHttpResponse({
          status: 409,
          ok: false,
          body: { kind: 'Status', reason: 'AlreadyExists' },
        });
      }
      if (method === 'GET' && (
        path === `/api/v1/namespaces/default/secrets/${secretName}`
        || path === `/apis/apps/v1/namespaces/default/deployments/${deploymentName}`
        || path === `/api/v1/namespaces/default/services/${serviceName}`
      )) {
        return runtimeHttpResponse({ body: { metadata: { labels: legacyLabels } } });
      }
      return runtimeHttpResponse();
    });
    const provider = createRemoteFleetK8sBootstrapProvider();
    const node = nodeRecord({ id: 'Node_ID.Prod', displayName: 'Node ID Prod' });

    const result = await provider.dispatchCommand(installAgentEnvelope(node), providerContext(httpClient));

    expect(result).toMatchObject({
      resultType: 'completed',
      commandId: 'cmd-install-agent',
      providerKind: 'k8s',
    });
    for (const call of httpClient.calls) {
      expect(new URL(call.url).origin).toBe('https://k8s.example.test:6443');
      expect(headerValue(call.init, 'authorization')).toBe(`Bearer ${kubeBearerToken}`);
    }

    const paths = resourcePaths(httpClient.calls);
    expect(paths).toContain(`/api/v1/namespaces/default/secrets/${secretName}`);
    expect(paths).toContain(`/apis/apps/v1/namespaces/default/deployments/${deploymentName}`);
    expect(paths).toContain(`/api/v1/namespaces/default/services/${serviceName}`);

    const secretBody = bodyForResource(httpClient.calls, 'Secret', secretName);
    expect(secretBody).toMatchObject({
      metadata: { name: secretName, namespace: 'default' },
      stringData: { token: enrollmentToken },
    });

    const deploymentBody = bodyForResource(httpClient.calls, 'Deployment', deploymentName);
    expect(deploymentBody).toMatchObject({
      metadata: { name: deploymentName, namespace: 'default' },
    });
    expect(JSON.stringify(deploymentBody)).toContain('matchaclaw/runtime-agent:latest');
    expect(JSON.stringify(deploymentBody)).toContain('8721');
    const env = containerEnvFromDeploymentBody(deploymentBody);
    expect(env).toEqual([
      { name: 'MATCHACLAW_AGENT_ID', value: 'agent-1' },
      { name: 'MATCHACLAW_NODE_ID', value: 'Node_ID.Prod' },
      {
        name: 'MATCHACLAW_ENROLLMENT_TOKEN',
        valueFrom: {
          secretKeyRef: { name: secretName, key: 'token' },
        },
      },
      { name: 'MATCHACLAW_ENROLLMENT_EXPIRES_AT', value: '2026-07-07T00:15:00.000Z' },
      { name: 'MATCHACLAW_ENROLLMENT_CALLBACK_URL', value: callbackUrl },
    ]);
    expect(JSON.stringify(env)).not.toContain(enrollmentToken);
    expect(JSON.stringify(env)).not.toContain('MATCHACLAW_CALLBACK_URL');

    const serviceBody = bodyForResource(httpClient.calls, 'Service', serviceName);
    const serviceSpec = serviceBody.spec as { readonly ports?: readonly Record<string, unknown>[]; readonly selector?: Record<string, string> } | undefined;
    expect(serviceBody).toMatchObject({
      metadata: { name: serviceName, namespace: 'default' },
    });
    expect(serviceSpec?.ports).toEqual(expect.arrayContaining([expect.objectContaining({ port: 8721 })]));
    const deploymentSpec = deploymentBody.spec as { readonly template?: { readonly metadata?: { readonly labels?: Record<string, string> } } } | undefined;
    const deploymentLabels = deploymentSpec?.template?.metadata?.labels ?? {};
    const serviceSelector = serviceSpec?.selector ?? {};
    expect(Object.keys(serviceSelector).length).toBeGreaterThan(0);
    expect(Object.entries(serviceSelector).every(([key, value]) => deploymentLabels[key] === value)).toBe(true);
    expectResultSummaryDoesNotLeakSecrets(result, [kubeBearerToken, enrollmentToken]);
  });

  it('does not project callback env when enrollment callback is absent', async () => {
    const httpClient = createRecordingHttpClient();
    const provider = createRemoteFleetK8sBootstrapProvider();
    const node = nodeRecord({ id: 'Node_ID.Prod', displayName: 'Node ID Prod' });

    const result = await provider.dispatchCommand(
      installAgentEnvelope(node, { includeCallbackUrl: false }),
      providerContext(httpClient),
    );

    expect(result).toMatchObject({ resultType: 'completed' });
    const deploymentBody = bodyForResource(
      httpClient.calls,
      'Deployment',
      'matchaclaw-runtime-agent-node-id-prod',
    );
    const env = containerEnvFromDeploymentBody(deploymentBody);
    expect(env).toEqual([
      { name: 'MATCHACLAW_AGENT_ID', value: 'agent-1' },
      { name: 'MATCHACLAW_NODE_ID', value: 'Node_ID.Prod' },
      {
        name: 'MATCHACLAW_ENROLLMENT_TOKEN',
        valueFrom: {
          secretKeyRef: { name: 'matchaclaw-runtime-agent-enrollment-node-id-prod', key: 'token' },
        },
      },
      { name: 'MATCHACLAW_ENROLLMENT_EXPIRES_AT', value: '2026-07-07T00:15:00.000Z' },
    ]);
    expect(JSON.stringify(env)).not.toContain(enrollmentToken);
    expect(JSON.stringify(env)).not.toContain('MATCHACLAW_ENROLLMENT_CALLBACK_URL');
    expect(JSON.stringify(env)).not.toContain('MATCHACLAW_CALLBACK_URL');
  });

  it('rejects unsafe Kubernetes connection publicConfig before provider execution', () => {
    const result = readRemoteFleetK8sBootstrapProviderConfig({
      connectionPublicConfig: {
        k8s: {
          apiServerUrl: 'https://k8s.example.test:6443',
          kubeBearerToken: 'super-secret',
        },
      },
      connectionSecretRefs: {
        kubeBearerToken: { kind: 'secret-ref', ref: 'remote-fleet://connection-1/kube-bearer-token' },
      },
      nodePublicConfig: { k8s: { namespace: 'runtime-agents' } },
      nodeId: 'node-1',
      agentId: 'agent-1',
    });

    expect(result).toMatchObject({
      resultType: 'invalid',
      message: 'Remote Fleet Kubernetes connection publicConfig contains unsafe credential material at publicConfig.k8s.kubeBearerToken.',
    });
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('requires node.secretRefs.kubeBearerToken before calling Kubernetes', async () => {
    const httpClient = createRecordingHttpClient();
    const provider = createRemoteFleetK8sBootstrapProvider();
    const node = nodeRecord({ secretRefs: {} });

    const result = await provider.dispatchCommand(
      commandEnvelope('probe-node', { node, nodeId: node.id }),
      providerContext(httpClient),
    );

    expect(result).toMatchObject({
      resultType: 'failed',
      commandId: 'cmd-probe-node',
      providerKind: 'k8s',
      reason: 'missing-secret',
    });
    expect(httpClient.calls).toHaveLength(0);
    expectResultSummaryDoesNotLeakSecrets(result, [kubeBearerToken]);
  });

  it.each([
    {
      name: 'missing apiServerUrl',
      k8s: {},
      leaked: 'kube-bearer-token-super-secret',
    },
    {
      name: 'userinfo apiServerUrl',
      k8s: { apiServerUrl: 'https://admin:super-secret@k8s.example.test:6443' },
      leaked: 'super-secret',
    },
    {
      name: 'query credential apiServerUrl',
      k8s: { apiServerUrl: 'https://k8s.example.test:6443?token=super-secret' },
      leaked: 'super-secret',
    },
    {
      name: 'plaintext kubeBearerToken publicConfig',
      k8s: { apiServerUrl: 'https://k8s.example.test:6443', kubeBearerToken: 'super-secret' },
      leaked: 'super-secret',
    },
  ])('rejects $name before resolving secrets or calling Kubernetes', async ({ k8s, leaked }) => {
    const httpClient = createRecordingHttpClient();
    const secrets = createSecretReader();
    const provider = createRemoteFleetK8sBootstrapProvider();
    const node = nodeRecord({ publicConfig: { k8s } });

    const result = await provider.dispatchCommand(
      commandEnvelope('probe-node', { node, nodeId: node.id }),
      providerContext(httpClient, secrets),
    );

    expect(result).toMatchObject({
      resultType: 'failed',
      commandId: 'cmd-probe-node',
      providerKind: 'k8s',
      reason: 'invalid-config',
    });
    expect(secrets.readSecret).not.toHaveBeenCalled();
    expect(httpClient.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain(leaked);
    expect(JSON.stringify(result)).not.toContain('token=');
    expect(JSON.stringify(result)).not.toContain('admin:');
  });
});
