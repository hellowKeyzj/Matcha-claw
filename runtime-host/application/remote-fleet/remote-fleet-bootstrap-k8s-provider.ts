import type { RuntimeHttpClientPort, RuntimeHttpResponse } from '../common/runtime-ports';
import type {
  RemoteFleetBootstrapCommandEnvelope,
  RemoteFleetBootstrapCommandResult,
  RemoteFleetBootstrapFailureReason,
  RemoteFleetBootstrapManagedResourceResult,
  RemoteFleetBootstrapProvider,
  RemoteFleetBootstrapProviderContext,
  RemoteFleetBootstrapSecretReadResult,
  RemoteFleetConnectionProbeEnvelope,
  RemoteFleetConnectionProbeFailureReason,
  RemoteFleetConnectionProbeProvider,
  RemoteFleetConnectionProbeResult,
} from './remote-fleet-bootstrap';
import {
  buildK8sApiUrl as buildK8sUrl,
  buildK8sResourceName,
  k8sPathSegment as pathSegment,
  readRemoteFleetK8sBootstrapProviderConfig,
  readRemoteFleetK8sConnectionProbeConfig,
  REMOTE_FLEET_K8S_PROVIDER_KIND as K8S_PROVIDER_KIND,
  REMOTE_FLEET_KUBE_BEARER_TOKEN_SECRET_REF_NAME as KUBE_BEARER_TOKEN_SECRET_REF_NAME,
  type RemoteFleetK8sBootstrapConfig as K8sBootstrapConfig,
  type RemoteFleetK8sBootstrapProviderConfig as K8sBootstrapProviderConfig,
} from './remote-fleet-k8s-target-config';
import { evaluateRemoteFleetSecretRefPolicy } from './remote-fleet-secret-policy';

const RUNTIME_AGENT_CONTAINER_NAME = 'runtime-agent';
const ENROLLMENT_SECRET_KEY = 'token';
const K8S_CONTENT_TYPE_JSON = 'application/json';
const K8S_CONTENT_TYPE_MERGE_PATCH = 'application/merge-patch+json';
const K8S_MANAGED_LABEL = 'com.matchaclaw.remote-fleet.managed';
const K8S_CONNECTION_ID_LABEL = 'com.matchaclaw.remote-fleet.connection-id';
const K8S_ENVIRONMENT_ID_LABEL = 'com.matchaclaw.remote-fleet.environment-id';
const K8S_NODE_ID_LABEL = 'com.matchaclaw.remote-fleet.node-id';
const K8S_AGENT_ID_LABEL = 'com.matchaclaw.remote-fleet.agent-id';

type KubeBearerTokenResult =
  | { readonly resultType: 'resolved'; readonly token: string }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult };

