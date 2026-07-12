import type { RuntimeHttpResponse } from '../common/runtime-ports';
import { redactRemoteFleetLogLine } from './remote-fleet-log-stream';
import { evaluateRemoteFleetSecretRefPolicy } from './remote-fleet-secret-policy';
import type {
  RemoteFleetBootstrapCommandEnvelope,
  RemoteFleetBootstrapCommandResult,
  RemoteFleetBootstrapFailureReason,
  RemoteFleetBootstrapManagedResourceResult,
  RemoteFleetBootstrapProvider,
  RemoteFleetBootstrapProviderContext,
  RemoteFleetConnectionProbeEnvelope,
  RemoteFleetConnectionProbeFailureReason,
  RemoteFleetConnectionProbeProvider,
  RemoteFleetConnectionProbeResult,
} from './remote-fleet-bootstrap';
import {
  REMOTE_FLEET_DEFAULT_DOCKER_ENVIRONMENT_IMAGE,
  buildDockerApiUrl,
  dockerApiPathSegment,
  readRemoteFleetDockerBootstrapProviderConfig,
  readRemoteFleetDockerConnectionProbeConfig,
  readRemoteFleetDockerDeleteEnvironmentProviderConfig,
  type RemoteFleetDockerConfigFailureReason,
  type RemoteFleetDockerBootstrapConfig,
  type RemoteFleetDockerBootstrapProviderConfig,
  type RemoteFleetDockerDeleteEnvironmentProviderConfig,
} from './remote-fleet-docker-target-config';

const DOCKER_API_REQUEST_TIMEOUT_MS = 15_000;
const DOCKER_IMAGE_PULL_TIMEOUT_MS = 600_000;
const DOCKER_ENVIRONMENT_SETUP_TIMEOUT_MS = 600_000;
const DOCKER_ENVIRONMENT_SETUP_OUTPUT_TAIL_MAX_CHARS = 12_000;
const DOCKER_ENVIRONMENT_SETUP_POLL_INTERVAL_MS = 1_000;
const DOCKER_ENVIRONMENT_SETUP_MAX_POLLS = Math.ceil(DOCKER_ENVIRONMENT_SETUP_TIMEOUT_MS / DOCKER_ENVIRONMENT_SETUP_POLL_INTERVAL_MS);
const DOCKER_ENVIRONMENT_IMAGE = REMOTE_FLEET_DEFAULT_DOCKER_ENVIRONMENT_IMAGE;
const DOCKER_ENVIRONMENT_WORKDIR = '/workspace';
const DOCKER_ENVIRONMENT_ENTRYPOINT = ['/bin/sh', '-lc'] as const;
const DOCKER_ENVIRONMENT_KEEPALIVE_SCRIPT = `mkdir -p ${DOCKER_ENVIRONMENT_WORKDIR} && trap "exit 0" TERM INT; while :; do sleep 2147483647 & wait $!; done`;
const DOCKER_ENVIRONMENT_APT_OPTIONS = '-o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30';
const DOCKER_ENVIRONMENT_APT_PACKAGES = 'bash ca-certificates curl git openssh-client procps';
const DOCKER_ENVIRONMENT_APT_SOURCE_CANDIDATES = [
  [
    'deb http://mirrors.tuna.tsinghua.edu.cn/debian bookworm main',
    'deb http://mirrors.tuna.tsinghua.edu.cn/debian bookworm-updates main',
    'deb http://mirrors.tuna.tsinghua.edu.cn/debian-security bookworm-security main',
  ],
  [
    'deb http://mirrors.ustc.edu.cn/debian bookworm main',
    'deb http://mirrors.ustc.edu.cn/debian bookworm-updates main',
    'deb http://mirrors.ustc.edu.cn/debian-security bookworm-security main',
  ],
  [
    'deb http://mirrors.aliyun.com/debian bookworm main',
    'deb http://mirrors.aliyun.com/debian bookworm-updates main',
    'deb http://mirrors.aliyun.com/debian-security bookworm-security main',
  ],
  [
    'deb http://deb.debian.org/debian bookworm main',
    'deb http://deb.debian.org/debian bookworm-updates main',
    'deb http://deb.debian.org/debian-security bookworm-security main',
  ],
] as const;
const DOCKER_ENVIRONMENT_APT_SOURCE_ARGS = DOCKER_ENVIRONMENT_APT_SOURCE_CANDIDATES
  .map((sources) => shellSingleQuote(`${sources.join('\n')}\n`))
  .join(' ');

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
const DOCKER_ENVIRONMENT_SETUP_COMMAND = `set -e; mkdir -p ${DOCKER_ENVIRONMENT_WORKDIR}; if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt_setup_ok=0; apt_setup_status=1; for apt_sources in ${DOCKER_ENVIRONMENT_APT_SOURCE_ARGS}; do printf '%s\n' "$apt_sources" > /etc/apt/sources.list; rm -f /etc/apt/sources.list.d/debian.sources; if apt-get ${DOCKER_ENVIRONMENT_APT_OPTIONS} update; then if apt-get ${DOCKER_ENVIRONMENT_APT_OPTIONS} install -y --no-install-recommends ${DOCKER_ENVIRONMENT_APT_PACKAGES}; then apt_setup_ok=1; break; else apt_setup_status=$?; fi; else apt_setup_status=$?; fi; apt-get clean; rm -rf /var/lib/apt/lists/*; done; if [ "$apt_setup_ok" != "1" ]; then exit "$apt_setup_status"; fi; rm -rf /var/lib/apt/lists/*; fi`;
const DOCKER_MANAGED_LABEL = 'com.matchaclaw.remote-fleet.managed';
const DOCKER_CONNECTION_ID_LABEL = 'com.matchaclaw.remote-fleet.connection-id';
const DOCKER_ENVIRONMENT_ID_LABEL = 'com.matchaclaw.remote-fleet.environment-id';
const DOCKER_NODE_ID_LABEL = 'com.matchaclaw.remote-fleet.node-id';
const DOCKER_AGENT_ID_LABEL = 'com.matchaclaw.remote-fleet.agent-id';

