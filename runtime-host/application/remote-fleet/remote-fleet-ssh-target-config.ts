import type {
  RemoteFleetConnectionRecord,
  RemoteFleetNodeRecord,
  RemoteFleetSecretRef,
} from './remote-fleet-model';
import { findUnsafeRemoteFleetPublicConfigKey } from './remote-fleet-command-policy';

export const REMOTE_FLEET_SSH_PRIVATE_KEY_SECRET_REF_NAME = 'sshPrivateKey' as const;
export const REMOTE_FLEET_SSH_PASSWORD_SECRET_REF_NAME = 'sshPassword' as const;
export const REMOTE_FLEET_DEFAULT_SSH_INSTALL_COMMAND = ': "${MATCHACLAW_ENROLLMENT_TOKEN:?missing enrollment token}"; echo matchaclaw-runtime-agent-bootstrap-ready';

export type RemoteFleetSshAuthSecretRefName =
  | typeof REMOTE_FLEET_SSH_PRIVATE_KEY_SECRET_REF_NAME
  | typeof REMOTE_FLEET_SSH_PASSWORD_SECRET_REF_NAME;

export type RemoteFleetSshAuthKind = 'private-key' | 'password';

export interface RemoteFleetSshTargetConfig {
  readonly host: string;
  readonly port?: number;
  readonly username?: string;
  readonly installCommand: string;
}

export interface RemoteFleetSshAuthSecretRef {
  readonly authKind: RemoteFleetSshAuthKind;
  readonly secretRefName: RemoteFleetSshAuthSecretRefName;
  readonly secretRef: RemoteFleetSecretRef;
}

export type RemoteFleetSshTargetConfigReadResult =
  | { readonly resultType: 'valid'; readonly config: RemoteFleetSshTargetConfig }
  | { readonly resultType: 'failed'; readonly reason: 'unsupported-target' | 'invalid-config'; readonly message: string };

export type RemoteFleetSshAuthSecretRefReadResult =
  | { readonly resultType: 'valid'; readonly auth: RemoteFleetSshAuthSecretRef }
  | { readonly resultType: 'failed'; readonly reason: 'missing-secret'; readonly message: string };

export function readRemoteFleetSshTargetConfig(
  node: Pick<RemoteFleetNodeRecord, 'targetKind' | 'endpointUrl' | 'publicConfig'>,
  options: { readonly operationLabel?: 'bootstrap' | 'terminal' } = {},
): RemoteFleetSshTargetConfigReadResult {
  if (node.targetKind !== 'ssh-host' && node.targetKind !== 'vm') {
    return {
      resultType: 'failed',
      reason: 'unsupported-target',
      message: 'Remote Fleet SSH target config only supports ssh-host and vm targets.',
    };
  }

  const unsafePublicConfigKey = findUnsafeRemoteFleetPublicConfigKey(node.publicConfig);
  if (unsafePublicConfigKey) {
    return invalidConfig(`Remote Fleet publicConfig must not contain plaintext credential key ${unsafePublicConfigKey}.`);
  }

  const endpointRead = readEndpointUrl(node.endpointUrl);
  if (endpointRead.resultType === 'failed') return invalidConfig(endpointRead.message);

  const publicConfigKey = remoteFleetSshPublicConfigKeyForTarget(node.targetKind);
  const rawSshConfig = node.publicConfig[publicConfigKey];
  if (rawSshConfig !== undefined && !isRecord(rawSshConfig)) {
    return invalidConfig(`Remote Fleet SSH publicConfig.${publicConfigKey} must be an object.`);
  }
  const sshConfig = isRecord(rawSshConfig) ? rawSshConfig : {};

  const hostRead = readOptionalString(sshConfig.host);
  const host = hostRead ?? endpointRead.host;
  if (!host) {
    const operationLabel = options.operationLabel ?? 'bootstrap';
    return invalidConfig(`Remote Fleet SSH ${operationLabel} requires publicConfig.${publicConfigKey}.host or ssh:// endpointUrl.`);
  }
  if (!isSafeSshHost(host)) {
    return invalidConfig('Remote Fleet SSH host must be a hostname or IP address without credentials.');
  }

  const portRead = readPort(sshConfig.port, endpointRead.port);
  if (portRead.resultType === 'failed') return invalidConfig(portRead.message);

  const usernameRead = readOptionalString(sshConfig.username);
  if (usernameRead && !isSafeSshUsername(usernameRead)) {
    return invalidConfig('Remote Fleet SSH username must not contain whitespace or @.');
  }

  const installCommandRead = readInstallCommand(sshConfig.installCommand, publicConfigKey);
  if (installCommandRead.resultType === 'failed') return invalidConfig(installCommandRead.message);

  return {
    resultType: 'valid',
    config: {
      host,
      ...(portRead.port === undefined ? {} : { port: portRead.port }),
      ...(usernameRead ?? endpointRead.username ? { username: usernameRead ?? endpointRead.username } : {}),
      installCommand: installCommandRead.command,
    },
  };
}

export function readRemoteFleetSshConnectionConfig(
  input: {
    readonly connection: Pick<RemoteFleetConnectionRecord, 'connectionKind' | 'endpointUrl' | 'publicConfig'>;
    readonly targetKind: Extract<RemoteFleetNodeRecord['targetKind'], 'ssh-host' | 'vm'>;
  },
  options: { readonly operationLabel?: 'bootstrap' | 'terminal' } = {},
): RemoteFleetSshTargetConfigReadResult {
  if (input.connection.connectionKind !== input.targetKind) {
    return {
      resultType: 'failed',
      reason: 'unsupported-target',
      message: 'Remote Fleet SSH connection kind does not match its target kind.',
    };
  }
  return readRemoteFleetSshTargetConfig({
    targetKind: input.targetKind,
    ...(input.connection.endpointUrl ? { endpointUrl: input.connection.endpointUrl } : {}),
    publicConfig: input.connection.publicConfig,
  }, options);
}