interface K8sResourceRequest {
  readonly collectionPath: string;
  readonly resourcePath: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export const REMOTE_FLEET_K8S_BOOTSTRAP_PROVIDER: RemoteFleetBootstrapProvider & RemoteFleetConnectionProbeProvider = {
  providerKind: K8S_PROVIDER_KIND,
  async dispatchCommand(envelope, context) {
    return dispatchK8sBootstrapCommand(envelope, context);
  },
  async probeConnection(envelope, context) {
    return await probeK8sConnection(envelope, context);
  },
};

export function createRemoteFleetK8sBootstrapProvider(): RemoteFleetBootstrapProvider & RemoteFleetConnectionProbeProvider {
  return REMOTE_FLEET_K8S_BOOTSTRAP_PROVIDER;
}

async function probeK8sConnection(
  envelope: RemoteFleetConnectionProbeEnvelope,
  context: RemoteFleetBootstrapProviderContext,
): Promise<RemoteFleetConnectionProbeResult> {
  if (envelope.providerKind !== K8S_PROVIDER_KIND || envelope.connection.connectionKind !== 'k8s-pod') {
    return failedConnectionProbe(envelope, 'unsupported');
  }
  if (!context.httpClient) {
    return failedConnectionProbe(envelope, 'unavailable');
  }

  const configResult = readRemoteFleetK8sConnectionProbeConfig({
    connectionPublicConfig: envelope.connection.publicConfig,
    connectionSecretRefs: envelope.connection.secretRefs,
  });
  if (configResult.resultType === 'invalid') {
    return failedConnectionProbe(envelope, 'invalid-config');
  }

  const kubeBearerToken = await readKubeBearerTokenForConnectionProbe(envelope, context, configResult.config.kubeBearerTokenSecretRef);
  if (kubeBearerToken.resultType === 'failed') return kubeBearerToken.result;

  try {
    const response = await context.httpClient.request(buildK8sUrl(configResult.config.apiServerUrl, namespacePath(configResult.config.namespace)), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${kubeBearerToken.token}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return failedConnectionProbe(envelope, failureReasonForK8sConnectionProbeStatus(response.status));
    }
    return {
      resultType: 'completed',
      commandId: envelope.commandId,
      providerKind: K8S_PROVIDER_KIND,
    };
  } catch (error) {
    return failedConnectionProbe(envelope, failureReasonForK8sConnectionProbeRequestError(error));
  }
}

async function readKubeBearerTokenForConnectionProbe(
  envelope: RemoteFleetConnectionProbeEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  kubeBearerTokenSecretRef: string | undefined,
): Promise<{ readonly resultType: 'resolved'; readonly token: string } | { readonly resultType: 'failed'; readonly result: RemoteFleetConnectionProbeResult }> {
  if (!kubeBearerTokenSecretRef) {
    return { resultType: 'failed', result: failedConnectionProbe(envelope, 'missing-secret') };
  }
  if (evaluateRemoteFleetSecretRefPolicy(kubeBearerTokenSecretRef).decision !== 'allowed') {
    return { resultType: 'failed', result: failedConnectionProbe(envelope, 'auth') };
  }

  try {
    const readResult = await context.secrets.readSecret(KUBE_BEARER_TOKEN_SECRET_REF_NAME);
    switch (readResult.resultType) {
      case 'resolved': {
        const token = readResult.plaintextSecretValue.trim();
        return token
          ? { resultType: 'resolved', token }
          : { resultType: 'failed', result: failedConnectionProbe(envelope, 'missing-secret') };
      }
      case 'missing':
        return { resultType: 'failed', result: failedConnectionProbe(envelope, 'missing-secret') };
      case 'accessDenied':
        return { resultType: 'failed', result: failedConnectionProbe(envelope, 'auth') };
      case 'unavailable':
        return { resultType: 'failed', result: failedConnectionProbe(envelope, 'unavailable') };
    }
  } catch {
    return { resultType: 'failed', result: failedConnectionProbe(envelope, 'unavailable') };
  }
}

async function dispatchK8sBootstrapCommand(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
): Promise<RemoteFleetBootstrapCommandResult> {
  if (envelope.providerKind !== K8S_PROVIDER_KIND || envelope.node.targetKind !== 'k8s-pod') {
    return failed(envelope, 'unsupported-target', 'Kubernetes bootstrap provider only supports k8s-pod nodes.');
  }

  if (!context.httpClient) {
    return failed(envelope, 'unavailable', 'Kubernetes bootstrap provider requires a runtime HTTP client.');
  }

  const configResult = readK8sBootstrapConfig(envelope);
  if (configResult.resultType === 'invalid') {
    return failed(envelope, 'invalid-config', configResult.message);
  }

  const kubeBearerToken = await readKubeBearerToken(envelope, context, configResult.config);
  if (kubeBearerToken.resultType === 'failed') {
    return kubeBearerToken.result;
  }

  if (envelope.commandName === 'probe-node') {
    return probeK8sNode(envelope, context.httpClient, configResult.config, kubeBearerToken.token);
  }

  if (envelope.commandName === 'install-agent' || envelope.commandName === 'deploy-environment') {
    if (envelope.commandName === 'deploy-environment' && !envelope.environment) {
      return failed(envelope, 'invalid-config', 'Kubernetes deploy-environment requires a Remote Fleet environment.');
    }
    return installK8sRuntimeAgent(envelope, context.httpClient, configResult.config, kubeBearerToken.token);
  }

  if (envelope.commandName === 'delete-environment') {
    if (!envelope.environment) {
      return failed(envelope, 'invalid-config', 'Kubernetes delete-environment requires a Remote Fleet environment.');
    }
    return deleteK8sRuntimeAgent(envelope, context.httpClient, configResult.config, kubeBearerToken.token);
  }

  return failed(envelope, 'unsupported-target', `Kubernetes bootstrap command is not supported: ${envelope.commandName}.`);
}

function readK8sBootstrapConfig(envelope: RemoteFleetBootstrapCommandEnvelope) {
  return readRemoteFleetK8sBootstrapProviderConfig({
    connectionPublicConfig: envelope.connection?.publicConfig,
    connectionSecretRefs: envelope.connection?.secretRefs,
    environmentPublicConfig: envelope.environment?.publicConfig,
    environmentSecretRefs: envelope.environment?.secretRefs,
    nodePublicConfig: envelope.node.publicConfig,
    nodeSecretRefs: envelope.node.secretRefs,
    nodeId: envelope.node.id,
    agentId: envelope.agent.id,
  });
}

async function readKubeBearerToken(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: K8sBootstrapProviderConfig,
): Promise<KubeBearerTokenResult> {
  if (!config.kubeBearerTokenSecretRef) {
    return {
      resultType: 'failed',
      result: failed(envelope, 'missing-secret', 'Kubernetes bootstrap requires secretRef kubeBearerToken.'),
    };
  }

  const secretRefPolicy = evaluateRemoteFleetSecretRefPolicy(config.kubeBearerTokenSecretRef);
  if (secretRefPolicy.decision !== 'allowed') {
    return {
      resultType: 'failed',
      result: failed(envelope, 'auth', 'Kubernetes kubeBearerToken secretRef is not allowed by Remote Fleet secret policy.'),
    };
  }

  const readResult = await context.secrets.readSecret(KUBE_BEARER_TOKEN_SECRET_REF_NAME);
  return kubeBearerTokenFromSecretRead(envelope, readResult);
}

function kubeBearerTokenFromSecretRead(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  readResult: RemoteFleetBootstrapSecretReadResult,
): KubeBearerTokenResult {
  switch (readResult.resultType) {
    case 'resolved': {
      const token = readResult.plaintextSecretValue.trim();
      if (!token) {
        return {
          resultType: 'failed',
          result: failed(envelope, 'missing-secret', 'Kubernetes kubeBearerToken secret resolved to an empty value.'),
        };
      }
      return { resultType: 'resolved', token };
    }
    case 'missing':
      return {
        resultType: 'failed',
        result: failed(envelope, 'missing-secret', 'Kubernetes kubeBearerToken secret is missing.'),
      };
    case 'accessDenied':
      return {
        resultType: 'failed',
        result: failed(envelope, 'auth', 'Kubernetes kubeBearerToken secret could not be read due to access policy.'),
      };
    case 'unavailable':
      return {
        resultType: 'failed',
        result: failed(envelope, 'unavailable', 'Kubernetes kubeBearerToken secret resolver is unavailable.'),
      };
  }
}

async function probeK8sNode(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  httpClient: RuntimeHttpClientPort,
  config: K8sBootstrapConfig,
  kubeBearerToken: string,
): Promise<RemoteFleetBootstrapCommandResult> {
  const response = await requestK8sApi(
    envelope,
    httpClient,
    config,
    kubeBearerToken,
    'GET',
    namespacePath(config.namespace),
  );
  if (response.resultType === 'failed') return response.result;

  return {
    resultType: 'completed',
    commandId: envelope.commandId,
    providerKind: K8S_PROVIDER_KIND,
    message: `Kubernetes namespace ${config.namespace} is reachable.`,
    remoteResourceId: `namespace/${config.namespace}`,
  };
}

async function installK8sRuntimeAgent(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  httpClient: RuntimeHttpClientPort,
  config: K8sBootstrapConfig,
  kubeBearerToken: string,
): Promise<RemoteFleetBootstrapCommandResult> {
  if (!envelope.enrollment?.token) {
    return failed(envelope, 'invalid-config', 'Kubernetes install-agent requires an enrollment context.');
  }

  const secretName = config.secretName;
  const labels = buildRuntimeAgentLabels(envelope, config);
  const requests: readonly K8sResourceRequest[] = [
    buildSecretRequest(config, secretName, labels, envelope.enrollment.token),
    buildDeploymentRequest(config, secretName, labels, envelope),
    buildServiceRequest(config, labels),
  ];

  for (const request of requests) {
    const result = await applyK8sResource(envelope, httpClient, config, kubeBearerToken, request);
    if (result.resultType === 'failed') return result.result;
  }

  return {
    resultType: 'completed',
    commandId: envelope.commandId,
    providerKind: K8S_PROVIDER_KIND,
    message: `Kubernetes RuntimeAgent deployment ${config.deploymentName} has been applied.`,
    outputSummary: `Applied Kubernetes Secret, Deployment, and Service for RuntimeAgent node ${envelope.nodeId}.`,
    remoteResourceId: `deployment/${config.namespace}/${config.deploymentName}`,
    ...(envelope.environment ? { managedResources: buildK8sManagedResourceResults(envelope, config, labels) } : {}),
  };
}

async function applyK8sResource(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  httpClient: RuntimeHttpClientPort,
  config: K8sBootstrapConfig,
  kubeBearerToken: string,
  request: K8sResourceRequest,
): Promise<{ readonly resultType: 'completed' } | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }> {
  const createResponse = await requestK8sApi(
    envelope,
    httpClient,
    config,
    kubeBearerToken,
    'POST',
    request.collectionPath,
    request.body,
    K8S_CONTENT_TYPE_JSON,
  );
  if (createResponse.resultType === 'completed') return { resultType: 'completed' };
  if (createResponse.status !== 409) return createResponse;

  const ownershipResult = await verifyK8sResourceOwnership(envelope, httpClient, config, kubeBearerToken, request.resourcePath, buildRuntimeAgentLabels(envelope, config));
  if (ownershipResult.resultType === 'failed') return ownershipResult;
  if (!ownershipResult.verified) {
    return {
      resultType: 'failed',
      result: failed(envelope, 'invalid-config', 'Kubernetes resource already exists but is not owned by this Remote Fleet environment.'),
    };
  }

  const patchResponse = await requestK8sApi(
    envelope,
    httpClient,
    config,
    kubeBearerToken,
    'PATCH',
    request.resourcePath,
    request.body,
    K8S_CONTENT_TYPE_MERGE_PATCH,
  );
  if (patchResponse.resultType === 'completed') return { resultType: 'completed' };
  return patchResponse;
}