type DockerApiConfig = Pick<RemoteFleetDockerBootstrapProviderConfig, 'endpointUrl' | 'dockerBearerTokenSecretRef'>;

type DockerBearerTokenResult =
  | { readonly resultType: 'not-configured' }
  | { readonly resultType: 'resolved'; readonly token: string }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult };

type DockerConnectionProbeBearerTokenResult =
  | { readonly resultType: 'not-configured' }
  | { readonly resultType: 'resolved'; readonly token: string }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetConnectionProbeResult };

interface DockerIdResponseBody {
  readonly Id?: unknown;
}

interface DockerExecInspectResponseBody {
  readonly ExitCode?: unknown;
}

interface DockerContainerInspectResponseBody {
  readonly Config?: {
    readonly Labels?: unknown;
  };
}

interface DockerExecCompletion {
  readonly exitCode: number;
  readonly output: string;
}

interface DockerImageCandidate {
  readonly image: string;
  readonly query: Readonly<Record<string, string>>;
}

type DockerImagePullStreamReadResult =
  | { readonly resultType: 'completed'; readonly errorMessage?: string }
  | { readonly resultType: 'failed'; readonly reason: RemoteFleetBootstrapFailureReason; readonly message: string };

export function createRemoteFleetDockerBootstrapProvider(): RemoteFleetBootstrapProvider & RemoteFleetConnectionProbeProvider {
  return {
    providerKind: 'docker',
    async dispatchCommand(envelope, context) {
      return await dispatchDockerBootstrapCommand(envelope, context);
    },
    async probeConnection(envelope, context) {
      return await probeDockerConnection(envelope, context);
    },
  };
}

async function probeDockerConnection(
  envelope: RemoteFleetConnectionProbeEnvelope,
  context: RemoteFleetBootstrapProviderContext,
): Promise<RemoteFleetConnectionProbeResult> {
  if (envelope.providerKind !== 'docker' || envelope.connection.connectionKind !== 'container') {
    return failedConnectionProbe(envelope, 'unsupported');
  }
  if (!context.httpClient) {
    return failedConnectionProbe(envelope, 'unavailable');
  }

  const configResult = readRemoteFleetDockerConnectionProbeConfig({
    connectionPublicConfig: envelope.connection.publicConfig,
    connectionEndpointUrl: envelope.connection.endpointUrl,
    connectionSecretRefs: envelope.connection.secretRefs,
  });
  if (configResult.resultType === 'invalid') {
    return failedConnectionProbe(envelope, connectionProbeFailureReasonForDockerConfigFailure(configResult.reason));
  }

  const bearerTokenResult = await readDockerConnectionProbeBearerToken(envelope, context, configResult.config);
  if (bearerTokenResult.resultType === 'failed') return bearerTokenResult.result;
  const bearerToken = bearerTokenResult.resultType === 'resolved' ? bearerTokenResult.token : undefined;

  const responseResult = await requestDockerConnectionProbeApi(envelope, context, configResult.config, '/_ping', {
    method: 'GET',
    bearerToken,
  });
  if (responseResult.resultType === 'failed') return responseResult.result;

  const response = responseResult.response;
  if (response.status !== 200 || !response.ok) {
    return failedConnectionProbe(envelope, failureReasonForDockerConnectionProbeStatus(response.status));
  }
  const text = await safeReadResponseText(response);
  return text.trim() === 'OK'
    ? { resultType: 'completed', commandId: envelope.commandId, providerKind: 'docker' }
    : failedConnectionProbe(envelope, 'remote-error');
}

async function dispatchDockerBootstrapCommand(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
): Promise<RemoteFleetBootstrapCommandResult> {
  if (envelope.providerKind !== 'docker' || envelope.node.targetKind !== 'container') {
    return failed(envelope, 'unsupported-target', 'Docker bootstrap provider only supports container Remote Fleet nodes.');
  }

  if (!context.httpClient) {
    return failed(envelope, 'unavailable', 'Docker bootstrap provider requires a RuntimeHttpClientPort.');
  }

  switch (envelope.commandName) {
    case 'probe-node':
    case 'install-agent':
    case 'deploy-environment': {
      if (envelope.commandName === 'deploy-environment' && !envelope.environment) {
        return failed(envelope, 'invalid-config', 'Docker deploy-environment requires a Remote Fleet environment.');
      }

      const configResult = readRemoteFleetDockerBootstrapProviderConfig({
        connectionPublicConfig: envelope.connection?.publicConfig,
        connectionEndpointUrl: envelope.connection?.endpointUrl,
        connectionSecretRefs: envelope.connection?.secretRefs,
        environmentPublicConfig: envelope.commandName === 'deploy-environment' ? envelope.environment?.publicConfig : undefined,
        environmentSecretRefs: envelope.commandName === 'deploy-environment' ? envelope.environment?.secretRefs : undefined,
        nodePublicConfig: envelope.node.publicConfig,
        nodeSecretRefs: envelope.node.secretRefs,
        nodeId: envelope.node.id,
      });
      if (configResult.resultType === 'invalid') return failed(envelope, bootstrapFailureReasonForDockerConfigFailure(configResult.reason), configResult.message);

      const bearerTokenResult = await readDockerBearerToken(envelope, context, configResult.config);
      if (bearerTokenResult.resultType === 'failed') return bearerTokenResult.result;

      const bearerToken = bearerTokenResult.resultType === 'resolved' ? bearerTokenResult.token : undefined;
      return envelope.commandName === 'probe-node'
        ? await probeDockerNode(envelope, context, configResult.config, bearerToken)
        : await installDockerEnvironment(envelope, context, configResult.config, bearerToken);
    }
    case 'delete-environment': {
      if (!envelope.environment) return failed(envelope, 'invalid-config', 'Docker delete-environment requires a Remote Fleet environment.');

      const configResult = readRemoteFleetDockerDeleteEnvironmentProviderConfig({
        connectionPublicConfig: envelope.connection?.publicConfig,
        connectionEndpointUrl: envelope.connection?.endpointUrl,
        connectionSecretRefs: envelope.connection?.secretRefs,
        environmentPublicConfig: envelope.environment?.publicConfig,
        environmentSecretRefs: envelope.environment?.secretRefs,
        managedResourceRemoteResourceId: envelope.managedResource?.remoteResourceId,
        nodePublicConfig: envelope.node.publicConfig,
        nodeSecretRefs: envelope.node.secretRefs,
        nodeId: envelope.node.id,
      });
      if (configResult.resultType === 'invalid') return failed(envelope, bootstrapFailureReasonForDockerConfigFailure(configResult.reason), configResult.message);

      const bearerTokenResult = await readDockerBearerToken(envelope, context, configResult.config);
      if (bearerTokenResult.resultType === 'failed') return bearerTokenResult.result;

      const bearerToken = bearerTokenResult.resultType === 'resolved' ? bearerTokenResult.token : undefined;
      return await deleteDockerEnvironment(envelope, context, configResult.config, bearerToken);
    }
  }
}

