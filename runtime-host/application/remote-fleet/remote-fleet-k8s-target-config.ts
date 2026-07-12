import { findUnsafeRemoteFleetPublicConfigKey } from './remote-fleet-command-policy';

export const REMOTE_FLEET_K8S_PROVIDER_KIND = 'k8s' as const;
export const REMOTE_FLEET_KUBE_BEARER_TOKEN_SECRET_REF_NAME = 'kubeBearerToken' as const;

const DEFAULT_NAMESPACE = 'default';
const DEFAULT_IMAGE = 'matchaclaw/runtime-agent:latest';
const DEFAULT_RUNTIME_AGENT_PORT = 8721;
const DEFAULT_DEPLOYMENT_PREFIX = 'matchaclaw-runtime-agent';
const DEFAULT_K8S_TERMINAL_COMMAND = ['/bin/sh', '-l'] as const;

export interface RemoteFleetK8sProviderSecretRef {
  readonly kind?: unknown;
  readonly ref?: unknown;
}

export type RemoteFleetK8sProviderSecretRefs = Readonly<Record<string, RemoteFleetK8sProviderSecretRef | undefined>>;

export interface RemoteFleetK8sBootstrapConfig {
  readonly apiServerUrl: string;
  readonly namespace: string;
  readonly deploymentName: string;
  readonly serviceName: string;
  readonly secretName: string;
  readonly image: string;
  readonly runtimeAgentPort: number;
  readonly sanitizedNodeId: string;
  readonly sanitizedAgentId: string;
}

export interface RemoteFleetK8sBootstrapProviderConfig extends RemoteFleetK8sBootstrapConfig {
  readonly kubeBearerTokenSecretRef?: string;
}

export interface RemoteFleetK8sConnectionProbeConfig {
  readonly apiServerUrl: string;
  readonly namespace: string;
  readonly kubeBearerTokenSecretRef?: string;
}

export interface RemoteFleetK8sTerminalConfig {
  readonly apiServerUrl: string;
  readonly namespace: string;
  readonly podName?: string;
  readonly containerName?: string;
  readonly labelSelector?: string;
  readonly terminalCommand: readonly string[];
}

export interface RemoteFleetK8sTerminalProviderConfig extends RemoteFleetK8sTerminalConfig {
  readonly kubeBearerTokenSecretRef?: string;
}

export type RemoteFleetK8sConfigResult<T> =
  | { readonly resultType: 'valid'; readonly config: T }
  | { readonly resultType: 'invalid'; readonly message: string };

export function readRemoteFleetK8sConnectionProbeConfig(input: {
  readonly connectionPublicConfig: Readonly<Record<string, unknown>>;
  readonly connectionSecretRefs: RemoteFleetK8sProviderSecretRefs;
}): RemoteFleetK8sConfigResult<RemoteFleetK8sConnectionProbeConfig> {
  const mergedConfigResult = readRemoteFleetK8sProviderConfigParts({
    connectionPublicConfig: input.connectionPublicConfig,
    connectionSecretRefs: input.connectionSecretRefs,
    nodePublicConfig: {},
  });
  if (mergedConfigResult.resultType === 'invalid') return mergedConfigResult;

  const { apiServerUrl, namespace, kubeBearerTokenSecretRef } = mergedConfigResult.config;
  if (!isK8sDnsLabel(namespace)) {
    return invalid('Kubernetes namespace must be a valid DNS label.');
  }
  return {
    resultType: 'valid',
    config: {
      apiServerUrl,
      namespace,
      ...(kubeBearerTokenSecretRef ? { kubeBearerTokenSecretRef } : {}),
    },
  };
}

export function readRemoteFleetK8sBootstrapConfig(input: {
  readonly publicConfig: Readonly<Record<string, unknown>>;
  readonly nodeId: string;
  readonly agentId: string;
}): RemoteFleetK8sConfigResult<RemoteFleetK8sBootstrapConfig> {
  return readRemoteFleetK8sBootstrapProviderConfig({
    nodePublicConfig: input.publicConfig,
    nodeId: input.nodeId,
    agentId: input.agentId,
  });
}

