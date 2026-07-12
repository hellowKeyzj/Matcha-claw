import {
  findUnsafeRemoteFleetEndpointUrlKey,
  findUnsafeRemoteFleetPublicConfigKey,
} from './remote-fleet-command-policy';

export const REMOTE_FLEET_DOCKER_PROVIDER_KIND = 'docker' as const;
export const REMOTE_FLEET_DOCKER_BEARER_TOKEN_SECRET_REF_NAME = 'dockerBearerToken' as const;

export const REMOTE_FLEET_DEFAULT_DOCKER_ENVIRONMENT_IMAGE = 'debian:bookworm-slim';
export const REMOTE_FLEET_DEFAULT_DOCKER_ENVIRONMENT_IMAGE_CANDIDATES = [
  'docker.m.daocloud.io/library/debian:bookworm-slim',
  REMOTE_FLEET_DEFAULT_DOCKER_ENVIRONMENT_IMAGE,
] as const;
const DEFAULT_DOCKER_TERMINAL_COMMAND = ['/bin/sh', '-l'] as const;
const DOCKER_IMAGE_REFERENCE_MAX_LENGTH = 4096;

export interface RemoteFleetDockerProviderSecretRef {
  readonly kind?: unknown;
  readonly ref?: unknown;
}

export type RemoteFleetDockerProviderSecretRefs = Readonly<Record<string, RemoteFleetDockerProviderSecretRef | undefined>>;

export interface RemoteFleetDockerBootstrapConfig {
  readonly endpointUrl: string;
  readonly image: string;
  readonly imageCandidates: readonly string[];
  readonly containerName: string;
}

export interface RemoteFleetDockerBootstrapProviderConfig extends RemoteFleetDockerBootstrapConfig {
  readonly dockerBearerTokenSecretRef?: string;
}

export interface RemoteFleetDockerConnectionProbeConfig {
  readonly endpointUrl: string;
  readonly dockerBearerTokenSecretRef?: string;
}

export interface RemoteFleetDockerDeleteEnvironmentProviderConfig {
  readonly endpointUrl: string;
  readonly containerRef: string;
  readonly dockerBearerTokenSecretRef?: string;
}

export interface RemoteFleetDockerTerminalConfig {
  readonly endpointUrl: string;
  readonly containerRef: string;
  readonly terminalCommand: readonly string[];
}

export interface RemoteFleetDockerTerminalProviderConfig extends RemoteFleetDockerTerminalConfig {
  readonly dockerBearerTokenSecretRef?: string;
}

export type RemoteFleetDockerConfigResult<T> =
  | { readonly resultType: 'valid'; readonly config: T }
  | { readonly resultType: 'invalid'; readonly reason: RemoteFleetDockerConfigFailureReason; readonly message: string };

export type RemoteFleetDockerConfigFailureReason =
  | 'invalid-config'
  | 'endpoint-protocol-mismatch';

type RemoteFleetDockerConfigInvalidResult = Extract<
  RemoteFleetDockerConfigResult<never>,
  { readonly resultType: 'invalid' }
>;