async function probeDockerNode(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: DockerApiConfig,
  bearerToken: string | undefined,
): Promise<RemoteFleetBootstrapCommandResult> {
  const responseResult = await requestDockerApi(envelope, context, config, '/_ping', {
    method: 'GET',
    bearerToken,
  });
  if (responseResult.resultType === 'failed') return responseResult.result;

  const response = responseResult.response;
  if (response.status !== 200 || !response.ok) {
    return failed(
      envelope,
      failureReasonForDockerStatus(response.status),
      `Docker Engine /_ping returned HTTP ${response.status}.`,
    );
  }

  const text = await safeReadResponseText(response);
  if (text.trim() !== 'OK') {
    return failed(envelope, 'remote-error', 'Docker Engine /_ping did not return OK.');
  }

  return {
    resultType: 'completed',
    commandId: envelope.commandId,
    providerKind: 'docker',
    message: 'Docker Engine is reachable.',
    outputSummary: 'Docker Engine /_ping returned 200 OK.',
  };
}

async function installDockerEnvironment(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: RemoteFleetDockerBootstrapConfig,
  bearerToken: string | undefined,
): Promise<RemoteFleetBootstrapCommandResult> {
  const imageResolution = await resolveDockerImage(envelope, context, config, bearerToken);
  if (imageResolution.resultType === 'failed') return imageResolution.result;

  const resolvedImage = imageResolution.image;
  const managedLabels = buildDockerManagedLabels(envelope);
  const createBody = buildCreateContainerBody(managedLabels, resolvedImage);
  const createResponseResult = await createDockerEnvironmentContainer(envelope, context, config, bearerToken, createBody);
  if (createResponseResult.resultType === 'failed') return createResponseResult.result;

  const createResponse = createResponseResult.response;
  if (!isSuccessfulResponse(createResponse) && createResponse.status !== 409) {
    return failed(
      envelope,
      failureReasonForDockerStatus(createResponse.status),
      `Docker Engine returned HTTP ${createResponse.status} while creating the Docker environment container.`,
    );
  }

  const containerRef = createResponse.status === 409
    ? config.containerName
    : await readDockerId(createResponse) ?? config.containerName;
  if (createResponse.status === 409) {
    const ownershipResult = await inspectDockerContainerOwnership(envelope, context, config, bearerToken, containerRef, managedLabels);
    if (ownershipResult.resultType === 'failed') return ownershipResult.result;
    if (!ownershipResult.verified) {
      return failed(envelope, 'invalid-config', `Docker container ${containerRef} already exists but is not owned by this Remote Fleet environment.`);
    }
  }
  const startResponseResult = await requestDockerApi(envelope, context, config, `/containers/${dockerApiPathSegment(containerRef)}/start`, {
    method: 'POST',
    bearerToken,
  });
  if (startResponseResult.resultType === 'failed') return startResponseResult.result;

  const startResponse = startResponseResult.response;
  if (!isSuccessfulResponse(startResponse) && startResponse.status !== 304) {
    return failed(
      envelope,
      failureReasonForDockerStatus(startResponse.status),
      `Docker Engine returned HTTP ${startResponse.status} while starting the Docker environment container.`,
    );
  }

  const setupResult = await setupDockerEnvironment(envelope, context, config, bearerToken, containerRef, resolvedImage);
  if (setupResult.resultType === 'failed') return setupResult.result;

  return {
    resultType: 'completed',
    commandId: envelope.commandId,
    providerKind: 'docker',
    message: 'Docker environment container started.',
    outputSummary: `Docker container ${config.containerName} is running image ${resolvedImage} and is ready for terminal sessions.`,
    remoteResourceId: containerRef,
    managedResources: [buildDockerContainerManagedResourceResult(envelope, containerRef, managedLabels)],
  };
}