export function readRemoteFleetK8sBootstrapProviderConfig(input: {
  readonly connectionPublicConfig?: Readonly<Record<string, unknown>>;
  readonly connectionSecretRefs?: RemoteFleetK8sProviderSecretRefs;
  readonly environmentPublicConfig?: Readonly<Record<string, unknown>>;
  readonly environmentSecretRefs?: RemoteFleetK8sProviderSecretRefs;
  readonly nodePublicConfig: Readonly<Record<string, unknown>>;
  readonly nodeSecretRefs?: RemoteFleetK8sProviderSecretRefs;
  readonly nodeId: string;
  readonly agentId: string;
}): RemoteFleetK8sConfigResult<RemoteFleetK8sBootstrapProviderConfig> {
  const mergedConfigResult = readRemoteFleetK8sProviderConfigParts(input);
  if (mergedConfigResult.resultType === 'invalid') return mergedConfigResult;

  const { k8sConfig, apiServerUrl, namespace, kubeBearerTokenSecretRef } = mergedConfigResult.config;
  const sanitizedNodeId = sanitizeK8sNameSuffix(input.nodeId);
  const sanitizedAgentId = sanitizeK8sNameSuffix(input.agentId);
  const deploymentName = readOptionalString(k8sConfig.deploymentName)
    ?? buildK8sResourceName(DEFAULT_DEPLOYMENT_PREFIX, sanitizedNodeId);
  const serviceName = readOptionalString(k8sConfig.serviceName) ?? deploymentName;
  const secretName = readOptionalString(k8sConfig.secretName)
    ?? buildK8sResourceName('matchaclaw-runtime-agent-enrollment', sanitizedNodeId);
  const image = readOptionalString(k8sConfig.image) ?? DEFAULT_IMAGE;
  const runtimeAgentPortResult = readRuntimeAgentPort(k8sConfig.runtimeAgentPort);
  if (runtimeAgentPortResult.resultType === 'invalid') return runtimeAgentPortResult;

  const nameIssue = validateK8sResourceNames({ namespace, deploymentName, serviceName, secretName });
  if (nameIssue) return invalid(nameIssue);

  return {
    resultType: 'valid',
    config: {
      apiServerUrl,
      namespace,
      deploymentName,
      serviceName,
      secretName,
      image,
      runtimeAgentPort: runtimeAgentPortResult.port,
      sanitizedNodeId,
      sanitizedAgentId,
      ...(kubeBearerTokenSecretRef ? { kubeBearerTokenSecretRef } : {}),
    },
  };
}

export function readRemoteFleetK8sTerminalConfig(
  publicConfig: Readonly<Record<string, unknown>>,
  input: { readonly nodeId?: string } = {},
): RemoteFleetK8sConfigResult<RemoteFleetK8sTerminalConfig> {
  return readRemoteFleetK8sTerminalProviderConfig({
    nodePublicConfig: publicConfig,
    nodeId: input.nodeId,
  });
}

export function readRemoteFleetK8sTerminalProviderConfig(input: {
  readonly connectionPublicConfig?: Readonly<Record<string, unknown>>;
  readonly connectionSecretRefs?: RemoteFleetK8sProviderSecretRefs;
  readonly environmentPublicConfig?: Readonly<Record<string, unknown>>;
  readonly environmentSecretRefs?: RemoteFleetK8sProviderSecretRefs;
  readonly nodePublicConfig: Readonly<Record<string, unknown>>;
  readonly nodeSecretRefs?: RemoteFleetK8sProviderSecretRefs;
  readonly nodeId?: string;
}): RemoteFleetK8sConfigResult<RemoteFleetK8sTerminalProviderConfig> {
  const mergedConfigResult = readRemoteFleetK8sProviderConfigParts(input);
  if (mergedConfigResult.resultType === 'invalid') return mergedConfigResult;

  const { k8sConfig, apiServerUrl, namespace, kubeBearerTokenSecretRef } = mergedConfigResult.config;
  if (!isK8sDnsLabel(namespace)) {
    return invalid('Kubernetes namespace must be a valid DNS label.');
  }

  const podNameResult = readOptionalK8sPathSegment(k8sConfig.podName, 'Kubernetes podName');
  if (podNameResult.resultType === 'invalid') return podNameResult;

  const containerNameResult = readOptionalK8sPathSegment(k8sConfig.containerName, 'Kubernetes containerName');
  if (containerNameResult.resultType === 'invalid') return containerNameResult;

  const labelSelectorResult = readOptionalK8sLabelSelector(k8sConfig.labelSelector);
  if (labelSelectorResult.resultType === 'invalid') return labelSelectorResult;

  const labelSelector = labelSelectorResult.value ?? (input.nodeId ? buildRuntimeAgentLabelSelector(input.nodeId) : undefined);
  if (!podNameResult.value && !labelSelector) {
    return invalid('Kubernetes publicConfig.k8s.podName or labelSelector is required for terminal sessions.');
  }

  const terminalConfig = readRecord(k8sConfig.terminal);
  const terminalCommandResult = readTerminalCommand(terminalConfig.command);
  if (terminalCommandResult.resultType === 'invalid') return terminalCommandResult;

  return {
    resultType: 'valid',
    config: {
      apiServerUrl,
      namespace,
      ...(podNameResult.value ? { podName: podNameResult.value } : {}),
      ...(containerNameResult.value ? { containerName: containerNameResult.value } : {}),
      ...(labelSelector ? { labelSelector } : {}),
      terminalCommand: terminalCommandResult.command,
      ...(kubeBearerTokenSecretRef ? { kubeBearerTokenSecretRef } : {}),
    },
  };
}