async function deleteK8sRuntimeAgent(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  httpClient: RuntimeHttpClientPort,
  config: K8sBootstrapConfig,
  kubeBearerToken: string,
): Promise<RemoteFleetBootstrapCommandResult> {
  const labels = buildRuntimeAgentLabels(envelope, config);
  const resourcePaths = [
    `/api/v1/namespaces/${pathSegment(config.namespace)}/services/${pathSegment(config.serviceName)}`,
    `/apis/apps/v1/namespaces/${pathSegment(config.namespace)}/deployments/${pathSegment(config.deploymentName)}`,
    `/api/v1/namespaces/${pathSegment(config.namespace)}/secrets/${pathSegment(config.secretName)}`,
  ] as const;

  for (const resourcePath of resourcePaths) {
    const deleteResult = await deleteOwnedK8sResource(envelope, httpClient, config, kubeBearerToken, resourcePath, labels);
    if (deleteResult.resultType === 'failed') return deleteResult.result;
  }

  return {
    resultType: 'completed',
    commandId: envelope.commandId,
    providerKind: K8S_PROVIDER_KIND,
    message: `Kubernetes RuntimeAgent deployment ${config.deploymentName} has been deleted.`,
    outputSummary: `Deleted Kubernetes Service, Deployment, and Secret for RuntimeAgent node ${envelope.nodeId}.`,
    remoteResourceId: `deployment/${config.namespace}/${config.deploymentName}`,
  };
}

