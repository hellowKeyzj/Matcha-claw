import type { RemoteFleetConnectorCommand, RemoteFleetConnectorCommandKind } from './remote-fleet-connectors';
import type {
  RemoteFleetNodeHealthState,
  RemoteFleetNodeRecord,
  RemoteFleetNodeTargetKind,
  RemoteFleetRuntimeKind,
  RemoteFleetSecretRef,
  RuntimeInstanceRecord,
} from './remote-fleet-model';

export type RemoteFleetCommandPolicyCommandKind =
  | RemoteFleetConnectorCommandKind
  | 'upgrade-agent'
  | 'mount-workspace'
  | 'expose-port';

export interface RemoteFleetCommandPolicyNode {
  readonly id: string;
  readonly enabled: boolean;
  readonly targetKind?: RemoteFleetNodeTargetKind;
  readonly health?: RemoteFleetNodeHealthState;
  readonly publicConfig?: Readonly<Record<string, unknown>>;
  readonly secretRefs?: Readonly<Record<string, RemoteFleetSecretRef>>;
}

export interface RemoteFleetCommandPolicyRuntime {
  readonly id: string;
  readonly nodeId: string;
  readonly runtimeKind: RemoteFleetRuntimeKind | string;
}

export interface RemoteFleetSimpleCommandDto {
  readonly kind?: RemoteFleetCommandPolicyCommandKind | string;
  readonly command?: RemoteFleetCommandPolicyCommandKind | string;
  readonly nodeId?: string;
  readonly runtimeId?: string;
  readonly runtimeKind?: RemoteFleetRuntimeKind | string;
  readonly requiredSecretRefNames?: readonly string[];
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type RemoteFleetCommandPolicyCommand = RemoteFleetConnectorCommand | RemoteFleetSimpleCommandDto;

export interface RemoteFleetCommandPolicy {
  readonly supportedRuntimeKinds?: readonly string[];
  readonly requiredSecretRefNames?: readonly string[];
  readonly allowPublicPortExposure?: boolean;
  readonly allowNodePathWorkspaceMounts?: boolean;
}

export interface RemoteFleetCommandPolicyInput {
  readonly node?: RemoteFleetCommandPolicyNode | RemoteFleetNodeRecord;
  readonly runtime?: RemoteFleetCommandPolicyRuntime | RuntimeInstanceRecord;
  readonly command: RemoteFleetCommandPolicyCommand;
  readonly policy?: RemoteFleetCommandPolicy;
}

export type RemoteFleetCommandPolicyDeniedReason =
  | 'node-not-provided'
  | 'node-disabled'
  | 'unsupported-command-kind'
  | 'command-node-mismatch'
  | 'runtime-required'
  | 'runtime-node-mismatch'
  | 'command-runtime-mismatch'
  | 'unsupported-runtime-kind'
  | 'missing-secret-ref'
  | 'missing-auth-secret-ref'
  | 'unsafe-public-config-key'
  | 'invalid-port-exposure'
  | 'public-port-exposure-denied'
  | 'invalid-workspace-mount'
  | 'node-path-workspace-mount-denied';

export type RemoteFleetCommandPolicyDecision =
  | {
      readonly resultType: 'allowed';
      readonly reason: 'command-policy-accepted';
      readonly commandKind: RemoteFleetCommandPolicyCommandKind;
      readonly nodeId: string;
      readonly runtimeId?: string;
      readonly requiredSecretRefNames: readonly string[];
    }
  | {
      readonly resultType: 'denied';
      readonly reason: RemoteFleetCommandPolicyDeniedReason;
      readonly message: string;
      readonly commandKind?: string;
      readonly nodeId?: string;
      readonly runtimeId?: string;
      readonly path?: string;
      readonly secretRefName?: string;
      readonly runtimeKind?: string;
      readonly exposure?: string;
      readonly portName?: string;
    };

interface ValueCandidate {
  readonly path: string;
  readonly value: unknown;
}

const REMOTE_FLEET_COMMAND_POLICY_COMMAND_KINDS: ReadonlySet<string> = new Set([
  'probe-node',
  'install-agent',
  'upgrade-agent',
  'start-runtime',
  'stop-runtime',
  'sync-capabilities',
  'mount-workspace',
  'expose-port',
]);

const DEFAULT_SUPPORTED_RUNTIME_KINDS: readonly string[] = ['openclaw', 'matcha-agent'];
const RUNTIME_REQUIRED_COMMAND_KINDS: ReadonlySet<RemoteFleetCommandPolicyCommandKind> = new Set(['start-runtime']);
const RUNTIME_KIND_GATED_COMMAND_KINDS: ReadonlySet<RemoteFleetCommandPolicyCommandKind> = new Set([
  'start-runtime',
  'stop-runtime',
  'sync-capabilities',
]);
const DEFAULT_SSH_SECRET_COMMAND_KINDS: ReadonlySet<RemoteFleetCommandPolicyCommandKind> = new Set([
  'install-agent',
  'upgrade-agent',
]);
const PORT_EXPOSURE_VALUES: ReadonlySet<string> = new Set(['loopback', 'node-private', 'fleet-private', 'public']);
const WORKSPACE_MOUNT_SOURCE_KINDS: ReadonlySet<string> = new Set(['workspace-ref', 'node-path', 'ephemeral-volume']);
const UNSAFE_PUBLIC_CONFIG_KEY_PATTERNS = [
  'authorization',
  'bearertoken',
  'apikey',
  'password',
  'passwd',
  'plaintextsecret',
  'plaintextsecretvalue',
  'privatekey',
  'secret',
  'secrets',
  'secretvalue',
  'sshprivatekey',
  'token',
];
const PUBLIC_CONFIG_SECRET_REFERENCE_KEYS: ReadonlySet<string> = new Set([
  'apikeyenv',
  'placeholder',
  'secretenv',
  'secretplaceholder',
  'secretplaceholders',
  'secretref',
  'secretrefname',
  'secretrefnames',
]);
const PUBLIC_CONFIG_SECRET_VALUE_KEY_FRAGMENT = String.raw`[\w.-]*(?:authorization|api[-_]?key|secret|token|password)[\w.-]*`;
const PUBLIC_CONFIG_AUTHORIZATION_SCHEME_VALUE_PATTERN = /\bauthorization\s*[:=]\s*["']?(?:bearer|basic|token)\s+[^"',;&\s]+/i;
const PUBLIC_CONFIG_SECRET_QUOTED_ASSIGNMENT_VALUE_PATTERN = new RegExp(
  String.raw`\b${PUBLIC_CONFIG_SECRET_VALUE_KEY_FRAGMENT}\s*[:=]\s*(["']).+?\1`,
  'i',
);
const PUBLIC_CONFIG_SECRET_UNQUOTED_ASSIGNMENT_VALUE_PATTERN = new RegExp(
  String.raw`\b${PUBLIC_CONFIG_SECRET_VALUE_KEY_FRAGMENT}\s*[:=]\s*(?!["'])[^\s,;&]+`,
  'i',
);
const PUBLIC_CONFIG_SECRET_FLAG_VALUE_PATTERN = /--[\w.-]*(?:authorization|api[-_]?key|secret|token|password)[\w.-]*(?:\s+|=)(["']?)[^\s"']+\1/i;
const PUBLIC_CONFIG_BEARER_TOKEN_VALUE_PATTERN = /\b(?:bearer|basic)\s+[^"',;&\s]+/i;
const PUBLIC_CONFIG_COMMON_SECRET_TOKEN_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9][A-Za-z0-9_-]{8,}|mrf_[A-Fa-f0-9]{16,})\b/;
const PUBLIC_CONFIG_JWT_VALUE_PATTERN = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const PUBLIC_CONFIG_URL_QUERY_SECRET_VALUE_PATTERN = new RegExp(
  String.raw`[?&]${PUBLIC_CONFIG_SECRET_VALUE_KEY_FRAGMENT}=[^&#\s]+`,
  'i',
);

export function evaluateRemoteFleetCommandPolicy(
  input: RemoteFleetCommandPolicyInput,
): RemoteFleetCommandPolicyDecision {
  const commandKindRead = readCommandKind(input.command);
  if (!commandKindRead.commandKind) {
    return denied({
      reason: 'unsupported-command-kind',
      commandKind: commandKindRead.rawCommandKind,
      nodeId: input.node?.id ?? readCommandNodeId(input.command),
      runtimeId: input.runtime?.id ?? readCommandRuntimeId(input.command),
      message: commandKindRead.rawCommandKind
        ? `Remote Fleet command kind is not supported by policy gate: ${commandKindRead.rawCommandKind}.`
        : 'Remote Fleet command kind is required for policy evaluation.',
    });
  }

  const commandKind = commandKindRead.commandKind;
  const commandNodeId = readCommandNodeId(input.command);
  const node = input.node;
  if (!node) {
    return denied({
      reason: 'node-not-provided',
      commandKind,
      nodeId: commandNodeId,
      runtimeId: input.runtime?.id ?? readCommandRuntimeId(input.command),
      message: 'Remote Fleet command policy requires a node record.',
    });
  }

  if (commandNodeId && commandNodeId !== node.id) {
    return denied({
      reason: 'command-node-mismatch',
      commandKind,
      nodeId: node.id,
      runtimeId: input.runtime?.id ?? readCommandRuntimeId(input.command),
      message: `Remote Fleet command targets node ${commandNodeId}, not evaluated node ${node.id}.`,
    });
  }

  if (!node.enabled || node.health?.reason === 'disabled') {
    return denied({
      reason: 'node-disabled',
      commandKind,
      nodeId: node.id,
      runtimeId: input.runtime?.id ?? readCommandRuntimeId(input.command),
      message: `Remote Fleet node ${node.id} is disabled.`,
    });
  }

  const commandRuntimeId = readCommandRuntimeId(input.command);
  if (input.runtime) {
    if (input.runtime.nodeId !== node.id) {
      return denied({
        reason: 'runtime-node-mismatch',
        commandKind,
        nodeId: node.id,
        runtimeId: input.runtime.id,
        message: `Remote Fleet runtime ${input.runtime.id} belongs to node ${input.runtime.nodeId}, not node ${node.id}.`,
      });
    }
    if (commandRuntimeId && commandRuntimeId !== input.runtime.id) {
      return denied({
        reason: 'command-runtime-mismatch',
        commandKind,
        nodeId: node.id,
        runtimeId: input.runtime.id,
        message: `Remote Fleet command targets runtime ${commandRuntimeId}, not evaluated runtime ${input.runtime.id}.`,
      });
    }
  }

  const runtimeKind = input.runtime?.runtimeKind ?? readCommandRuntimeKind(input.command);
  if (RUNTIME_REQUIRED_COMMAND_KINDS.has(commandKind) && !runtimeKind) {
    return denied({
      reason: 'runtime-required',
      commandKind,
      nodeId: node.id,
      runtimeId: commandRuntimeId,
      message: `Remote Fleet command ${commandKind} requires a runtime record or runtimeKind.`,
    });
  }

  if (runtimeKind && RUNTIME_KIND_GATED_COMMAND_KINDS.has(commandKind)) {
    const supportedRuntimeKinds = input.policy?.supportedRuntimeKinds ?? DEFAULT_SUPPORTED_RUNTIME_KINDS;
    if (!supportedRuntimeKinds.includes(runtimeKind)) {
      return denied({
        reason: 'unsupported-runtime-kind',
        commandKind,
        nodeId: node.id,
        runtimeId: input.runtime?.id ?? commandRuntimeId,
        runtimeKind,
        message: `Remote Fleet runtime kind is not supported for ${commandKind}: ${runtimeKind}.`,
      });
    }
  }

  const unsafePublicConfigKey = findUnsafePublicConfigKey(node.publicConfig ?? {});
  if (unsafePublicConfigKey) {
    return denied({
      reason: 'unsafe-public-config-key',
      commandKind,
      nodeId: node.id,
      runtimeId: input.runtime?.id ?? commandRuntimeId,
      path: unsafePublicConfigKey,
      message: `Remote Fleet publicConfig must not contain plaintext credential key ${unsafePublicConfigKey}.`,
    });
  }

  const requiredSecretRefNames = collectRequiredSecretRefNames(commandKind, input.command, node, input.policy);
  for (const secretRefName of requiredSecretRefNames) {
    if (!isValidSecretRef(node.secretRefs?.[secretRefName])) {
      return denied({
        reason: 'missing-secret-ref',
        commandKind,
        nodeId: node.id,
        runtimeId: input.runtime?.id ?? commandRuntimeId,
        secretRefName,
        message: `Remote Fleet command ${commandKind} requires node secretRef ${secretRefName}.`,
      });
    }
  }

  const defaultSshAuthSecretRefNames = collectDefaultSshAuthSecretRefNames(commandKind, node);
  if (defaultSshAuthSecretRefNames.length > 0 && !hasAnyValidSecretRef(node, defaultSshAuthSecretRefNames)) {
    return denied({
      reason: 'missing-auth-secret-ref',
      commandKind,
      nodeId: node.id,
      runtimeId: input.runtime?.id ?? commandRuntimeId,
      message: `Remote Fleet command ${commandKind} requires node secretRef sshPrivateKey or sshPassword.`,
    });
  }

  const portExposureDecision = evaluatePortExposurePolicy(commandKind, input.command, node, input.policy);
  if (portExposureDecision) {
    return denied({
      ...portExposureDecision,
      commandKind,
      nodeId: node.id,
      runtimeId: input.runtime?.id ?? commandRuntimeId,
    });
  }

  const workspaceMountDecision = evaluateWorkspaceMountPolicy(commandKind, input.command, node, input.policy);
  if (workspaceMountDecision) {
    return denied({
      ...workspaceMountDecision,
      commandKind,
      nodeId: node.id,
      runtimeId: input.runtime?.id ?? commandRuntimeId,
    });
  }

  return {
    resultType: 'allowed',
    reason: 'command-policy-accepted',
    commandKind,
    nodeId: node.id,
    ...(input.runtime?.id ?? commandRuntimeId ? { runtimeId: input.runtime?.id ?? commandRuntimeId } : {}),
    requiredSecretRefNames,
  };
}

function denied(
  decision: Omit<Extract<RemoteFleetCommandPolicyDecision, { readonly resultType: 'denied' }>, 'resultType'>,
): RemoteFleetCommandPolicyDecision {
  return { resultType: 'denied', ...decision };
}

function readCommandKind(command: RemoteFleetCommandPolicyCommand): {
  readonly commandKind?: RemoteFleetCommandPolicyCommandKind;
  readonly rawCommandKind?: string;
} {
  const value = 'kind' in command && typeof command.kind === 'string'
    ? command.kind.trim()
    : 'command' in command && typeof command.command === 'string'
      ? command.command.trim()
      : '';
  if (!value) return {};
  if (!REMOTE_FLEET_COMMAND_POLICY_COMMAND_KINDS.has(value)) {
    return { rawCommandKind: value };
  }
  return { commandKind: value as RemoteFleetCommandPolicyCommandKind, rawCommandKind: value };
}

function readCommandNodeId(command: RemoteFleetCommandPolicyCommand): string | undefined {
  return readOptionalString(command.nodeId);
}

function readCommandRuntimeId(command: RemoteFleetCommandPolicyCommand): string | undefined {
  return readOptionalString(command.runtimeId);
}

function readCommandRuntimeKind(command: RemoteFleetCommandPolicyCommand): string | undefined {
  return 'runtimeKind' in command ? readOptionalString(command.runtimeKind) : undefined;
}

function collectRequiredSecretRefNames(
  commandKind: RemoteFleetCommandPolicyCommandKind,
  command: RemoteFleetCommandPolicyCommand,
  node: RemoteFleetCommandPolicyNode | RemoteFleetNodeRecord,
  policy: RemoteFleetCommandPolicy | undefined,
): readonly string[] {
  const names: string[] = [];
  names.push(...(policy?.requiredSecretRefNames ?? []));
  names.push(...collectPresentDefaultSshAuthSecretRefNames(commandKind, node));
  names.push(...collectCommandRequiredSecretRefNames(command));
  names.push(...collectLaunchSecretRefNames(node.publicConfig ?? {}));
  return normalizeStringList(names);
}

function collectPresentDefaultSshAuthSecretRefNames(
  commandKind: RemoteFleetCommandPolicyCommandKind,
  node: RemoteFleetCommandPolicyNode | RemoteFleetNodeRecord,
): readonly string[] {
  const names = collectDefaultSshAuthSecretRefNames(commandKind, node);
  return names.filter((secretRefName) => isValidSecretRef(node.secretRefs?.[secretRefName]));
}

function collectDefaultSshAuthSecretRefNames(
  commandKind: RemoteFleetCommandPolicyCommandKind,
  node: RemoteFleetCommandPolicyNode | RemoteFleetNodeRecord,
): readonly string[] {
  if (node.targetKind !== 'ssh-host' && node.targetKind !== 'vm') return [];
  if (!DEFAULT_SSH_SECRET_COMMAND_KINDS.has(commandKind)) return [];
  return ['sshPrivateKey', 'sshPassword'];
}

function collectCommandRequiredSecretRefNames(command: RemoteFleetCommandPolicyCommand): readonly string[] {
  const names: string[] = [];
  if ('requiredSecretRefNames' in command && Array.isArray(command.requiredSecretRefNames)) {
    names.push(...command.requiredSecretRefNames);
  }

  const payload = readCommandPayload(command);
  if (!payload) return names;
  if (Array.isArray(payload.requiredSecretRefNames)) {
    names.push(...payload.requiredSecretRefNames.filter((item): item is string => typeof item === 'string'));
  }
  if (Array.isArray(payload.requiredSecretRefs)) {
    names.push(...payload.requiredSecretRefs.filter((item): item is string => typeof item === 'string'));
  }
  if (isRecord(payload.requiredSecretRefs)) {
    names.push(...Object.keys(payload.requiredSecretRefs));
  }
  return names;
}

function collectLaunchSecretRefNames(publicConfig: Readonly<Record<string, unknown>>): readonly string[] {
  const launchConfig = readRuntimeLaunchConfig(publicConfig);
  if (!launchConfig) return [];

  const names: string[] = [];
  if (isRecord(launchConfig.secretEnv)) {
    names.push(...Object.values(launchConfig.secretEnv).filter((item): item is string => typeof item === 'string'));
  }
  const environment = isRecord(launchConfig.environment) ? launchConfig.environment : undefined;
  if (environment && Array.isArray(environment.secrets)) {
    for (const item of environment.secrets) {
      if (isRecord(item) && typeof item.secretRefName === 'string') {
        names.push(item.secretRefName);
      }
    }
  }
  return names;
}

function evaluatePortExposurePolicy(
  commandKind: RemoteFleetCommandPolicyCommandKind,
  command: RemoteFleetCommandPolicyCommand,
  node: RemoteFleetCommandPolicyNode | RemoteFleetNodeRecord,
  policy: RemoteFleetCommandPolicy | undefined,
): Omit<Extract<RemoteFleetCommandPolicyDecision, { readonly resultType: 'denied' }>, 'resultType' | 'commandKind' | 'nodeId' | 'runtimeId'> | undefined {
  const candidates = collectPortExposureCandidates(command, node.publicConfig ?? {});
  if (commandKind === 'expose-port' && candidates.length === 0) {
    return {
      reason: 'invalid-port-exposure',
      message: 'Remote Fleet expose-port command requires a port exposure payload.',
    };
  }

  for (const candidate of candidates) {
    if (!isRecord(candidate.value)) {
      return {
        reason: 'invalid-port-exposure',
        path: candidate.path,
        message: `Remote Fleet port exposure at ${candidate.path} must be an object.`,
      };
    }

    const portName = readOptionalString(candidate.value.name);
    const targetPort = candidate.value.targetPort;
    if (!isPortNumber(targetPort)) {
      return {
        reason: 'invalid-port-exposure',
        path: `${candidate.path}.targetPort`,
        portName,
        message: `Remote Fleet port exposure at ${candidate.path} must use a targetPort from 1 to 65535.`,
      };
    }

    if (candidate.value.requestedHostPort !== undefined && !isPortNumber(candidate.value.requestedHostPort)) {
      return {
        reason: 'invalid-port-exposure',
        path: `${candidate.path}.requestedHostPort`,
        portName,
        message: `Remote Fleet port exposure at ${candidate.path} must use a requestedHostPort from 1 to 65535.`,
      };
    }

    const exposure = typeof candidate.value.exposure === 'string' ? candidate.value.exposure : '';
    if (!PORT_EXPOSURE_VALUES.has(exposure)) {
      return {
        reason: 'invalid-port-exposure',
        path: `${candidate.path}.exposure`,
        portName,
        exposure,
        message: `Remote Fleet port exposure at ${candidate.path} must choose loopback, node-private, fleet-private, or public.`,
      };
    }

    if (exposure === 'public' && policy?.allowPublicPortExposure !== true) {
      return {
        reason: 'public-port-exposure-denied',
        path: `${candidate.path}.exposure`,
        portName,
        exposure,
        message: `Remote Fleet public port exposure is denied by policy at ${candidate.path}.`,
      };
    }
  }

  return undefined;
}

function evaluateWorkspaceMountPolicy(
  commandKind: RemoteFleetCommandPolicyCommandKind,
  command: RemoteFleetCommandPolicyCommand,
  node: RemoteFleetCommandPolicyNode | RemoteFleetNodeRecord,
  policy: RemoteFleetCommandPolicy | undefined,
): Omit<Extract<RemoteFleetCommandPolicyDecision, { readonly resultType: 'denied' }>, 'resultType' | 'commandKind' | 'nodeId' | 'runtimeId'> | undefined {
  const candidates = collectWorkspaceMountCandidates(command, node.publicConfig ?? {});
  if (commandKind === 'mount-workspace' && candidates.length === 0) {
    return {
      reason: 'invalid-workspace-mount',
      message: 'Remote Fleet mount-workspace command requires a workspace mount payload.',
    };
  }

  for (const candidate of candidates) {
    if (!isRecord(candidate.value)) {
      return {
        reason: 'invalid-workspace-mount',
        path: candidate.path,
        message: `Remote Fleet workspace mount at ${candidate.path} must be an object.`,
      };
    }

    const source = candidate.value.source;
    if (!isRecord(source) || typeof source.kind !== 'string' || !WORKSPACE_MOUNT_SOURCE_KINDS.has(source.kind)) {
      return {
        reason: 'invalid-workspace-mount',
        path: `${candidate.path}.source.kind`,
        message: `Remote Fleet workspace mount at ${candidate.path} must use workspace-ref, node-path, or ephemeral-volume source.`,
      };
    }

    if (source.kind === 'node-path' && policy?.allowNodePathWorkspaceMounts !== true) {
      return {
        reason: 'node-path-workspace-mount-denied',
        path: `${candidate.path}.source`,
        message: `Remote Fleet node-path workspace mount is denied by policy at ${candidate.path}.`,
      };
    }
  }

  return undefined;
}

function collectPortExposureCandidates(
  command: RemoteFleetCommandPolicyCommand,
  publicConfig: Readonly<Record<string, unknown>>,
): readonly ValueCandidate[] {
  const candidates: ValueCandidate[] = [];
  const payload = readCommandPayload(command);
  appendObjectOrArrayCandidate(candidates, payload, 'payload', 'ports');
  appendObjectOrArrayCandidate(candidates, payload, 'payload', 'portExposures');
  if (payload && (payload.targetPort !== undefined || payload.exposure !== undefined)) {
    candidates.push({ path: 'payload', value: payload });
  }

  const launchConfig = readRuntimeLaunchConfig(publicConfig);
  appendObjectOrArrayCandidate(candidates, launchConfig, 'publicConfig.runtimeLaunch', 'ports');
  appendObjectOrArrayCandidate(candidates, launchConfig, 'publicConfig.runtimeLaunch', 'portExposures');
  return candidates;
}

function collectWorkspaceMountCandidates(
  command: RemoteFleetCommandPolicyCommand,
  publicConfig: Readonly<Record<string, unknown>>,
): readonly ValueCandidate[] {
  const candidates: ValueCandidate[] = [];
  const payload = readCommandPayload(command);
  appendObjectOrArrayCandidate(candidates, payload, 'payload', 'workspaces');
  appendObjectOrArrayCandidate(candidates, payload, 'payload', 'workspaceMounts');
  if (payload && payload.source !== undefined) {
    candidates.push({ path: 'payload', value: payload });
  }

  const launchConfig = readRuntimeLaunchConfig(publicConfig);
  appendObjectOrArrayCandidate(candidates, launchConfig, 'publicConfig.runtimeLaunch', 'workspaces');
  appendObjectOrArrayCandidate(candidates, launchConfig, 'publicConfig.runtimeLaunch', 'workspaceMounts');
  return candidates;
}

function appendObjectOrArrayCandidate(
  candidates: ValueCandidate[],
  record: Readonly<Record<string, unknown>> | undefined,
  basePath: string,
  key: string,
): void {
  if (!record || record[key] === undefined) return;
  const value = record[key];
  if (Array.isArray(value)) {
    value.forEach((item, index) => candidates.push({ path: `${basePath}.${key}.${index}`, value: item }));
    return;
  }
  candidates.push({ path: `${basePath}.${key}`, value });
}

export function findUnsafeRemoteFleetPublicConfigKey(publicConfig: Readonly<Record<string, unknown>>): string | undefined {
  return findUnsafeConfigKey(publicConfig, ['publicConfig']);
}

export function findUnsafeRemoteFleetEndpointUrlKey(endpointUrl: string | undefined): string | undefined {
  if (!endpointUrl) {
    return undefined;
  }
  if (hasUrlUserInfo(endpointUrl)) {
    return 'endpointUrl.credentials';
  }
  return isUnsafePublicConfigValue(endpointUrl) ? 'endpointUrl' : undefined;
}

function findUnsafePublicConfigKey(publicConfig: Readonly<Record<string, unknown>>): string | undefined {
  return findUnsafeRemoteFleetPublicConfigKey(publicConfig);
}

function findUnsafeConfigKey(value: unknown, path: readonly string[]): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = findUnsafeConfigKey(value[index], [...path, String(index)]);
      if (nested) return nested;
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return isUnsafePublicConfigValue(value) ? path.join('.') : undefined;
  }

  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (isUnsafePublicConfigKey(key, path)) {
      return nextPath.join('.');
    }
    const nested = findUnsafeConfigKey(item, nextPath);
    if (nested) return nested;
  }
  return undefined;
}