export function buildK8sApiUrl(apiServerUrl: string, path: string): string {
  return new URL(path, apiServerUrl).toString();
}

export function buildK8sWebSocketUrl(apiServerUrl: string, path: string): string {
  const url = new URL(path, apiServerUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function k8sPathSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function readRemoteFleetK8sProviderConfigParts(input: {
  readonly connectionPublicConfig?: Readonly<Record<string, unknown>>;
  readonly connectionSecretRefs?: RemoteFleetK8sProviderSecretRefs;
  readonly environmentPublicConfig?: Readonly<Record<string, unknown>>;
  readonly environmentSecretRefs?: RemoteFleetK8sProviderSecretRefs;
  readonly nodePublicConfig: Readonly<Record<string, unknown>>;
  readonly nodeSecretRefs?: RemoteFleetK8sProviderSecretRefs;
}): RemoteFleetK8sConfigResult<{
  readonly k8sConfig: Readonly<Record<string, unknown>>;
  readonly apiServerUrl: string;
  readonly namespace: string;
  readonly kubeBearerTokenSecretRef?: string;
}> {
  const connectionUnsafePublicConfigKey = input.connectionPublicConfig
    ? findUnsafeRemoteFleetPublicConfigKey(input.connectionPublicConfig)
    : undefined;
  if (connectionUnsafePublicConfigKey) {
    return invalid(`Remote Fleet Kubernetes connection publicConfig contains unsafe credential material at ${connectionUnsafePublicConfigKey}.`);
  }

  const environmentUnsafePublicConfigKey = input.environmentPublicConfig
    ? findUnsafeRemoteFleetPublicConfigKey(input.environmentPublicConfig)
    : undefined;
  if (environmentUnsafePublicConfigKey) {
    return invalid(`Remote Fleet Kubernetes environment publicConfig contains unsafe credential material at ${environmentUnsafePublicConfigKey}.`);
  }

  const nodeUnsafePublicConfigKey = findUnsafeRemoteFleetPublicConfigKey(input.nodePublicConfig);
  if (nodeUnsafePublicConfigKey) {
    return invalid(`Remote Fleet Kubernetes node publicConfig contains unsafe credential material at ${nodeUnsafePublicConfigKey}.`);
  }

  const connectionK8sConfig = readRecord(input.connectionPublicConfig?.k8s);
  const environmentK8sConfig = input.environmentPublicConfig
    ? readRecord(input.environmentPublicConfig.k8s)
    : undefined;
  const nodeK8sConfig = readRecord(input.nodePublicConfig.k8s);
  const k8sConfig = mergeK8sConfig(nodeK8sConfig, connectionK8sConfig, environmentK8sConfig);
  const apiServerUrlResult = readRemoteFleetK8sApiServerUrl(
    connectionK8sConfig.apiServerUrl ?? nodeK8sConfig.apiServerUrl,
  );
  if (apiServerUrlResult.resultType === 'invalid') return apiServerUrlResult;

  const namespace = readOptionalString(k8sConfig.namespace)
    ?? readOptionalString(connectionK8sConfig.defaultNamespace)
    ?? DEFAULT_NAMESPACE;
  const kubeBearerTokenSecretRefResult = readKubeBearerTokenSecretRef(input);
  if (kubeBearerTokenSecretRefResult.resultType === 'invalid') return kubeBearerTokenSecretRefResult;

  return {
    resultType: 'valid',
    config: {
      k8sConfig,
      apiServerUrl: apiServerUrlResult.apiServerUrl,
      namespace,
      ...(kubeBearerTokenSecretRefResult.secretRef ? { kubeBearerTokenSecretRef: kubeBearerTokenSecretRefResult.secretRef } : {}),
    },
  };
}

function mergeK8sConfig(
  nodeK8sConfig: Readonly<Record<string, unknown>>,
  connectionK8sConfig: Readonly<Record<string, unknown>>,
  environmentK8sConfig: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  return {
    ...nodeK8sConfig,
    ...connectionK8sConfig,
    ...(environmentK8sConfig ?? {}),
  };
}

function readKubeBearerTokenSecretRef(input: {
  readonly connectionSecretRefs?: RemoteFleetK8sProviderSecretRefs;
  readonly environmentSecretRefs?: RemoteFleetK8sProviderSecretRefs;
  readonly nodeSecretRefs?: RemoteFleetK8sProviderSecretRefs;
}): { readonly resultType: 'valid'; readonly secretRef?: string } | { readonly resultType: 'invalid'; readonly message: string } {
  const environmentSecretRef = readOptionalValidSecretRef(input.environmentSecretRefs, REMOTE_FLEET_KUBE_BEARER_TOKEN_SECRET_REF_NAME);
  if (environmentSecretRef.resultType === 'invalid') return environmentSecretRef;
  if (environmentSecretRef.secretRef) return environmentSecretRef;

  const connectionSecretRef = readOptionalValidSecretRef(input.connectionSecretRefs, REMOTE_FLEET_KUBE_BEARER_TOKEN_SECRET_REF_NAME);
  if (connectionSecretRef.resultType === 'invalid') return connectionSecretRef;
  if (connectionSecretRef.secretRef) return connectionSecretRef;

  const nodeSecretRef = readOptionalValidSecretRef(input.nodeSecretRefs, REMOTE_FLEET_KUBE_BEARER_TOKEN_SECRET_REF_NAME);
  if (nodeSecretRef.resultType === 'invalid') return nodeSecretRef;
  return nodeSecretRef;
}

function readOptionalValidSecretRef(
  secretRefs: RemoteFleetK8sProviderSecretRefs | undefined,
  secretRefName: string,
): { readonly resultType: 'valid'; readonly secretRef?: string } | { readonly resultType: 'invalid'; readonly message: string } {
  const value = secretRefs?.[secretRefName];
  if (value === undefined) return { resultType: 'valid' };
  if (value.kind !== 'secret-ref' || typeof value.ref !== 'string' || value.ref.trim().length === 0) {
    return invalid(`Kubernetes ${secretRefName} secretRef is invalid.`);
  }
  return { resultType: 'valid', secretRef: value.ref.trim() };
}

function readRemoteFleetK8sApiServerUrl(value: unknown):
  | { readonly resultType: 'valid'; readonly apiServerUrl: string }
  | { readonly resultType: 'invalid'; readonly message: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalid('Kubernetes publicConfig.k8s.apiServerUrl is required.');
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') {
      return invalid('Kubernetes apiServerUrl must use https.');
    }
    if (url.username || url.password || url.search || url.hash) {
      return invalid('Kubernetes apiServerUrl must not include credentials, query, or fragment data.');
    }
    if (url.pathname !== '/' && url.pathname !== '') {
      return invalid('Kubernetes apiServerUrl must be an origin URL without a path.');
    }
    return { resultType: 'valid', apiServerUrl: url.origin };
  } catch {
    return invalid('Kubernetes publicConfig.k8s.apiServerUrl must be a valid URL.');
  }
}