async function deleteOwnedK8sResource(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  httpClient: RuntimeHttpClientPort,
  config: K8sBootstrapConfig,
  kubeBearerToken: string,
  resourcePath: string,
  expectedLabels: Readonly<Record<string, string>>,
): Promise<{ readonly resultType: 'completed' } | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }> {
  const ownershipResult = await verifyK8sResourceOwnership(envelope, httpClient, config, kubeBearerToken, resourcePath, expectedLabels);
  if (ownershipResult.resultType === 'failed') return ownershipResult;
  if (!ownershipResult.found) return { resultType: 'completed' };
  if (!ownershipResult.verified) {
    return {
      resultType: 'failed',
      result: failed(envelope, 'invalid-config', 'Kubernetes resource is not owned by this Remote Fleet environment; refusing to delete it.'),
    };
  }

  const deleteResponse = await requestK8sApi(envelope, httpClient, config, kubeBearerToken, 'DELETE', resourcePath);
  if (deleteResponse.resultType === 'completed' || deleteResponse.status === 404) return { resultType: 'completed' };
  return deleteResponse;
}

async function verifyK8sResourceOwnership(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  httpClient: RuntimeHttpClientPort,
  config: K8sBootstrapConfig,
  kubeBearerToken: string,
  resourcePath: string,
  expectedLabels: Readonly<Record<string, string>>,
): Promise<
  | { readonly resultType: 'completed'; readonly found: boolean; readonly verified: boolean }
  | { readonly resultType: 'failed'; readonly status?: number; readonly result: RemoteFleetBootstrapCommandResult }