export function isRemoteFleetDockerLoopbackHttps2375Endpoint(endpointUrl: string | undefined): boolean {
  if (!endpointUrl) return false;

  try {
    const url = new URL(endpointUrl);
    return url.protocol === 'https:'
      && url.port === '2375'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

export function readRemoteFleetDockerConnectionProbeConfig(input: {
  readonly connectionPublicConfig: Readonly<Record<string, unknown>>;
  readonly connectionEndpointUrl?: string;
  readonly connectionSecretRefs: RemoteFleetDockerProviderSecretRefs;
}): RemoteFleetDockerConfigResult<RemoteFleetDockerConnectionProbeConfig> {
  const unsafePublicConfigKey = findUnsafeRemoteFleetPublicConfigKey(input.connectionPublicConfig);
  if (unsafePublicConfigKey) {
    return invalid(`Remote Fleet Docker connection publicConfig contains unsafe credential material at ${unsafePublicConfigKey}.`);
  }

  const dockerConfig = readRecord(input.connectionPublicConfig.docker);
  const endpointUrl = readOptionalString(dockerConfig.endpointUrl)
    ?? readOptionalString(input.connectionEndpointUrl);
  if (!endpointUrl) {
    return invalid('Remote Fleet Docker connection probe requires connection.publicConfig.docker.endpointUrl or connection.endpointUrl.');
  }

  const endpointValidation = validateDockerEndpointUrl(endpointUrl);
  if (endpointValidation) return endpointValidation;

  const dockerBearerTokenSecretRef = readOptionalValidSecretRef(
    input.connectionSecretRefs,
    REMOTE_FLEET_DOCKER_BEARER_TOKEN_SECRET_REF_NAME,
  );
  if (dockerBearerTokenSecretRef.resultType === 'invalid') return dockerBearerTokenSecretRef;

  return {
    resultType: 'valid',
    config: {
      endpointUrl,
      ...(dockerBearerTokenSecretRef.secretRef ? { dockerBearerTokenSecretRef: dockerBearerTokenSecretRef.secretRef } : {}),
    },
  };
}

export function readRemoteFleetDockerBootstrapConfig(input: {
  readonly publicConfig: Readonly<Record<string, unknown>>;
  readonly nodeId: string;
}): RemoteFleetDockerConfigResult<RemoteFleetDockerBootstrapConfig> {
  return readRemoteFleetDockerBootstrapProviderConfig({
    nodePublicConfig: input.publicConfig,
    nodeId: input.nodeId,
  });
}

export function readRemoteFleetDockerBootstrapProviderConfig(input: {
  readonly connectionPublicConfig?: Readonly<Record<string, unknown>>;
  readonly connectionEndpointUrl?: string;
  readonly connectionSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  readonly environmentPublicConfig?: Readonly<Record<string, unknown>>;
  readonly environmentSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  readonly nodePublicConfig: Readonly<Record<string, unknown>>;
  readonly nodeSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  readonly nodeId: string;
}): RemoteFleetDockerConfigResult<RemoteFleetDockerBootstrapProviderConfig> {
  const providerConfigResult = readRemoteFleetDockerProviderConfigParts(input, 'bootstrap');
  if (providerConfigResult.resultType === 'invalid') return providerConfigResult;

  const { dockerConfig, endpointUrl, dockerBearerTokenSecretRef } = providerConfigResult.config;
  const image = readDockerImage(dockerConfig.image);
  if (image.resultType === 'invalid') return invalid(image.message);

  const imageCandidates = readDockerImageCandidates(dockerConfig.imageCandidates, image.value);
  if (imageCandidates.resultType === 'invalid') return invalid(imageCandidates.message);

  const containerName = readDockerContainerName(dockerConfig.containerName, input.nodeId);
  if (containerName.resultType === 'invalid') return invalid(containerName.message);

  return {
    resultType: 'valid',
    config: {
      endpointUrl,
      image: image.value,
      imageCandidates: imageCandidates.values,
      containerName: containerName.value,
      ...(dockerBearerTokenSecretRef ? { dockerBearerTokenSecretRef } : {}),
    },
  };
}

export function readRemoteFleetDockerDeleteEnvironmentProviderConfig(input: {
  readonly connectionPublicConfig?: Readonly<Record<string, unknown>>;
  readonly connectionEndpointUrl?: string;
  readonly connectionSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  readonly environmentPublicConfig?: Readonly<Record<string, unknown>>;
  readonly environmentSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  readonly managedResourceRemoteResourceId?: string;
  readonly nodePublicConfig: Readonly<Record<string, unknown>>;
  readonly nodeSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  readonly nodeId: string;
}): RemoteFleetDockerConfigResult<RemoteFleetDockerDeleteEnvironmentProviderConfig> {
  const providerConfigResult = readRemoteFleetDockerProviderConfigParts(input, 'delete-environment');
  if (providerConfigResult.resultType === 'invalid') return providerConfigResult;

  const { dockerConfig, endpointUrl, dockerBearerTokenSecretRef } = providerConfigResult.config;
  const containerRef = readDockerDeleteEnvironmentContainerRef(
    input.managedResourceRemoteResourceId,
    dockerConfig,
    input.nodeId,
  );
  if (containerRef.resultType === 'invalid') return invalid(containerRef.message);

  return {
    resultType: 'valid',
    config: {
      endpointUrl,
      containerRef: containerRef.value,
      ...(dockerBearerTokenSecretRef ? { dockerBearerTokenSecretRef } : {}),
    },
  };
}

export function readRemoteFleetDockerTerminalConfig(
  publicConfig: Readonly<Record<string, unknown>>,
  input: { readonly nodeId?: string } = {},
): RemoteFleetDockerConfigResult<RemoteFleetDockerTerminalConfig> {
  return readRemoteFleetDockerTerminalProviderConfig({
    nodePublicConfig: publicConfig,
    nodeId: input.nodeId,
  });
}

export function readRemoteFleetDockerTerminalProviderConfig(input: {
  readonly connectionPublicConfig?: Readonly<Record<string, unknown>>;
  readonly connectionEndpointUrl?: string;
  readonly connectionSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  readonly environmentPublicConfig?: Readonly<Record<string, unknown>>;
  readonly environmentSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  readonly nodePublicConfig: Readonly<Record<string, unknown>>;
  readonly nodeSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  readonly nodeId?: string;
}): RemoteFleetDockerConfigResult<RemoteFleetDockerTerminalProviderConfig> {
  const providerConfigResult = readRemoteFleetDockerProviderConfigParts(input, 'terminal');
  if (providerConfigResult.resultType === 'invalid') return providerConfigResult;

  const { dockerConfig, endpointUrl, dockerBearerTokenSecretRef } = providerConfigResult.config;
  const containerRef = readDockerTerminalContainerRef(dockerConfig, input.nodeId);
  if (containerRef.resultType === 'invalid') return invalid(containerRef.message);

  const terminalConfig = readRecord(dockerConfig.terminal);
  const terminalCommand = readDockerTerminalCommand(terminalConfig.command);
  if (terminalCommand.resultType === 'invalid') return invalid(terminalCommand.message);

  return {
    resultType: 'valid',
    config: {
      endpointUrl,
      containerRef: containerRef.value,
      terminalCommand: terminalCommand.command,
      ...(dockerBearerTokenSecretRef ? { dockerBearerTokenSecretRef } : {}),
    },
  };
}

export function buildDockerApiUrl(
  endpointUrl: string,
  inputPath: string,
  query: Readonly<Record<string, string>> = {},
): string {
  const url = new URL(endpointUrl);
  const basePath = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  const apiPath = inputPath.startsWith('/') ? inputPath : `/${inputPath}`;
  url.pathname = `${basePath}${apiPath}`;
  url.search = '';
  url.hash = '';

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function dockerApiPathSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function readRemoteFleetDockerProviderConfigParts(
  input: {
    readonly connectionPublicConfig?: Readonly<Record<string, unknown>>;
    readonly connectionEndpointUrl?: string;
    readonly connectionSecretRefs?: RemoteFleetDockerProviderSecretRefs;
    readonly environmentPublicConfig?: Readonly<Record<string, unknown>>;
    readonly environmentSecretRefs?: RemoteFleetDockerProviderSecretRefs;
    readonly nodePublicConfig: Readonly<Record<string, unknown>>;
    readonly nodeSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  },
  purpose: 'bootstrap' | 'delete-environment' | 'terminal',
): RemoteFleetDockerConfigResult<{
  readonly dockerConfig: Readonly<Record<string, unknown>>;
  readonly connectionDockerConfig: Readonly<Record<string, unknown>>;
  readonly environmentDockerConfig?: Readonly<Record<string, unknown>>;
  readonly nodeDockerConfig: Readonly<Record<string, unknown>>;
  readonly endpointUrl: string;
  readonly dockerBearerTokenSecretRef?: string;
}> {
  const connectionUnsafePublicConfigKey = input.connectionPublicConfig
    ? findUnsafeRemoteFleetPublicConfigKey(input.connectionPublicConfig)
    : undefined;
  if (connectionUnsafePublicConfigKey) {
    return invalid(`Remote Fleet Docker connection publicConfig contains unsafe credential material at ${connectionUnsafePublicConfigKey}.`);
  }

  const environmentUnsafePublicConfigKey = input.environmentPublicConfig
    ? findUnsafeRemoteFleetPublicConfigKey(input.environmentPublicConfig)
    : undefined;
  if (environmentUnsafePublicConfigKey) {
    return invalid(`Remote Fleet Docker environment publicConfig contains unsafe credential material at ${environmentUnsafePublicConfigKey}.`);
  }

  const nodeUnsafePublicConfigKey = findUnsafeRemoteFleetPublicConfigKey(input.nodePublicConfig);
  if (nodeUnsafePublicConfigKey) {
    const publicConfigLabel = input.connectionPublicConfig || input.environmentPublicConfig ? 'node publicConfig' : 'publicConfig';
    return invalid(`Remote Fleet Docker ${publicConfigLabel} contains unsafe credential material at ${nodeUnsafePublicConfigKey}.`);
  }

  const connectionDockerConfig = readRecord(input.connectionPublicConfig?.docker);
  const environmentDockerConfig = input.environmentPublicConfig
    ? readRecord(input.environmentPublicConfig.docker)
    : undefined;
  const nodeDockerConfig = readRecord(input.nodePublicConfig.docker);
  const dockerConfig = environmentDockerConfig
    ? mergeDockerConfig(nodeDockerConfig, connectionDockerConfig, environmentDockerConfig)
    : nodeDockerConfig;
  const endpointUrl = readOptionalString(environmentDockerConfig?.endpointUrl)
    ?? readOptionalString(connectionDockerConfig.endpointUrl)
    ?? readOptionalString(input.connectionEndpointUrl)
    ?? readOptionalString(nodeDockerConfig.endpointUrl);
  if (!endpointUrl) {
    return invalid(input.connectionPublicConfig || input.environmentPublicConfig
      ? `Remote Fleet Docker ${purpose} requires environment.publicConfig.docker.endpointUrl, connection.publicConfig.docker.endpointUrl, connection.endpointUrl, or node.publicConfig.docker.endpointUrl.`
      : `Remote Fleet Docker ${purpose} requires node.publicConfig.docker.endpointUrl.`);
  }

  const endpointValidation = validateDockerEndpointUrl(endpointUrl);
  if (endpointValidation) return endpointValidation;

  const dockerBearerTokenSecretRefResult = readDockerBearerTokenSecretRef(input);
  if (dockerBearerTokenSecretRefResult.resultType === 'invalid') return dockerBearerTokenSecretRefResult;

  return {
    resultType: 'valid',
    config: {
      dockerConfig,
      connectionDockerConfig,
      ...(environmentDockerConfig ? { environmentDockerConfig } : {}),
      nodeDockerConfig,
      endpointUrl,
      ...(dockerBearerTokenSecretRefResult.secretRef ? { dockerBearerTokenSecretRef: dockerBearerTokenSecretRefResult.secretRef } : {}),
    },
  };
}

function mergeDockerConfig(
  nodeDockerConfig: Readonly<Record<string, unknown>>,
  connectionDockerConfig: Readonly<Record<string, unknown>>,
  environmentDockerConfig: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return {
    ...nodeDockerConfig,
    ...connectionDockerConfig,
    ...(environmentDockerConfig ?? {}),
  };
}

function readDockerBearerTokenSecretRef(input: {
  readonly connectionSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  readonly environmentSecretRefs?: RemoteFleetDockerProviderSecretRefs;
  readonly nodeSecretRefs?: RemoteFleetDockerProviderSecretRefs;
}): { readonly resultType: 'valid'; readonly secretRef?: string } | { readonly resultType: 'invalid'; readonly message: string } {
  const environmentSecretRef = readOptionalValidSecretRef(input.environmentSecretRefs, REMOTE_FLEET_DOCKER_BEARER_TOKEN_SECRET_REF_NAME);
  if (environmentSecretRef.resultType === 'invalid') return environmentSecretRef;
  if (environmentSecretRef.secretRef) return environmentSecretRef;

  const connectionSecretRef = readOptionalValidSecretRef(input.connectionSecretRefs, REMOTE_FLEET_DOCKER_BEARER_TOKEN_SECRET_REF_NAME);
  if (connectionSecretRef.resultType === 'invalid') return connectionSecretRef;
  if (connectionSecretRef.secretRef) return connectionSecretRef;

  const nodeSecretRef = readOptionalValidSecretRef(input.nodeSecretRefs, REMOTE_FLEET_DOCKER_BEARER_TOKEN_SECRET_REF_NAME);
  if (nodeSecretRef.resultType === 'invalid') return nodeSecretRef;
  return nodeSecretRef;
}

function readOptionalValidSecretRef(
  secretRefs: RemoteFleetDockerProviderSecretRefs | undefined,
  secretRefName: string,
): { readonly resultType: 'valid'; readonly secretRef?: string } | { readonly resultType: 'invalid'; readonly message: string } {
  const value = secretRefs?.[secretRefName];
  if (value === undefined) return { resultType: 'valid' };
  if (value.kind !== 'secret-ref' || typeof value.ref !== 'string' || value.ref.trim().length === 0) {
    return invalid(`Docker ${secretRefName} secretRef is invalid.`);
  }
  return { resultType: 'valid', secretRef: value.ref.trim() };
}

function validateDockerEndpointUrl(endpointUrl: string): RemoteFleetDockerConfigInvalidResult | undefined {
  const unsafeEndpointUrlKey = findUnsafeRemoteFleetEndpointUrlKey(endpointUrl);
  if (unsafeEndpointUrlKey === 'endpointUrl.credentials') {
    return invalid('Remote Fleet Docker endpointUrl must not contain username or password credentials.');
  }
  if (unsafeEndpointUrlKey) {
    return invalid('Remote Fleet Docker endpointUrl must not contain credential query parameters or token material.');
  }

  try {
    const url = new URL(endpointUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return invalid('Remote Fleet Docker endpointUrl must use http:// or https://; unix socket endpoints are not supported.');
    }
    if (isRemoteFleetDockerLoopbackHttps2375Endpoint(endpointUrl)) {
      return invalidEndpointProtocolMismatch();
    }
    return undefined;
  } catch {
    return invalid('Remote Fleet Docker endpointUrl must be a valid URL.');
  }
}

function readDockerImage(value: unknown): { readonly resultType: 'valid'; readonly value: string } | { readonly resultType: 'invalid'; readonly message: string } {
  if (value === undefined) return { resultType: 'valid', value: REMOTE_FLEET_DEFAULT_DOCKER_ENVIRONMENT_IMAGE };
  return readDockerImageReferenceString(value, 'Remote Fleet Docker image');
}

function readDockerImageCandidates(
  value: unknown,
  image: string,
): { readonly resultType: 'valid'; readonly values: readonly string[] } | { readonly resultType: 'invalid'; readonly message: string } {
  if (value === undefined) {
    return { resultType: 'valid', values: defaultDockerImageCandidates(image) };
  }
  if (!Array.isArray(value)) {
    return { resultType: 'invalid', message: 'Remote Fleet Docker imageCandidates must be a string array.' };
  }
  if (value.length === 0) {
    return { resultType: 'invalid', message: 'Remote Fleet Docker imageCandidates must not be empty.' };
  }

  const candidates: string[] = [];
  for (const [index, candidateValue] of value.entries()) {
    const candidate = readDockerImageReferenceString(candidateValue, `Remote Fleet Docker imageCandidates[${index}]`);
    if (candidate.resultType === 'invalid') return candidate;
    candidates.push(candidate.value);
  }
  return { resultType: 'valid', values: uniqueDockerImageCandidates([image, ...candidates]) };
}

function readDockerImageReferenceString(
  value: unknown,
  fieldName: string,
): { readonly resultType: 'valid'; readonly value: string } | { readonly resultType: 'invalid'; readonly message: string } {
  const image = readOptionalString(value);
  if (!image) {
    return { resultType: 'invalid', message: `${fieldName} must be a non-empty string.` };
  }
  if (image.length > DOCKER_IMAGE_REFERENCE_MAX_LENGTH || /[\x00-\x1f\x7f]/.test(image)) {
    return { resultType: 'invalid', message: `${fieldName} must be 1-${DOCKER_IMAGE_REFERENCE_MAX_LENGTH} characters without control characters.` };
  }
  return { resultType: 'valid', value: image };
}

function defaultDockerImageCandidates(image: string): readonly string[] {
  return image === REMOTE_FLEET_DEFAULT_DOCKER_ENVIRONMENT_IMAGE
    ? REMOTE_FLEET_DEFAULT_DOCKER_ENVIRONMENT_IMAGE_CANDIDATES
    : uniqueDockerImageCandidates([
        image,
        ...REMOTE_FLEET_DEFAULT_DOCKER_ENVIRONMENT_IMAGE_CANDIDATES,
      ]);
}

function uniqueDockerImageCandidates(images: readonly string[]): readonly string[] {
  const candidates: string[] = [];
  for (const image of images) {
    if (!candidates.includes(image)) candidates.push(image);
  }
  return candidates;
}

function readDockerContainerName(value: unknown, nodeId: string): { readonly resultType: 'valid'; readonly value: string } | { readonly resultType: 'invalid'; readonly message: string } {
  const containerName = value === undefined
    ? defaultDockerContainerName(nodeId)
    : readOptionalString(value);
  if (!containerName) {
    return { resultType: 'invalid', message: 'Remote Fleet Docker containerName must be a non-empty string.' };
  }
  if (!isValidDockerContainerName(containerName)) {
    return { resultType: 'invalid', message: 'Remote Fleet Docker containerName must contain only letters, numbers, dots, underscores, and dashes.' };
  }
  return { resultType: 'valid', value: containerName };
}

function readDockerDeleteEnvironmentContainerRef(
  managedResourceRemoteResourceId: string | undefined,
  dockerConfig: Readonly<Record<string, unknown>>,
  nodeId: string,
): { readonly resultType: 'valid'; readonly value: string } | { readonly resultType: 'invalid'; readonly message: string } {
  const managedResourceRef = readOptionalString(managedResourceRemoteResourceId);
  if (managedResourceRef) {
    return isSafeDockerPathSegment(managedResourceRef)
      ? { resultType: 'valid', value: managedResourceRef }
      : { resultType: 'invalid', message: 'Remote Fleet Docker managedResource.remoteResourceId must be a non-empty Docker API path segment without slash, query, fragment, or control characters.' };
  }

  return readDockerTerminalContainerRef(dockerConfig, nodeId, 'delete-environment');
}

function readDockerTerminalContainerRef(
  dockerConfig: Readonly<Record<string, unknown>>,
  nodeId: string | undefined,
  purpose: 'terminal' | 'delete-environment' = 'terminal',
): { readonly resultType: 'valid'; readonly value: string } | { readonly resultType: 'invalid'; readonly message: string } {
  const containerId = readOptionalString(dockerConfig.containerId);
  if (containerId) {
    return isSafeDockerPathSegment(containerId)
      ? { resultType: 'valid', value: containerId }
      : { resultType: 'invalid', message: 'Remote Fleet Docker containerId must be a non-empty Docker API path segment without slash, query, fragment, or control characters.' };
  }

  const containerName = readOptionalString(dockerConfig.containerName);
  if (containerName) {
    return isValidDockerContainerName(containerName)
      ? { resultType: 'valid', value: containerName }
      : { resultType: 'invalid', message: 'Remote Fleet Docker containerName must contain only letters, numbers, dots, underscores, and dashes.' };
  }

  if (nodeId) {
    return { resultType: 'valid', value: defaultDockerContainerName(nodeId) };
  }

  return {
    resultType: 'invalid',
    message: `Remote Fleet Docker ${purpose} requires docker.containerId or containerName.`,
  };
}

function readDockerTerminalCommand(value: unknown):
  | { readonly resultType: 'valid'; readonly command: readonly string[] }
  | { readonly resultType: 'invalid'; readonly message: string } {
  if (value === undefined) return { resultType: 'valid', command: DEFAULT_DOCKER_TERMINAL_COMMAND };
  if (typeof value === 'string') return readDockerTerminalCommandParts([value]);
  if (Array.isArray(value)) return readDockerTerminalCommandParts(value);
  return { resultType: 'invalid', message: 'Remote Fleet Docker terminal.command must be a string or string array.' };
}

function readDockerTerminalCommandParts(value: readonly unknown[]):
  | { readonly resultType: 'valid'; readonly command: readonly string[] }
  | { readonly resultType: 'invalid'; readonly message: string } {
  if (value.length === 0) {
    return { resultType: 'invalid', message: 'Remote Fleet Docker terminal.command must not be empty.' };
  }

  const command: string[] = [];
  for (const part of value) {
    if (typeof part !== 'string') {
      return { resultType: 'invalid', message: 'Remote Fleet Docker terminal.command entries must be strings.' };
    }
    const trimmed = part.trim();
    if (trimmed.length === 0 || trimmed.length > 4096 || /[\x00-\x1f\x7f]/.test(trimmed)) {
      return { resultType: 'invalid', message: 'Remote Fleet Docker terminal.command entries must be 1-4096 characters without control characters.' };
    }
    command.push(trimmed);
  }
  return { resultType: 'valid', command };
}

function defaultDockerContainerName(nodeId: string): string {
  const sanitizedNodeId = nodeId
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `matchaclaw-debian-${sanitizedNodeId || 'node'}`;
}

function isValidDockerContainerName(containerName: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(containerName);
}

function isSafeDockerPathSegment(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && value !== '.'
    && value !== '..'
    && !/[\\/?#\x00-\x1f\x7f]/.test(value);
}

function invalid<T>(message: string): RemoteFleetDockerConfigResult<T> {
  return { resultType: 'invalid', reason: 'invalid-config', message };
}

function invalidEndpointProtocolMismatch(): RemoteFleetDockerConfigInvalidResult {
  return {
    resultType: 'invalid',
    reason: 'endpoint-protocol-mismatch',
    message: 'Remote Fleet Docker local port 2375 must use HTTP instead of HTTPS.',
  };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