function validateK8sResourceNames(input: {
  readonly namespace: string;
  readonly deploymentName: string;
  readonly serviceName: string;
  readonly secretName: string;
}): string | undefined {
  if (!isK8sDnsLabel(input.namespace)) return 'Kubernetes namespace must be a valid DNS label.';
  if (!isK8sDnsLabel(input.deploymentName)) return 'Kubernetes deploymentName must be a valid DNS label.';
  if (!isK8sDnsLabel(input.serviceName)) return 'Kubernetes serviceName must be a valid DNS label.';
  if (!isK8sDnsLabel(input.secretName)) return 'Kubernetes secretName must be a valid DNS label.';
  return undefined;
}

export function buildK8sResourceName(prefix: string, sanitizedSuffix: string): string {
  const maxSuffixLength = Math.max(1, 63 - prefix.length - 1);
  return trimDnsLabel(`${prefix}-${trimDnsLabel(sanitizedSuffix).slice(0, maxSuffixLength)}`);
}

function sanitizeK8sNameSuffix(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return trimDnsLabel(normalized) || 'node';
}

function buildRuntimeAgentLabelSelector(nodeId: string): string {
  return `app.kubernetes.io/name=matchaclaw-runtime-agent,matchaclaw.ai/node-id=${sanitizeK8sNameSuffix(nodeId)}`;
}