function isUnsafePublicConfigKey(key: string, parentPath: readonly string[]): boolean {
  const normalizedKey = normalizeKey(key);
  const normalizedParentPath = normalizePath(parentPath);
  if (PUBLIC_CONFIG_SECRET_REFERENCE_KEYS.has(normalizedKey)) {
    return false;
  }
  if (normalizedParentPath.endsWith('publicconfig.runtimelaunch.secretenv')) {
    return false;
  }
  if (normalizedKey === 'secrets' && normalizedParentPath.endsWith('publicconfig.runtimelaunch.environment')) {
    return false;
  }
  if (UNSAFE_PUBLIC_CONFIG_KEY_PATTERNS.includes(normalizedKey)) {
    return true;
  }
  return normalizedKey.endsWith('password')
    || normalizedKey.endsWith('token')
    || normalizedKey.endsWith('secret')
    || normalizedKey.endsWith('privatekey')
    || normalizedKey.includes('apikey');
}

function isUnsafePublicConfigValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return PUBLIC_CONFIG_AUTHORIZATION_SCHEME_VALUE_PATTERN.test(trimmed)
    || PUBLIC_CONFIG_SECRET_QUOTED_ASSIGNMENT_VALUE_PATTERN.test(trimmed)
    || PUBLIC_CONFIG_SECRET_UNQUOTED_ASSIGNMENT_VALUE_PATTERN.test(trimmed)
    || PUBLIC_CONFIG_SECRET_FLAG_VALUE_PATTERN.test(trimmed)
    || PUBLIC_CONFIG_BEARER_TOKEN_VALUE_PATTERN.test(trimmed)
    || PUBLIC_CONFIG_COMMON_SECRET_TOKEN_VALUE_PATTERN.test(trimmed)
    || PUBLIC_CONFIG_JWT_VALUE_PATTERN.test(trimmed)
    || PUBLIC_CONFIG_URL_QUERY_SECRET_VALUE_PATTERN.test(trimmed);
}

function hasUrlUserInfo(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return url.username.length > 0 || url.password.length > 0;
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s@]+@/i.test(trimmed);
  }
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizePath(path: readonly string[]): string {
  return path.map(normalizeKey).join('.');
}

function readRuntimeLaunchConfig(publicConfig: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
  return isRecord(publicConfig.runtimeLaunch) ? publicConfig.runtimeLaunch : undefined;
}

function readCommandPayload(command: RemoteFleetCommandPolicyCommand): Readonly<Record<string, unknown>> | undefined {
  return isRecord(command.payload) ? command.payload : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStringList(values: readonly string[]): readonly string[] {
  const names = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length > 0) {
      names.add(normalized);
    }
  }
  return Array.from(names).sort();
}

function hasAnyValidSecretRef(
  node: RemoteFleetCommandPolicyNode | RemoteFleetNodeRecord,
  secretRefNames: readonly string[],
): boolean {
  return secretRefNames.some((secretRefName) => isValidSecretRef(node.secretRefs?.[secretRefName]));
}

function isValidSecretRef(value: RemoteFleetSecretRef | undefined): boolean {
  return value?.kind === 'secret-ref' && value.ref.trim().length > 0;
}

function isPortNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