async function deleteDockerEnvironment(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: RemoteFleetDockerDeleteEnvironmentProviderConfig,
  bearerToken: string | undefined,
): Promise<RemoteFleetBootstrapCommandResult> {
  const expectedLabels = buildDockerManagedLabels(envelope);
  const ownershipResult = await inspectDockerContainerOwnership(envelope, context, config, bearerToken, config.containerRef, expectedLabels);
  if (ownershipResult.resultType === 'failed') return ownershipResult.result;
  if (!ownershipResult.found) {
    return {
      resultType: 'completed',
      commandId: envelope.commandId,
      providerKind: 'docker',
      message: 'Docker environment container is already absent.',
      outputSummary: `Docker container ${config.containerRef} was not found; delete-environment is already complete.`,
      remoteResourceId: config.containerRef,
    };
  }
  if (!ownershipResult.verified) {
    return failed(envelope, 'invalid-config', `Docker container ${config.containerRef} is not owned by this Remote Fleet environment; refusing to delete it.`);
  }

  const stopResponseResult = await requestDockerApi(envelope, context, config, `/containers/${dockerApiPathSegment(config.containerRef)}/stop`, {
    method: 'POST',
    bearerToken,
  });
  if (stopResponseResult.resultType === 'failed') return stopResponseResult.result;
  const stopResponse = stopResponseResult.response;
  if (!isSuccessfulResponse(stopResponse) && stopResponse.status !== 304 && stopResponse.status !== 404) {
    return failed(
      envelope,
      failureReasonForDockerStatus(stopResponse.status),
      `Docker Engine returned HTTP ${stopResponse.status} while stopping the Docker environment container.`,
    );
  }

  const removeResponseResult = await requestDockerApi(envelope, context, config, `/containers/${dockerApiPathSegment(config.containerRef)}`, {
    method: 'DELETE',
    bearerToken,
    query: { force: 'true' },
  });
  if (removeResponseResult.resultType === 'failed') return removeResponseResult.result;
  const removeResponse = removeResponseResult.response;
  if (!isSuccessfulResponse(removeResponse) && removeResponse.status !== 404) {
    return failed(
      envelope,
      failureReasonForDockerStatus(removeResponse.status),
      `Docker Engine returned HTTP ${removeResponse.status} while removing the Docker environment container.`,
    );
  }

  return {
    resultType: 'completed',
    commandId: envelope.commandId,
    providerKind: 'docker',
    message: 'Docker environment container deleted.',
    outputSummary: `Docker container ${config.containerRef} was stopped and removed.`,
    remoteResourceId: config.containerRef,
  };
}

async function createDockerEnvironmentContainer(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: RemoteFleetDockerBootstrapConfig,
  bearerToken: string | undefined,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly resultType: 'response'; readonly response: RuntimeHttpResponse } | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }> {
  return await requestDockerApi(envelope, context, config, '/containers/create', {
    method: 'POST',
    bearerToken,
    query: { name: config.containerName },
    body,
  });
}

async function resolveDockerImage(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: RemoteFleetDockerBootstrapConfig,
  bearerToken: string | undefined,
): Promise<{ readonly resultType: 'completed'; readonly image: string } | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }> {
  const pullCandidates = readDockerImageCandidateReferences(config.imageCandidates);
  if (pullCandidates.resultType === 'invalid') {
    return { resultType: 'failed', result: failed(envelope, 'invalid-config', pullCandidates.message) };
  }

  for (const candidate of pullCandidates.candidates) {
    const inspectResult = await inspectDockerImage(envelope, context, config, bearerToken, candidate.image);
    if (inspectResult.resultType === 'failed') return inspectResult;
    if (inspectResult.found) return { resultType: 'completed', image: candidate.image };
  }

  return await pullFirstAvailableDockerImage(envelope, context, config, bearerToken, pullCandidates.candidates);
}

async function inspectDockerImage(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: DockerApiConfig,
  bearerToken: string | undefined,
  image: string,
): Promise<{ readonly resultType: 'completed'; readonly found: boolean } | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }> {
  const responseResult = await requestDockerApi(envelope, context, config, `/images/${dockerApiPathSegment(image)}/json`, {
    method: 'GET',
    bearerToken,
  });
  if (responseResult.resultType === 'failed') return responseResult;

  const response = responseResult.response;
  if (response.status === 404) return { resultType: 'completed', found: false };
  return isSuccessfulResponse(response)
    ? { resultType: 'completed', found: true }
    : {
        resultType: 'failed',
        result: failed(
          envelope,
          failureReasonForDockerStatus(response.status),
          `Docker Engine returned HTTP ${response.status} while inspecting image ${image}.`,
        ),
      };
}

async function inspectDockerContainerOwnership(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: DockerApiConfig,
  bearerToken: string | undefined,
  containerRef: string,
  expectedLabels: Readonly<Record<string, string>>,
): Promise<
  | { readonly resultType: 'completed'; readonly found: boolean; readonly verified: boolean }
  | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }
> {
  const inspectResult = await requestDockerApi(envelope, context, config, `/containers/${dockerApiPathSegment(containerRef)}/json`, {
    method: 'GET',
    bearerToken,
  });
  if (inspectResult.resultType === 'failed') return inspectResult;

  const response = inspectResult.response;
  if (response.status === 404) return { resultType: 'completed', found: false, verified: false };
  if (!isSuccessfulResponse(response)) {
    return {
      resultType: 'failed',
      result: failed(
        envelope,
        failureReasonForDockerStatus(response.status),
        `Docker Engine returned HTTP ${response.status} while inspecting Docker container ${containerRef}.`,
      ),
    };
  }

  const labels = await readDockerContainerLabels(response);
  return {
    resultType: 'completed',
    found: true,
    verified: verifyDockerManagedLabels(labels, expectedLabels),
  };
}

async function readDockerContainerLabels(response: RuntimeHttpResponse): Promise<Readonly<Record<string, string>>> {
  try {
    const body = await response.json() as DockerContainerInspectResponseBody;
    const labels = body.Config?.Labels;
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

function verifyDockerManagedLabels(
  labels: Readonly<Record<string, string>>,
  expectedLabels: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expectedLabels).every(([key, value]) => labels[key] === value);
}

async function requestDockerConnectionProbeApi(
  envelope: RemoteFleetConnectionProbeEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: DockerApiConfig,
  inputPath: string,
  input: {
    readonly method: string;
    readonly bearerToken?: string;
  },
): Promise<{ readonly resultType: 'response'; readonly response: RuntimeHttpResponse } | { readonly resultType: 'failed'; readonly result: RemoteFleetConnectionProbeResult }> {
  const url = buildDockerApiUrl(config.endpointUrl, inputPath);
  const headers: Record<string, string> = {};
  if (input.bearerToken) headers.authorization = `Bearer ${input.bearerToken}`;

  try {
    const response = await context.httpClient!.request(url, {
      method: input.method,
      headers,
      signal: AbortSignal.timeout(DOCKER_API_REQUEST_TIMEOUT_MS),
    });
    return { resultType: 'response', response };
  } catch (error) {
    return {
      resultType: 'failed',
      result: failedConnectionProbe(envelope, failureReasonForDockerConnectionProbeRequestError(error)),
    };
  }
}

async function requestDockerApi(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: DockerApiConfig,
  inputPath: string,
  input: {
    readonly method: string;
    readonly bearerToken?: string;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly timeoutMs?: number;
  },
): Promise<{ readonly resultType: 'response'; readonly response: RuntimeHttpResponse } | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }> {
  const url = buildDockerApiUrl(config.endpointUrl, inputPath, input.query);
  const headers: Record<string, string> = {};
  if (input.body !== undefined) headers['content-type'] = 'application/json';
  if (input.bearerToken) headers.authorization = `Bearer ${input.bearerToken}`;

  try {
    const response = await context.httpClient!.request(url, {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      signal: AbortSignal.timeout(input.timeoutMs ?? DOCKER_API_REQUEST_TIMEOUT_MS),
    });
    return { resultType: 'response', response };
  } catch (error) {
    return {
      resultType: 'failed',
      result: failed(
        envelope,
        failureReasonForRequestError(error),
        'Docker Engine HTTP request failed.',
      ),
    };
  }
}