export function readRemoteFleetSshConnectionAuthSecretRef(
  connection: Pick<RemoteFleetConnectionRecord, 'secretRefs'>,
  options: { readonly operationLabel?: 'bootstrap' | 'terminal' } = {},
): RemoteFleetSshAuthSecretRefReadResult {
  return readRemoteFleetSshAuthSecretRef(connection, options);
}

export function readRemoteFleetSshAuthSecretRef(
  node: Pick<RemoteFleetNodeRecord | RemoteFleetConnectionRecord, 'secretRefs'>,
  options: { readonly operationLabel?: 'bootstrap' | 'terminal' } = {},
): RemoteFleetSshAuthSecretRefReadResult {
  const privateKeyRef = node.secretRefs[REMOTE_FLEET_SSH_PRIVATE_KEY_SECRET_REF_NAME];
  if (isValidSecretRef(privateKeyRef)) {
    return {
      resultType: 'valid',
      auth: {
        authKind: 'private-key',
        secretRefName: REMOTE_FLEET_SSH_PRIVATE_KEY_SECRET_REF_NAME,
        secretRef: privateKeyRef,
      },
    };
  }

  const passwordRef = node.secretRefs[REMOTE_FLEET_SSH_PASSWORD_SECRET_REF_NAME];
  if (isValidSecretRef(passwordRef)) {
    return {
      resultType: 'valid',
      auth: {
        authKind: 'password',
        secretRefName: REMOTE_FLEET_SSH_PASSWORD_SECRET_REF_NAME,
        secretRef: passwordRef,
      },
    };
  }

  const operationLabel = options.operationLabel ?? 'bootstrap';
  return {
    resultType: 'failed',
    reason: 'missing-secret',
    message: `Remote Fleet SSH ${operationLabel} requires secretRef sshPrivateKey or sshPassword.`,
  };
}

export function remoteFleetSshPublicConfigKeyForTarget(targetKind: RemoteFleetNodeRecord['targetKind']): 'ssh' | 'vm' {
  return targetKind === 'vm' ? 'vm' : 'ssh';
}

function readEndpointUrl(endpointUrl: string | undefined):
  | { readonly resultType: 'valid'; readonly host?: string; readonly port?: number; readonly username?: string }
  | { readonly resultType: 'failed'; readonly message: string } {
  const trimmed = endpointUrl?.trim();
  if (!trimmed) return { resultType: 'valid' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { resultType: 'failed', message: 'Remote Fleet SSH endpointUrl must be a valid ssh:// URL.' };
  }

  if (url.protocol !== 'ssh:') {
    return { resultType: 'failed', message: 'Remote Fleet SSH endpointUrl must use the ssh:// scheme.' };
  }
  if (url.password.length > 0) {
    return { resultType: 'failed', message: 'Remote Fleet SSH endpointUrl must not include a password.' };
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { resultType: 'failed', message: 'Remote Fleet SSH endpointUrl must only contain user, host, and port.' };
  }

  const portRead = readPort(url.port.length > 0 ? Number(url.port) : undefined, undefined);
  if (portRead.resultType === 'failed') return portRead;

  const username = url.username ? decodeURIComponent(url.username) : undefined;
  if (username && !isSafeSshUsername(username)) {
    return { resultType: 'failed', message: 'Remote Fleet SSH endpointUrl username must not contain whitespace or @.' };
  }

  return {
    resultType: 'valid',
    host: url.hostname,
    ...(portRead.port === undefined ? {} : { port: portRead.port }),
    ...(username ? { username } : {}),
  };
}

function readPort(value: unknown, fallback: number | undefined):
  | { readonly resultType: 'valid'; readonly port?: number }
  | { readonly resultType: 'failed'; readonly message: string } {
  if (value === undefined) return { resultType: 'valid', ...(fallback === undefined ? {} : { port: fallback }) };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    return { resultType: 'failed', message: 'Remote Fleet SSH port must be an integer from 1 to 65535.' };
  }
  return { resultType: 'valid', port: value };
}

function readInstallCommand(
  value: unknown,
  publicConfigKey: 'ssh' | 'vm',
):
  | { readonly resultType: 'valid'; readonly command: string }
  | { readonly resultType: 'failed'; readonly message: string } {
  if (value === undefined) return { resultType: 'valid', command: REMOTE_FLEET_DEFAULT_SSH_INSTALL_COMMAND };
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { resultType: 'failed', message: `Remote Fleet SSH publicConfig.${publicConfigKey}.installCommand must be a non-empty string.` };
  }
  return { resultType: 'valid', command: value.trim() };
}

function invalidConfig(message: string): RemoteFleetSshTargetConfigReadResult {
  return { resultType: 'failed', reason: 'invalid-config', message };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isValidSecretRef(value: RemoteFleetSecretRef | undefined): value is RemoteFleetSecretRef {
  return value?.kind === 'secret-ref' && typeof value.ref === 'string' && value.ref.trim().length > 0;
}

function isSafeSshHost(host: string): boolean {
  return host.trim().length > 0
    && !host.startsWith('-')
    && !host.includes('://')
    && !host.includes('@')
    && !host.includes('/')
    && !/\s/.test(host);
}

function isSafeSshUsername(username: string): boolean {
  return username.trim().length > 0
    && !username.startsWith('-')
    && !username.includes('@')
    && !username.includes('/')
    && !/\s/.test(username);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