function trimDnsLabel(value: string): string {
  return value.replace(/^-+/, '').replace(/-+$/, '') || 'node';
}

function isK8sDnsLabel(value: string): boolean {
  return value.length >= 1
    && value.length <= 63
    && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value);
}

function readOptionalK8sPathSegment(value: unknown, label: string):
  | { readonly resultType: 'valid'; readonly value?: string }
  | { readonly resultType: 'invalid'; readonly message: string } {
  if (value === undefined) return { resultType: 'valid' };
  if (typeof value !== 'string') {
    return invalid(`${label} must be a string path segment.`);
  }

  const trimmed = value.trim();
  if (!isSafeK8sPathSegment(trimmed)) {
    return invalid(`${label} must be a non-empty Kubernetes path segment without slash, query, fragment, or control characters.`);
  }
  return { resultType: 'valid', value: trimmed };
}

function isSafeK8sPathSegment(value: string): boolean {
  return value.length > 0
    && value.length <= 253
    && value !== '.'
    && value !== '..'
    && !/[\\/?# -]/.test(value);
}

function readOptionalK8sLabelSelector(value: unknown):
  | { readonly resultType: 'valid'; readonly value?: string }
  | { readonly resultType: 'invalid'; readonly message: string } {
  if (value === undefined) return { resultType: 'valid' };
  if (typeof value !== 'string') {
    return invalid('Kubernetes labelSelector must be a string.');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512 || /[ -]/.test(trimmed)) {
    return invalid('Kubernetes labelSelector must be 1-512 characters without control characters.');
  }
  return { resultType: 'valid', value: trimmed };
}

function readTerminalCommand(value: unknown):
  | { readonly resultType: 'valid'; readonly command: readonly string[] }
  | { readonly resultType: 'invalid'; readonly message: string } {
  if (value === undefined) return { resultType: 'valid', command: DEFAULT_K8S_TERMINAL_COMMAND };
  if (typeof value === 'string') return readTerminalCommandParts([value]);
  if (Array.isArray(value)) return readTerminalCommandParts(value);
  return invalid('Kubernetes publicConfig.k8s.terminal.command must be a string or string array.');
}

function readTerminalCommandParts(value: readonly unknown[]):
  | { readonly resultType: 'valid'; readonly command: readonly string[] }
  | { readonly resultType: 'invalid'; readonly message: string } {
  if (value.length === 0) {
    return invalid('Kubernetes publicConfig.k8s.terminal.command must not be empty.');
  }

  const command: string[] = [];
  for (const part of value) {
    if (typeof part !== 'string') {
      return invalid('Kubernetes publicConfig.k8s.terminal.command entries must be strings.');
    }
    const trimmed = part.trim();
    if (trimmed.length === 0 || trimmed.length > 4096 || /[ -]/.test(trimmed)) {
      return invalid('Kubernetes publicConfig.k8s.terminal.command entries must be 1-4096 characters without control characters.');
    }
    command.push(trimmed);
  }
  return { resultType: 'valid', command };
}

function readRuntimeAgentPort(value: unknown):
  | { readonly resultType: 'valid'; readonly port: number }
  | { readonly resultType: 'invalid'; readonly message: string } {
  if (value === undefined) return { resultType: 'valid', port: DEFAULT_RUNTIME_AGENT_PORT };
  if (typeof value !== 'number' || !isK8sPort(value)) {
    return invalid('Kubernetes runtimeAgentPort must be an integer from 1 to 65535.');
  }
  return { resultType: 'valid', port: value };
}

function isK8sPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid<T>(message: string): RemoteFleetK8sConfigResult<T> {
  return { resultType: 'invalid', message };
}