async function pullFirstAvailableDockerImage(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: RemoteFleetDockerBootstrapConfig,
  bearerToken: string | undefined,
  candidates: readonly DockerImageCandidate[] | undefined = undefined,
): Promise<{ readonly resultType: 'completed'; readonly image: string } | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }> {
  let pullCandidates: readonly DockerImageCandidate[];
  if (candidates) {
    pullCandidates = candidates;
  } else {
    const candidateRead = readDockerImageCandidateReferences(config.imageCandidates);
    if (candidateRead.resultType === 'invalid') {
      return { resultType: 'failed', result: failed(envelope, 'invalid-config', candidateRead.message) };
    }
    pullCandidates = candidateRead.candidates;
  }
  const pullFailures: string[] = [];
  let lastFailureReason: RemoteFleetBootstrapFailureReason | undefined;
  let lastStatus: number | undefined;
  for (const candidate of pullCandidates) {
    const responseResult = await requestDockerApi(envelope, context, config, '/images/create', {
      method: 'POST',
      bearerToken,
      query: candidate.query,
      timeoutMs: DOCKER_IMAGE_PULL_TIMEOUT_MS,
    });
    if (responseResult.resultType === 'failed') return responseResult;

    const response = responseResult.response;
    if (isSuccessfulResponse(response)) {
      const streamResult = await readDockerImagePullStream(response);
      if (streamResult.resultType === 'failed') {
        pullFailures.push(formatDockerImagePullFailure(candidate.image, streamResult.message, envelope, bearerToken));
        lastFailureReason = streamResult.reason;
        continue;
      }
      if (streamResult.errorMessage) {
        pullFailures.push(formatDockerImagePullFailure(candidate.image, streamResult.errorMessage, envelope, bearerToken));
        continue;
      }

      const pulledImageInspectResult = await inspectDockerImage(envelope, context, config, bearerToken, candidate.image);
      if (pulledImageInspectResult.resultType === 'failed') return pulledImageInspectResult;
      if (pulledImageInspectResult.found) return { resultType: 'completed', image: candidate.image };

      pullFailures.push(formatDockerImagePullFailure(
        candidate.image,
        'Docker Engine did not report the image as available after pull.',
        envelope,
        bearerToken,
      ));
      lastFailureReason = 'remote-error';
      continue;
    }

    lastStatus = response.status;
    lastFailureReason = failureReasonForDockerStatus(response.status);
    pullFailures.push(formatDockerImagePullFailure(
      candidate.image,
      `Docker Engine returned HTTP ${response.status} while pulling image candidate.`,
      envelope,
      bearerToken,
    ));
    if (response.status === 401 || response.status === 403) {
      return {
        resultType: 'failed',
        result: failed(
          envelope,
          failureReasonForDockerStatus(response.status),
          `Docker Engine returned HTTP ${response.status} while pulling image candidate ${candidate.image}. Check Docker registry credentials or image access.`,
        ),
      };
    }
  }

  return {
    resultType: 'failed',
    result: failed(
      envelope,
      lastFailureReason ?? (lastStatus ? failureReasonForDockerStatus(lastStatus) : 'remote-error'),
      `Docker Engine could not find or pull any configured image candidate. Tried ${pullCandidates.length} candidate(s); verify publicConfig.docker.imageCandidates or registry connectivity.${summarizeDockerImagePullFailures(pullFailures)}`,
    ),
  };
}

async function readDockerImagePullStream(response: RuntimeHttpResponse): Promise<DockerImagePullStreamReadResult> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return {
      resultType: 'failed',
      reason: failureReasonForRequestError(error),
      message: `Docker image pull stream could not be read completely: ${safeErrorName(error)}.`,
    };
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const errorMessage = readDockerImagePullStreamLineError(trimmedLine);
    if (errorMessage) return { resultType: 'completed', errorMessage };
  }
  return { resultType: 'completed' };
}

function readDockerImagePullStreamLineError(line: string): string | undefined {
  try {
    const body = JSON.parse(line) as unknown;
    if (!body || typeof body !== 'object') return undefined;

    const record = body as Record<string, unknown>;
    const errorDetail = record.errorDetail;
    if (errorDetail && typeof errorDetail === 'object') {
      const message = (errorDetail as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim().length > 0) return message.trim();
    }
    if (typeof errorDetail === 'string' && errorDetail.trim().length > 0) return errorDetail.trim();
    if (typeof record.error === 'string' && record.error.trim().length > 0) return record.error.trim();
    return undefined;
  } catch {
    return undefined;
  }
}

function formatDockerImagePullFailure(
  image: string,
  message: string,
  envelope: RemoteFleetBootstrapCommandEnvelope,
  bearerToken: string | undefined,
): string {
  return `${image}: ${redactDockerImagePullMessage(message, envelope, bearerToken)}`;
}

function summarizeDockerImagePullFailures(failures: readonly string[]): string {
  if (failures.length === 0) return '';
  return ` Last pull failure(s): ${failures.join('; ')}`;
}

