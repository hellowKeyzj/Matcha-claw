import type { FleetRegistrationTarget } from '../extensions';
import type {
  RemoteFleetConnectionRegistration,
  RemoteFleetConnectionSummary,
  RemoteFleetEnvironmentRegistration,
  RemoteFleetNodeTargetKind,
  RemoteFleetSecretRef,
} from '../store';

export type SshAuthMethod = 'password' | 'private-key';
export type ContainerAuthMethod = 'none' | 'bearer-token';
export type VmAuthMethod = 'password' | 'private-key';

export type FleetRegistrationFormState = {
  id: string;
  displayName: string;
  targetKind: RemoteFleetNodeTargetKind;
  endpointUrl: string;
  containerName: string;
  containerImage: string;
  containerImageCandidates: string;
  sshHost: string;
  sshPort: string;
  sshUsername: string;
  sshAuthMethod: SshAuthMethod;
  sshPassword: string;
  sshPrivateKey: string;
  containerAuthMethod: ContainerAuthMethod;
  containerBearerToken: string;
  k8sApiServerUrl: string;
  k8sNamespace: string;
  k8sBearerToken: string;
  vmHost: string;
  vmPort: string;
  vmUsername: string;
  vmAuthMethod: VmAuthMethod;
  vmPassword: string;
  vmPrivateKey: string;
  labels: string;
  enabled: boolean;
  publicConfig: string;
  secretRefs: string;
};

export const EMPTY_NODE_FORM: FleetRegistrationFormState = {
  id: '',
  displayName: '',
  targetKind: 'ssh-host',
  endpointUrl: '',
  containerName: '',
  containerImage: '',
  containerImageCandidates: '',
  sshHost: '',
  sshPort: '',
  sshUsername: '',
  sshAuthMethod: 'password',
  sshPassword: '',
  sshPrivateKey: '',
  containerAuthMethod: 'none',
  containerBearerToken: '',
  k8sApiServerUrl: '',
  k8sNamespace: '',
  k8sBearerToken: '',
  vmHost: '',
  vmPort: '',
  vmUsername: '',
  vmAuthMethod: 'password',
  vmPassword: '',
  vmPrivateKey: '',
  labels: '',
  enabled: true,
  publicConfig: '',
  secretRefs: '',
};

const PUBLIC_CONFIG_SECRET_KEY_PATTERN = /(?:token|password|authorization|api[-_]?key|secret|credential|private[-_]?key|ssh[-_]?private[-_]?key)/i;
const CONTAINER_IMAGE_SECRET_PATTERN = /(?:authorization\s*[:=]|bearer\s+[a-z0-9._~+/=-]+|:\/\/[^/\s]+:[^@\s]+@|(?:token|password|api[-_]?key|secret|credential)\s*[=:])/i;
export const REGISTRATION_ERROR_KEY_PREFIX = 'remoteFleet.registration.errors.';

function parseLabels(value: string): string[] | undefined {
  const items = value.split(/[\n,，]+/).map((label) => label.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function assertSafeContainerImageValue(value: string): void {
  if (CONTAINER_IMAGE_SECRET_PATTERN.test(value)) {
    throw new Error('remoteFleet.registration.errors.containerImageSensitive');
  }
}

export function parseOptionalContainerImage(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  assertSafeContainerImageValue(trimmed);
  return trimmed;
}

export function parseContainerImageCandidates(value: string): string[] | undefined {
  const items = value.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean);
  for (const item of items) {
    assertSafeContainerImageValue(item);
  }
  return items.length > 0 ? items : undefined;
}

function parseSecretRefMap(value: string): Record<string, RemoteFleetSecretRef> | undefined {
  const entries = value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (entries.length === 0) {
    return undefined;
  }

  const result: Record<string, RemoteFleetSecretRef> = {};
  for (const entry of entries) {
    const separatorIndex = entry.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error('remoteFleet.registration.errors.secretRefFormat');
    }
    const key = entry.slice(0, separatorIndex).trim();
    const ref = entry.slice(separatorIndex + 1).trim();
    if (!key || !ref) {
      throw new Error('remoteFleet.registration.errors.secretRefRequired');
    }
    result[key] = { kind: 'secret-ref', ref };
  }
  return result;
}

function mergeSecretRefs(
  base: Record<string, RemoteFleetSecretRef> | undefined,
  typed: Record<string, RemoteFleetSecretRef> | undefined,
): Record<string, RemoteFleetSecretRef> | undefined {
  return undefinedIfEmpty(withoutUndefined({ ...(base ?? {}), ...(typed ?? {}) }));
}

export function nodeCredentialId(form: FleetRegistrationFormState): string {
  const seed = form.id
    || form.displayName
    || form.sshHost
    || form.vmHost
    || form.endpointUrl
    || form.k8sApiServerUrl
    || 'remote-node';
  const normalized = seed.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(normalized) ? normalized : 'remote-node';
}

function hasSensitivePublicConfigKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(hasSensitivePublicConfigKey);
  }

  return Object.entries(value).some(([key, nestedValue]) => {
    return PUBLIC_CONFIG_SECRET_KEY_PATTERN.test(key) || hasSensitivePublicConfigKey(nestedValue);
  });
}