> {
  const getResponse = await requestK8sApi(envelope, httpClient, config, kubeBearerToken, 'GET', resourcePath);
  if (getResponse.resultType === 'failed') {
    if (getResponse.status === 404) return { resultType: 'completed', found: false, verified: false };
    return getResponse;
  }
  const labels = await readK8sResourceLabels(getResponse.response);
  return {
    resultType: 'completed',
    found: true,
    verified: verifyK8sManagedLabels(labels, expectedLabels),
  };
}

async function readK8sResourceLabels(response: RuntimeHttpResponse): Promise<Readonly<Record<string, string>>> {
  try {
    const body = await response.json() as { readonly metadata?: { readonly labels?: unknown } };
    const labels = body.metadata?.labels;
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {};
    const safeLabels: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels)) {
      if (typeof value === 'string') safeLabels[key] = value;
    }
    return safeLabels;
  } catch {
    return {};
  }
}

function verifyK8sManagedLabels(
  labels: Readonly<Record<string, string>>,
  expectedLabels: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expectedLabels).every(([key, value]) => labels[key] === value);
}

async function requestK8sApi(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  httpClient: RuntimeHttpClientPort,
  config: K8sBootstrapConfig,
  kubeBearerToken: string,
  method: string,
  path: string,
  body?: Readonly<Record<string, unknown>>,
  contentType?: string,
): Promise<
  | { readonly resultType: 'completed'; readonly response: RuntimeHttpResponse }
  | { readonly resultType: 'failed'; readonly status?: number; readonly result: RemoteFleetBootstrapCommandResult }