function redactDockerImagePullMessage(
  message: string,
  envelope: RemoteFleetBootstrapCommandEnvelope,
  bearerToken: string | undefined,
): string {
  return redactDockerBootstrapDiagnostic(message, envelope, bearerToken);
}

function redactDockerBootstrapDiagnostic(
  message: string,
  envelope: RemoteFleetBootstrapCommandEnvelope,
  bearerToken: string | undefined,
): string {
  let redactedMessage = message;
  const sensitiveValues = [bearerToken, envelope.enrollment?.token].filter((value): value is string => Boolean(value));
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 0) redactedMessage = redactedMessage.split(sensitiveValue).join('[REDACTED]');
  }
  return redactRemoteFleetLogLine(redactedMessage);
}

async function setupDockerEnvironment(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: RemoteFleetDockerBootstrapConfig,
  bearerToken: string | undefined,
  containerRef: string,
  resolvedImage: string,
): Promise<{ readonly resultType: 'completed' } | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }> {
  if (!shouldRunDebianEnvironmentSetup(config, resolvedImage)) return { resultType: 'completed' };

  const createExecResult = await requestDockerApi(envelope, context, config, `/containers/${dockerApiPathSegment(containerRef)}/exec`, {
    method: 'POST',
    bearerToken,
    body: {
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ['/bin/sh', '-lc', DOCKER_ENVIRONMENT_SETUP_COMMAND],
    },
  });
  if (createExecResult.resultType === 'failed') return createExecResult;
  if (!isSuccessfulResponse(createExecResult.response)) {
    return {
      resultType: 'failed',
      result: failed(
        envelope,
        failureReasonForDockerStatus(createExecResult.response.status),
        `Docker Engine returned HTTP ${createExecResult.response.status} while creating Docker environment setup exec.`,
      ),
    };
  }

  const execId = await readDockerId(createExecResult.response);
  if (!execId) {
    return { resultType: 'failed', result: failed(envelope, 'remote-error', 'Docker Engine setup exec response did not include an exec id.') };
  }

  const completionResult = await runDockerSetupExec(envelope, context, config, bearerToken, execId);
  if (completionResult.resultType === 'failed') return completionResult;
  if (completionResult.completion.exitCode !== 0) {
    return {
      resultType: 'failed',
      result: failed(
        envelope,
        'remote-error',
        `Docker environment setup exited with code ${completionResult.completion.exitCode}.${formatDockerSetupOutputSummary(completionResult.completion.output, envelope, bearerToken)}`,
      ),
    };
  }

  return { resultType: 'completed' };
}

async function readDockerConnectionProbeBearerToken(
  envelope: RemoteFleetConnectionProbeEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: DockerApiConfig,
): Promise<DockerConnectionProbeBearerTokenResult> {
  if (!config.dockerBearerTokenSecretRef) {
    return { resultType: 'not-configured' };
  }

  const secretRefPolicy = evaluateRemoteFleetSecretRefPolicy(config.dockerBearerTokenSecretRef);
  if (secretRefPolicy.decision !== 'allowed') {
    return { resultType: 'failed', result: failedConnectionProbe(envelope, 'auth') };
  }

  const readSecretRef = context.secrets.readSecretRef;
  if (!readSecretRef) {
    return { resultType: 'failed', result: failedConnectionProbe(envelope, 'unavailable') };
  }

  const secretResult = await readSecretRef({
    kind: 'secret-ref',
    ref: config.dockerBearerTokenSecretRef,
  });
  switch (secretResult.resultType) {
    case 'resolved':
      return { resultType: 'resolved', token: secretResult.plaintextSecretValue };
    case 'missing':
      return { resultType: 'failed', result: failedConnectionProbe(envelope, 'missing-secret') };
    case 'accessDenied':
      return { resultType: 'failed', result: failedConnectionProbe(envelope, 'auth') };
    case 'unavailable':
      return { resultType: 'failed', result: failedConnectionProbe(envelope, 'unavailable') };
  }
}

async function readDockerBearerToken(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: DockerApiConfig,
): Promise<DockerBearerTokenResult> {
  if (!config.dockerBearerTokenSecretRef) {
    return { resultType: 'not-configured' };
  }

  const secretRefPolicy = evaluateRemoteFleetSecretRefPolicy(config.dockerBearerTokenSecretRef);
  if (secretRefPolicy.decision !== 'allowed') {
    return { resultType: 'failed', result: failed(envelope, 'auth', 'Docker bearer token secretRef is not allowed by Remote Fleet secret policy.') };
  }

  const readSecretRef = context.secrets.readSecretRef;
  if (!readSecretRef) {
    return { resultType: 'failed', result: failed(envelope, 'unavailable', 'Docker bearer token secret resolver is unavailable.') };
  }

  const secretResult = await readSecretRef({
    kind: 'secret-ref',
    ref: config.dockerBearerTokenSecretRef,
  });
  switch (secretResult.resultType) {
    case 'resolved':
      return { resultType: 'resolved', token: secretResult.plaintextSecretValue };
    case 'missing':
      return { resultType: 'failed', result: failed(envelope, 'missing-secret', 'Docker bearer token secretRef is missing.') };
    case 'accessDenied':
      return { resultType: 'failed', result: failed(envelope, 'auth', 'Docker bearer token secretRef cannot be accessed.') };
    case 'unavailable':
      return { resultType: 'failed', result: failed(envelope, 'unavailable', 'Docker bearer token secret resolver is unavailable.') };
  }
}

function shouldRunDebianEnvironmentSetup(config: RemoteFleetDockerBootstrapConfig, resolvedImage: string): boolean {
  return config.image === DOCKER_ENVIRONMENT_IMAGE
    || resolvedImage.endsWith('/debian:bookworm-slim')
    || resolvedImage === DOCKER_ENVIRONMENT_IMAGE;
}