function parsePublicConfig(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error('remoteFleet.registration.errors.publicConfigJson');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('remoteFleet.registration.errors.publicConfigObject');
  }
  if (hasSensitivePublicConfigKey(parsed)) {
    throw new Error('remoteFleet.registration.errors.publicConfigSecret');
  }
  return parsed as Record<string, unknown>;
}

export function parseOptionalPort(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const port = Number(trimmed);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('remoteFleet.registration.errors.portNumber');
  }
  return port;
}

export function isDockerLoopbackHttps2375Endpoint(endpointUrl: string): boolean {
  try {
    const url = new URL(endpointUrl);
    return url.protocol === 'https:'
      && url.port === '2375'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}

export function parseOptionalK8sApiServerUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      throw new Error('remoteFleet.registration.errors.k8sApiServerHttps');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) {
      throw new Error('remoteFleet.registration.errors.k8sApiServerOrigin');
    }
    return parsed.origin;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(REGISTRATION_ERROR_KEY_PREFIX)) {
      throw error;
    }
    throw new Error('remoteFleet.registration.errors.k8sApiServerOrigin', { cause: error });
  }
}

export function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

export function undefinedIfEmpty<T extends Record<string, unknown>>(input: T): T | undefined {
  return Object.keys(input).length > 0 ? input : undefined;
}

export function sshEndpointUrl(host: string, port?: number): string | undefined {
  const trimmedHost = host.trim();
  if (!trimmedHost) {
    return undefined;
  }

  return port ? `ssh://${trimmedHost}:${port}` : `ssh://${trimmedHost}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergePublicConfig(
  publicConfig: Record<string, unknown> | undefined,
  typedConfig: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = { ...(publicConfig ?? {}) };
  for (const [key, value] of Object.entries(typedConfig)) {
    if (value === undefined) continue;
    merged[key] = isPlainRecord(merged[key]) && isPlainRecord(value)
      ? { ...merged[key], ...value }
      : value;
  }
  return undefinedIfEmpty(withoutUndefined(merged));
}

export function connectionRegistration(
  form: FleetRegistrationFormState,
  target: FleetRegistrationTarget,
  credentialSecretRefs?: Record<string, RemoteFleetSecretRef>,
): RemoteFleetConnectionRegistration {
  const publicConfig = parsePublicConfig(form.publicConfig);
  const advancedSecretRefs = parseSecretRefMap(form.secretRefs);
  const connection = target.connection(form);

  return withoutUndefined({
    id: form.id.trim() || undefined,
    displayName: form.displayName.trim() || displayNameFromEndpointUrl(connection.displayNameSeed) || undefined,
    connectionKind: form.targetKind,
    targetKind: form.targetKind,
    endpointUrl: connection.endpointUrl,
    labels: parseLabels(form.labels),
    enabled: form.enabled,
    publicConfig: mergePublicConfig(publicConfig, connection.publicConfig),
    secretRefs: mergeSecretRefs(advancedSecretRefs, credentialSecretRefs),
  });
}

export function environmentRegistration(
  form: FleetRegistrationFormState,
  target: FleetRegistrationTarget,
  connectionId: string,
): RemoteFleetEnvironmentRegistration {
  const environment = target.environment(form);

  return withoutUndefined({
    connectionId,
    displayName: form.displayName.trim() || displayNameFromEndpointUrl(environment.displayNameSeed) || undefined,
    environmentKind: environment.environmentKind,
    targetKind: form.targetKind,
    labels: parseLabels(form.labels),
    enabled: form.enabled,
    publicConfig: undefinedIfEmpty(withoutUndefined(environment.publicConfig)),
  });
}

export function displayNameFromEndpointUrl(endpointUrl: string): string {
  const trimmed = endpointUrl.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || trimmed;
  } catch {
    return trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/:?#]/)[0] || trimmed;
  }
}

export function clearCredentialDrafts(form: FleetRegistrationFormState): FleetRegistrationFormState {
  return {
    ...form,
    sshPassword: '',
    sshPrivateKey: '',
    containerBearerToken: '',
    k8sBearerToken: '',
    vmPassword: '',
    vmPrivateKey: '',
  };
}

export function sshFormValuesFromEndpoint(endpointUrl: string | undefined): Pick<FleetRegistrationFormState, 'sshHost' | 'sshPort' | 'sshUsername'> {
  if (!endpointUrl) {
    return { sshHost: '', sshPort: '', sshUsername: '' };
  }

  try {
    const endpoint = new URL(endpointUrl);
    if (endpoint.protocol !== 'ssh:') {
      return { sshHost: '', sshPort: '', sshUsername: '' };
    }
    return {
      sshHost: endpoint.hostname,
      sshPort: endpoint.port,
      sshUsername: endpoint.username ? decodeURIComponent(endpoint.username) : '',
    };
  } catch {
    return { sshHost: '', sshPort: '', sshUsername: '' };
  }
}

export function formFromEditingConnection(
  connection: RemoteFleetConnectionSummary,
  target: FleetRegistrationTarget,
): FleetRegistrationFormState {
  return {
    ...EMPTY_NODE_FORM,
    id: connection.id,
    displayName: connection.displayName ?? '',
    targetKind: target.kind,
    endpointUrl: connection.endpointUrl ?? '',
    ...target.fromConnection(connection),
    labels: connection.labels?.join(', ') ?? '',
    enabled: connection.enabled ?? true,
  };
}