> {
  try {
    const response = await httpClient.request(buildK8sUrl(config.apiServerUrl, path), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${kubeBearerToken}`,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (response.ok) {
      return { resultType: 'completed', response };
    }

    return {
      resultType: 'failed',
      status: response.status,
      result: failedForK8sStatus(envelope, response.status),
    };
  } catch (error) {
    return {
      resultType: 'failed',
      result: failedForK8sRequestError(envelope, error),
    };
  }
}

function failedForK8sStatus(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  status: number,
): RemoteFleetBootstrapCommandResult {
  const reason: RemoteFleetBootstrapFailureReason = status === 401 || status === 403 ? 'auth' : 'remote-error';
  return failed(envelope, reason, `Kubernetes API request failed with status ${status}.`);
}

function failedForK8sRequestError(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  error: unknown,
): RemoteFleetBootstrapCommandResult {
  const errorName = error instanceof Error ? error.name : '';
  return failed(
    envelope,
    errorName === 'AbortError' ? 'timeout' : 'network',
    errorName === 'AbortError'
      ? 'Kubernetes API request timed out.'
      : 'Kubernetes API request failed before receiving a response.',
  );
}

function buildSecretRequest(
  config: K8sBootstrapConfig,
  secretName: string,
  labels: Readonly<Record<string, string>>,
  enrollmentToken: string,
): K8sResourceRequest {
  return {
    collectionPath: `/api/v1/namespaces/${pathSegment(config.namespace)}/secrets`,
    resourcePath: `/api/v1/namespaces/${pathSegment(config.namespace)}/secrets/${pathSegment(secretName)}`,
    body: {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        namespace: config.namespace,
        labels,
      },
      type: 'Opaque',
      stringData: {
        [ENROLLMENT_SECRET_KEY]: enrollmentToken,
      },
    },
  };
}

function buildDeploymentRequest(
  config: K8sBootstrapConfig,
  secretName: string,
  labels: Readonly<Record<string, string>>,
  envelope: RemoteFleetBootstrapCommandEnvelope,
): K8sResourceRequest {
  const env = [
    { name: 'MATCHACLAW_AGENT_ID', value: envelope.agentId },
    { name: 'MATCHACLAW_NODE_ID', value: envelope.nodeId },
    {
      name: 'MATCHACLAW_ENROLLMENT_TOKEN',
      valueFrom: {
        secretKeyRef: {
          name: secretName,
          key: ENROLLMENT_SECRET_KEY,
        },
      },
    },
    { name: 'MATCHACLAW_ENROLLMENT_EXPIRES_AT', value: envelope.enrollment!.expiresAt },
    ...(envelope.enrollment?.callbackUrl
      ? [{ name: 'MATCHACLAW_ENROLLMENT_CALLBACK_URL', value: envelope.enrollment.callbackUrl }]
      : []),
  ];

  return {
    collectionPath: `/apis/apps/v1/namespaces/${pathSegment(config.namespace)}/deployments`,
    resourcePath: `/apis/apps/v1/namespaces/${pathSegment(config.namespace)}/deployments/${pathSegment(config.deploymentName)}`,
    body: {
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        name: config.deploymentName,
        namespace: config.namespace,
        labels,
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: RUNTIME_AGENT_CONTAINER_NAME,
                image: config.image,
                ports: [
                  {
                    name: 'http',
                    containerPort: config.runtimeAgentPort,
                  },
                ],
                env,
              },
            ],
          },
        },
      },
    },
  };
}

function buildServiceRequest(
  config: K8sBootstrapConfig,
  labels: Readonly<Record<string, string>>,
): K8sResourceRequest {
  return {
    collectionPath: `/api/v1/namespaces/${pathSegment(config.namespace)}/services`,
    resourcePath: `/api/v1/namespaces/${pathSegment(config.namespace)}/services/${pathSegment(config.serviceName)}`,
    body: {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: config.serviceName,
        namespace: config.namespace,
        labels,
      },
      spec: {
        selector: labels,
        ports: [
          {
            name: 'http',
            port: config.runtimeAgentPort,
            targetPort: 'http',
          },
        ],
      },
    },
  };
}

function buildRuntimeAgentLabels(envelope: RemoteFleetBootstrapCommandEnvelope, config: K8sBootstrapConfig): Readonly<Record<string, string>> {
  const legacyLabels = {
    'app.kubernetes.io/name': 'matchaclaw-runtime-agent',
    'app.kubernetes.io/instance': config.deploymentName,
    'app.kubernetes.io/managed-by': 'matchaclaw',
    'matchaclaw.ai/node-id': config.sanitizedNodeId,
    'matchaclaw.ai/agent-id': config.sanitizedAgentId,
  };
  if (!envelope.environment) return legacyLabels;

  return {
    ...legacyLabels,
    [K8S_MANAGED_LABEL]: 'true',
    [K8S_CONNECTION_ID_LABEL]: envelope.connection?.id ?? envelope.environment.connectionId,
    [K8S_ENVIRONMENT_ID_LABEL]: envelope.environment.id,
    [K8S_NODE_ID_LABEL]: envelope.nodeId,
    [K8S_AGENT_ID_LABEL]: envelope.agentId,
  };
}

function buildK8sManagedResourceResults(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  config: K8sBootstrapConfig,
  labels: Readonly<Record<string, string>>,
): readonly RemoteFleetBootstrapManagedResourceResult[] {
  const namespace = config.namespace;
  const resourceId = `workload/${namespace}/${config.deploymentName}`;
  return [
    {
      providerKind: K8S_PROVIDER_KIND,
      resourceKind: 'k8s-workload',
      remoteResourceId: resourceId,
      remoteRefs: [
        { providerKind: K8S_PROVIDER_KIND, resourceKind: 'k8s-secret', remoteResourceId: `secret/${namespace}/${config.secretName}`, namespace, name: config.secretName },
        { providerKind: K8S_PROVIDER_KIND, resourceKind: 'k8s-deployment', remoteResourceId: `deployment/${namespace}/${config.deploymentName}`, namespace, name: config.deploymentName },
        { providerKind: K8S_PROVIDER_KIND, resourceKind: 'k8s-service', remoteResourceId: `service/${namespace}/${config.serviceName}`, namespace, name: config.serviceName },
      ],
      ownership: { reason: 'matcha-managed', evidence: { ...labels } },
      cleanupPolicy: { mode: 'delete-on-environment-delete' },
      displayName: `Kubernetes workload ${namespace}/${config.deploymentName}`,
      labels: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
    },
  ];
}

function namespacePath(namespace: string): string {
  return `/api/v1/namespaces/${pathSegment(namespace)}`;
}

function failureReasonForK8sConnectionProbeStatus(status: number): RemoteFleetConnectionProbeFailureReason {
  return status === 401 || status === 403 ? 'auth' : 'remote-error';
}

function failureReasonForK8sConnectionProbeRequestError(error: unknown): RemoteFleetConnectionProbeFailureReason {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError') ? 'timeout' : 'network';
}

function failedConnectionProbe(
  envelope: Pick<RemoteFleetConnectionProbeEnvelope, 'commandId' | 'providerKind'>,
  reason: RemoteFleetConnectionProbeFailureReason,
): RemoteFleetConnectionProbeResult {
  return {
    resultType: 'failed',
    commandId: envelope.commandId,
    providerKind: envelope.providerKind,
    reason,
  };
}

function failed(
  envelope: Pick<RemoteFleetBootstrapCommandEnvelope, 'commandId' | 'providerKind'>,
  reason: RemoteFleetBootstrapFailureReason,
  message: string,
): RemoteFleetBootstrapCommandResult {
  return {
    resultType: 'failed',
    commandId: envelope.commandId,
    providerKind: envelope.providerKind,
    reason,
    message,
  };
}