function buildCreateContainerBody(
  labels: Readonly<Record<string, string>>,
  image: string,
): Readonly<Record<string, unknown>> {
  return {
    Image: image,
    Entrypoint: DOCKER_ENVIRONMENT_ENTRYPOINT,
    Cmd: [DOCKER_ENVIRONMENT_KEEPALIVE_SCRIPT],
    WorkingDir: DOCKER_ENVIRONMENT_WORKDIR,
    Labels: labels,
  };
}

function buildDockerManagedLabels(envelope: RemoteFleetBootstrapCommandEnvelope): Readonly<Record<string, string>> {
  const legacyLabels = {
    [DOCKER_MANAGED_LABEL]: 'true',
    [DOCKER_NODE_ID_LABEL]: envelope.nodeId,
    [DOCKER_AGENT_ID_LABEL]: envelope.agentId,
  };
  if (!envelope.environment) return legacyLabels;

  return {
    ...legacyLabels,
    [DOCKER_CONNECTION_ID_LABEL]: envelope.connection?.id ?? envelope.environment.connectionId,
    [DOCKER_ENVIRONMENT_ID_LABEL]: envelope.environment.id,
  };
}

function buildDockerContainerManagedResourceResult(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  containerRef: string,
  labels: Readonly<Record<string, string>>,
): RemoteFleetBootstrapManagedResourceResult {
  return {
    providerKind: 'docker',
    resourceKind: 'docker-container',
    remoteResourceId: containerRef,
    remoteRefs: [
      {
        providerKind: 'docker',
        resourceKind: 'docker-container',
        remoteResourceId: containerRef,
        name: containerRef,
      },
    ],
    ownership: { reason: 'matcha-managed', evidence: { ...labels } },
    cleanupPolicy: { mode: 'delete-on-environment-delete' },
    displayName: `Docker container ${containerRef}`,
    labels: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
  };
}

function isSuccessfulResponse(response: RuntimeHttpResponse): boolean {
  return response.ok && response.status >= 200 && response.status < 300;
}

async function runDockerSetupExec(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: DockerApiConfig,
  bearerToken: string | undefined,
  execId: string,
): Promise<{ readonly resultType: 'completed'; readonly completion: DockerExecCompletion } | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }> {
  const startExecResult = await requestDockerApi(envelope, context, config, `/exec/${dockerApiPathSegment(execId)}/start`, {
    method: 'POST',
    bearerToken,
    body: { Detach: false, Tty: false },
    timeoutMs: DOCKER_ENVIRONMENT_SETUP_TIMEOUT_MS,
  });
  if (startExecResult.resultType === 'failed') return startExecResult;
  if (!isSuccessfulResponse(startExecResult.response)) {
    return {
      resultType: 'failed',
      result: failed(
        envelope,
        failureReasonForDockerStatus(startExecResult.response.status),
        `Docker Engine returned HTTP ${startExecResult.response.status} while running Docker environment setup.`,
      ),
    };
  }

  const outputResult = await readDockerSetupExecOutput(envelope, bearerToken, startExecResult.response);
  if (outputResult.resultType === 'failed') return outputResult;

  const completionResult = await waitForDockerExecCompletion(envelope, context, config, bearerToken, execId);
  if (completionResult.resultType === 'failed') return completionResult;

  return {
    resultType: 'completed',
    completion: {
      exitCode: completionResult.exitCode,
      output: outputResult.output,
    },
  };
}

async function readDockerSetupExecOutput(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  bearerToken: string | undefined,
  response: RuntimeHttpResponse,
): Promise<{ readonly resultType: 'completed'; readonly output: string } | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }> {
  try {
    return { resultType: 'completed', output: await readDockerExecStartOutput(response) };
  } catch (error) {
    return {
      resultType: 'failed',
      result: failed(
        envelope,
        failureReasonForRequestError(error),
        `Docker environment setup output could not be read completely: ${safeErrorName(error)}.${formatDockerSetupOutputSummary(safeErrorMessage(error), envelope, bearerToken)}`,
      ),
    };
  }
}

async function readDockerExecStartOutput(response: RuntimeHttpResponse): Promise<string> {
  const responseWithBinaryBody = response as RuntimeHttpResponse & { readonly arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof responseWithBinaryBody.arrayBuffer === 'function') {
    const body = new Uint8Array(await responseWithBinaryBody.arrayBuffer());
    return decodeDockerExecOutputBytes(body);
  }
  return decodeDockerExecOutputText(await response.text());
}

function decodeDockerExecOutputBytes(body: Uint8Array): string {
  const multiplexedOutput = decodeDockerMultiplexedOutputBytes(body);
  return multiplexedOutput ?? new TextDecoder().decode(body);
}

function decodeDockerMultiplexedOutputBytes(body: Uint8Array): string | undefined {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 8 > body.length) return undefined;
    const streamType = body[offset];
    if (!isDockerMultiplexedStreamType(streamType) || body[offset + 1] !== 0 || body[offset + 2] !== 0 || body[offset + 3] !== 0) {
      return undefined;
    }

    const payloadLength = body[offset + 4] * 0x1000000
      + body[offset + 5] * 0x10000
      + body[offset + 6] * 0x100
      + body[offset + 7];
    offset += 8;
    if (offset + payloadLength > body.length) return undefined;
    chunks.push(body.slice(offset, offset + payloadLength));
    offset += payloadLength;
  }

  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let outputOffset = 0;
  for (const chunk of chunks) {
    output.set(chunk, outputOffset);
    outputOffset += chunk.length;
  }
  return new TextDecoder().decode(output);
}

function decodeDockerExecOutputText(text: string): string {
  const multiplexedOutput = decodeDockerMultiplexedOutputText(text);
  return multiplexedOutput ?? text;
}

function decodeDockerMultiplexedOutputText(text: string): string | undefined {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    if (offset + 8 > text.length) return undefined;
    const streamType = text.charCodeAt(offset);
    if (!isDockerMultiplexedStreamType(streamType) || text.charCodeAt(offset + 1) !== 0 || text.charCodeAt(offset + 2) !== 0 || text.charCodeAt(offset + 3) !== 0) {
      return undefined;
    }

    const payloadLength = text.charCodeAt(offset + 4) * 0x1000000
      + text.charCodeAt(offset + 5) * 0x10000
      + text.charCodeAt(offset + 6) * 0x100
      + text.charCodeAt(offset + 7);
    offset += 8;
    if (offset + payloadLength > text.length) return undefined;
    chunks.push(text.slice(offset, offset + payloadLength));
    offset += payloadLength;
  }
  return chunks.join('');
}

function isDockerMultiplexedStreamType(value: number): boolean {
  return value === 1 || value === 2;
}

function formatDockerSetupOutputSummary(
  output: string,
  envelope: RemoteFleetBootstrapCommandEnvelope,
  bearerToken: string | undefined,
): string {
  const redactedOutput = redactDockerBootstrapDiagnostic(output, envelope, bearerToken).trim();
  if (!redactedOutput) return '';

  const outputTail = redactedOutput.length > DOCKER_ENVIRONMENT_SETUP_OUTPUT_TAIL_MAX_CHARS
    ? `[output truncated]\n${redactedOutput.slice(-DOCKER_ENVIRONMENT_SETUP_OUTPUT_TAIL_MAX_CHARS)}`
    : redactedOutput;
  return ` Last setup output:\n${outputTail}`;
}

async function waitForDockerExecCompletion(
  envelope: RemoteFleetBootstrapCommandEnvelope,
  context: RemoteFleetBootstrapProviderContext,
  config: DockerApiConfig,
  bearerToken: string | undefined,
  execId: string,
): Promise<{ readonly resultType: 'completed'; readonly exitCode: number } | { readonly resultType: 'failed'; readonly result: RemoteFleetBootstrapCommandResult }> {
  for (let pollCount = 0; pollCount < DOCKER_ENVIRONMENT_SETUP_MAX_POLLS; pollCount += 1) {
    const inspectResult = await requestDockerApi(envelope, context, config, `/exec/${dockerApiPathSegment(execId)}/json`, {
      method: 'GET',
      bearerToken,
    });
    if (inspectResult.resultType === 'failed') return inspectResult;
    if (!isSuccessfulResponse(inspectResult.response)) {
      return {
        resultType: 'failed',
        result: failed(
          envelope,
          failureReasonForDockerStatus(inspectResult.response.status),
          `Docker Engine returned HTTP ${inspectResult.response.status} while inspecting Docker environment setup.`,
        ),
      };
    }

    const exitCode = await readExecExitCode(inspectResult.response);
    if (exitCode !== undefined) {
      return { resultType: 'completed', exitCode };
    }

    await sleep(DOCKER_ENVIRONMENT_SETUP_POLL_INTERVAL_MS);
  }

  return { resultType: 'failed', result: failed(envelope, 'timeout', 'Docker environment setup timed out.') };
}

async function readDockerId(response: RuntimeHttpResponse): Promise<string | undefined> {
  try {
    const body = await response.json() as DockerIdResponseBody;
    return typeof body.Id === 'string' && body.Id.trim().length > 0 ? body.Id.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function readExecExitCode(response: RuntimeHttpResponse): Promise<number | undefined> {
  try {
    const body = await response.json() as DockerExecInspectResponseBody;
    return typeof body.ExitCode === 'number' ? body.ExitCode : undefined;
  } catch {
    return undefined;
  }
}

function readDockerImageCandidateReferences(images: readonly string[]): { readonly resultType: 'valid'; readonly candidates: readonly DockerImageCandidate[] } | { readonly resultType: 'invalid'; readonly message: string } {
  const candidates: DockerImageCandidate[] = [];
  for (const image of images) {
    const reference = readDockerImageReference(image);
    if (reference.resultType === 'invalid') return reference;
    candidates.push({ image, query: reference.query });
  }
  return { resultType: 'valid', candidates };
}

function readDockerImageReference(image: string): { readonly resultType: 'valid'; readonly query: Readonly<Record<string, string>> } | { readonly resultType: 'invalid'; readonly message: string } {
  const digestIndex = image.indexOf('@');
  if (digestIndex >= 0) {
    return digestIndex > 0 && digestIndex < image.length - 1
      ? { resultType: 'valid', query: { fromImage: image } }
      : { resultType: 'invalid', message: 'Remote Fleet Docker image digest reference is invalid.' };
  }

  const lastSlashIndex = image.lastIndexOf('/');
  const lastColonIndex = image.lastIndexOf(':');
  if (lastColonIndex > lastSlashIndex) {
    const fromImage = image.slice(0, lastColonIndex);
    const tag = image.slice(lastColonIndex + 1);
    return fromImage && tag
      ? { resultType: 'valid', query: { fromImage, tag } }
      : { resultType: 'invalid', message: 'Remote Fleet Docker image tag reference is invalid.' };
  }

  return image.length > 0
    ? { resultType: 'valid', query: { fromImage: image } }
    : { resultType: 'invalid', message: 'Remote Fleet Docker image reference must not be empty.' };
}

async function sleep(timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
}

async function safeReadResponseText(response: RuntimeHttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function connectionProbeFailureReasonForDockerConfigFailure(
  reason: RemoteFleetDockerConfigFailureReason,
): RemoteFleetConnectionProbeFailureReason {
  return reason;
}

function bootstrapFailureReasonForDockerConfigFailure(
  reason: RemoteFleetDockerConfigFailureReason,
): RemoteFleetBootstrapFailureReason {
  return reason;
}

function failureReasonForDockerConnectionProbeStatus(status: number): RemoteFleetConnectionProbeFailureReason {
  return status === 401 || status === 403 ? 'auth' : 'remote-error';
}

function failureReasonForDockerConnectionProbeRequestError(error: unknown): RemoteFleetConnectionProbeFailureReason {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network';
}

function failureReasonForDockerStatus(status: number): RemoteFleetBootstrapFailureReason {
  return status === 401 || status === 403 ? 'auth' : 'remote-error';
}

function failureReasonForRequestError(error: unknown): RemoteFleetBootstrapFailureReason {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network';
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'unknown error';
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '';
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
