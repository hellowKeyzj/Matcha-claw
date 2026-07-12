import { findUnsafeRemoteFleetPublicConfigKey } from './remote-fleet-command-policy';
import type {
  RemoteFleetNodeRecord,
  RemoteFleetRuntimeKind,
  RemoteFleetSecretRef,
  RuntimeInstanceRecord,
} from './remote-fleet-model';
import type { RuntimeAgentCommandRequest } from './remote-fleet-connectors';

export const REMOTE_RUNTIME_LAUNCH_SPEC_VERSION = 'remote-runtime-launch/v1';
export const REMOTE_RUNTIME_LAUNCH_CONFIG_KEY = 'runtimeLaunch';
export const REMOTE_RUNTIME_LAUNCH_COMMAND_PAYLOAD_VERSION = 'remote-runtime-launch-command/v1';

export type RemoteRuntimeLaunchSpecVersion = typeof REMOTE_RUNTIME_LAUNCH_SPEC_VERSION;
export type RemoteRuntimeLaunchCommandPayloadVersion = typeof REMOTE_RUNTIME_LAUNCH_COMMAND_PAYLOAD_VERSION;

export type RemoteRuntimeLaunchSpec =
  | OpenClawRemoteRuntimeLaunchSpec
  | MatchaAgentRemoteRuntimeLaunchSpec
  | PluginRuntimeRemoteRuntimeLaunchSpec;

export interface RemoteRuntimeLaunchSpecBase {
  readonly specVersion: RemoteRuntimeLaunchSpecVersion;
  readonly runtimeId: string;
  readonly nodeId: string;
  readonly runtimeKind: RemoteFleetRuntimeKind;
  readonly displayName: string;
  readonly version?: string;
  readonly environment: RemoteRuntimeEnvironmentRequest;
  readonly resourceLimits?: RemoteRuntimeResourceLimits;
  readonly workspaceMounts: readonly RemoteRuntimeWorkspaceMountRequest[];
  readonly portExposures: readonly RemoteRuntimePortExposureRequest[];
}

export interface OpenClawRemoteRuntimeLaunchSpec extends RemoteRuntimeLaunchSpecBase {
  readonly runtimeKind: 'openclaw';
  readonly provider: OpenClawRemoteRuntimeLaunchProvider;
}

export interface MatchaAgentRemoteRuntimeLaunchSpec extends RemoteRuntimeLaunchSpecBase {
  readonly runtimeKind: 'matcha-agent';
  readonly provider: MatchaAgentRemoteRuntimeLaunchProvider;
}

export interface PluginRuntimeRemoteRuntimeLaunchSpec extends RemoteRuntimeLaunchSpecBase {
  readonly runtimeKind: 'plugin-runtime';
  readonly provider: PluginRuntimeRemoteRuntimeLaunchProvider;
}

export interface OpenClawRemoteRuntimeLaunchProvider {
  readonly kind: 'openclaw';
  readonly launchMode: 'gateway' | 'native-runtime';
  readonly configProfile?: string;
}

export interface MatchaAgentRemoteRuntimeLaunchProvider {
  readonly kind: 'matcha-agent';
  readonly launchMode: 'daemon' | 'app-server';
  readonly appServerBasePath?: string;
}

export interface PluginRuntimeRemoteRuntimeLaunchProvider {
  readonly kind: 'plugin-runtime';
  readonly pluginId: string;
  readonly entrypoint?: string;
}

export interface RemoteRuntimeEnvironmentRequest {
  readonly public: readonly RemoteRuntimePublicEnvironmentVariable[];
  readonly secrets: readonly RemoteRuntimeSecretEnvironmentVariable[];
}

export interface RemoteRuntimePublicEnvironmentVariable {
  readonly name: string;
  readonly value: string;
}

export interface RemoteRuntimeSecretEnvironmentVariable {
  readonly name: string;
  readonly secretRefName: string;
  readonly secretRef: RemoteFleetSecretRef;
  readonly placeholder: string;
}

export interface RemoteRuntimeResourceLimits {
  readonly cpuCores?: number;
  readonly memoryMb?: number;
  readonly gpuCount?: number;
  readonly ephemeralStorageMb?: number;
}

export interface RemoteRuntimeWorkspaceMountRequest {
  readonly source: RemoteRuntimeWorkspaceMountSource;
  readonly targetPath: string;
  readonly access: 'read-only' | 'read-write';
  readonly purpose?: 'workspace' | 'cache' | 'artifact' | 'scratch';
}

export type RemoteRuntimeWorkspaceMountSource =
  | { readonly kind: 'workspace-ref'; readonly workspaceId: string }
  | { readonly kind: 'node-path'; readonly path: string }
  | { readonly kind: 'ephemeral-volume'; readonly name: string; readonly sizeMb?: number };

export interface RemoteRuntimePortExposureRequest {
  readonly name: string;
  readonly targetPort: number;
  readonly protocol: 'tcp' | 'udp' | 'http' | 'https';
  readonly exposure: 'loopback' | 'node-private' | 'fleet-private' | 'public';
  readonly requestedHostPort?: number;
}

export interface RemoteRuntimeLaunchSpecInput {
  readonly runtime: RuntimeInstanceRecord;
  readonly node: Pick<RemoteFleetNodeRecord, 'id' | 'publicConfig' | 'secretRefs'>;
}

export type RemoteRuntimeLaunchSpecValidationResult =
  | { readonly resultType: 'valid'; readonly spec: RemoteRuntimeLaunchSpec }
  | { readonly resultType: 'invalid'; readonly issues: readonly RemoteRuntimeLaunchSpecValidationIssue[] };

export interface RemoteRuntimeLaunchSpecValidationIssue {
  readonly path: string;
  readonly reason: 'invalid-type' | 'invalid-value' | 'missing-required-field' | 'missing-secret-ref' | 'node-mismatch' | 'unsafe-public-config';
  readonly message: string;
}

export interface BuildRuntimeLaunchCommandRequestInput {
  readonly commandId: string;
  readonly runtime: RuntimeInstanceRecord;
  readonly node: RemoteFleetNodeRecord;
  readonly timeoutMs?: number;
}

export type BuildRuntimeLaunchCommandRequestResult =
  | {
      readonly resultType: 'built';
      readonly request: RuntimeAgentCommandRequest;
      readonly launchSpec: RemoteRuntimeLaunchSpec;
      readonly payload: RemoteRuntimeLaunchCommandPayload;
    }
  | { readonly resultType: 'invalid'; readonly issues: readonly RemoteRuntimeLaunchSpecValidationIssue[] };

export type RemoteRuntimeLaunchCommandPayload = Readonly<Record<string, unknown>> & {
  readonly payloadType: 'remote-runtime-launch';
  readonly launchSpec: RemoteRuntimeLaunchSpec;
  readonly launchCommand: RemoteRuntimeLaunchCommand;
  readonly readiness: RemoteRuntimeReadinessSyncHints;
  readonly capabilitySync: RemoteRuntimeCapabilitySyncHints;
  readonly secretPlaceholders: readonly RemoteRuntimeSecretPlaceholder[];
  readonly unsupportedReasons: readonly RemoteRuntimeLaunchUnsupportedReason[];
};

export type RemoteRuntimeLaunchCommand =
  | OpenClawRemoteRuntimeLaunchCommand
  | MatchaAgentRemoteRuntimeLaunchCommand
  | PluginRuntimeRemoteRuntimeLaunchCommand;

export interface RemoteRuntimeLaunchCommandBase {
  readonly commandVersion: RemoteRuntimeLaunchCommandPayloadVersion;
  readonly commandType: 'start-runtime';
  readonly runtimeId: string;
  readonly nodeId: string;
  readonly runtimeKind: RemoteFleetRuntimeKind;
  readonly displayName: string;
  readonly environment: RemoteRuntimeLaunchCommandEnvironment;
  readonly resourceLimits?: RemoteRuntimeResourceLimits;
  readonly workspaceMounts: readonly RemoteRuntimeWorkspaceMountRequest[];
  readonly portExposures: readonly RemoteRuntimePortExposureRequest[];
  readonly readiness: RemoteRuntimeReadinessSyncHints;
  readonly capabilitySync: RemoteRuntimeCapabilitySyncHints;
}

export interface OpenClawRemoteRuntimeLaunchCommand extends RemoteRuntimeLaunchCommandBase {
  readonly runtimeKind: 'openclaw';
  readonly provider: OpenClawRemoteRuntimeLaunchProvider;
  readonly executable: {
    readonly kind: 'openclaw-runtime';
    readonly launchMode: OpenClawRemoteRuntimeLaunchProvider['launchMode'];
    readonly configProfile?: string;
  };
}

export interface MatchaAgentRemoteRuntimeLaunchCommand extends RemoteRuntimeLaunchCommandBase {
  readonly runtimeKind: 'matcha-agent';
  readonly provider: MatchaAgentRemoteRuntimeLaunchProvider;
  readonly executable: {
    readonly kind: 'matcha-agent-runtime';
    readonly launchMode: MatchaAgentRemoteRuntimeLaunchProvider['launchMode'];
    readonly appServerBasePath?: string;
  };
}

export interface PluginRuntimeRemoteRuntimeLaunchCommand extends RemoteRuntimeLaunchCommandBase {
  readonly runtimeKind: 'plugin-runtime';
  readonly provider: PluginRuntimeRemoteRuntimeLaunchProvider;
  readonly executable: {
    readonly kind: 'openclaw-plugin-runtime';
    readonly pluginId: string;
    readonly entrypoint: string;
  };
}

export interface RemoteRuntimeLaunchCommandEnvironment {
  readonly public: readonly RemoteRuntimePublicEnvironmentVariable[];
  readonly secretPlaceholders: readonly RemoteRuntimeSecretPlaceholder[];
}

export interface RemoteRuntimeReadinessSyncHints {
  readonly expectedRuntimeId: string;
  readonly expectedNodeId: string;
  readonly expectedRuntimeKind: RemoteFleetRuntimeKind;
  readonly requiredSignals: readonly RemoteRuntimeReadinessSignal[];
  readonly ackAdvancesLifecycle: true;
}

export interface RemoteRuntimeReadinessSignal {
  readonly signal: 'process-started' | 'runtime-endpoint-ready' | 'health-probe-ready';
  readonly required: boolean;
  readonly description: string;
}

export interface RemoteRuntimeCapabilitySyncHints {
  readonly syncAfterReady: true;
  readonly expectedRuntimeId: string;
  readonly strategy: 'runtime-agent-capabilities-sync';
  readonly capabilityKinds: readonly RemoteRuntimeCapabilitySyncKind[];
}

export type RemoteRuntimeCapabilitySyncKind =
  | 'agent-runtime-endpoint'
  | 'session-runtime'
  | 'tool-capabilities'
  | 'plugin-capabilities';

export interface RemoteRuntimeSecretPlaceholder {
  readonly envName: string;
  readonly secretRefName: string;
  readonly secretRef: RemoteFleetSecretRef;
  readonly placeholder: string;
}

export interface RemoteRuntimeLaunchUnsupportedReason {
  readonly reason: 'unsupported-runtime-kind';
  readonly runtimeKind: string;
  readonly message: string;
}

export function validateRemoteRuntimeLaunchSpec(input: RemoteRuntimeLaunchSpecInput): RemoteRuntimeLaunchSpecValidationResult {
  const issues: RemoteRuntimeLaunchSpecValidationIssue[] = [];
  if (input.runtime.nodeId !== input.node.id) {
    issues.push({
      path: 'runtime.nodeId',
      reason: 'node-mismatch',
      message: `Runtime ${input.runtime.id} belongs to node ${input.runtime.nodeId}, not node ${input.node.id}.`,
    });
  }

  const unsafePublicConfigKey = findUnsafeRemoteFleetPublicConfigKey(input.node.publicConfig);
  if (unsafePublicConfigKey) {
    issues.push({
      path: unsafePublicConfigKey,
      reason: 'unsafe-public-config',
      message: `Remote Fleet runtime launch publicConfig must not contain plaintext credential key ${unsafePublicConfigKey}.`,
    });
  }

  const launchConfig = readLaunchConfig(input.node.publicConfig, issues);
  const environment = readEnvironmentRequest(launchConfig, input.node.secretRefs, issues);
  const resourceLimits = readResourceLimits(launchConfig, issues);
  const workspaceMounts = readWorkspaceMountRequests(launchConfig, issues);
  const portExposures = readPortExposureRequests(launchConfig, issues);
  const base = buildLaunchSpecBase(input.runtime, environment, resourceLimits, workspaceMounts, portExposures);
  const provider = readProvider(input.runtime.runtimeKind, launchConfig, issues);

  if (issues.length > 0 || !provider) {
    return { resultType: 'invalid', issues };
  }

  switch (provider.kind) {
    case 'openclaw':
      return { resultType: 'valid', spec: { ...base, runtimeKind: 'openclaw', provider } };
    case 'matcha-agent':
      return { resultType: 'valid', spec: { ...base, runtimeKind: 'matcha-agent', provider } };
    case 'plugin-runtime':
      return { resultType: 'valid', spec: { ...base, runtimeKind: 'plugin-runtime', provider } };
  }
}

export function buildRuntimeLaunchCommandRequest(input: BuildRuntimeLaunchCommandRequestInput): BuildRuntimeLaunchCommandRequestResult {
  const validation = validateRemoteRuntimeLaunchSpec({ runtime: input.runtime, node: input.node });
  if (validation.resultType === 'invalid') {
    return validation;
  }

  const launchSpec = validation.spec;
  const readiness = buildReadinessSyncHints(launchSpec);
  const capabilitySync = buildCapabilitySyncHints(launchSpec);
  const secretPlaceholders = buildSecretPlaceholders(launchSpec.environment.secrets);
  const launchCommand = buildLaunchCommand(launchSpec, readiness, capabilitySync, secretPlaceholders);
  const payload: RemoteRuntimeLaunchCommandPayload = {
    payloadType: 'remote-runtime-launch',
    launchSpec,
    launchCommand,
    readiness,
    capabilitySync,
    secretPlaceholders,
    unsupportedReasons: buildUnsupportedReasons(launchSpec.runtimeKind),
  };
  const publicConfig = buildSanitizedLaunchPublicConfig(launchSpec, readiness, capabilitySync);
  const node: RemoteFleetNodeRecord = {
    ...input.node,
    publicConfig,
    secretRefs: buildReferencedSecretRefs(launchSpec.environment.secrets),
  };
  const request: RuntimeAgentCommandRequest = {
    commandId: input.commandId,
    kind: 'start-runtime',
    node,
    runtime: input.runtime,
    publicConfig,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    payload,
  };

  return { resultType: 'built', request, launchSpec, payload };
}

function buildLaunchSpecBase(
  runtime: RuntimeInstanceRecord,
  environment: RemoteRuntimeEnvironmentRequest,
  resourceLimits: RemoteRuntimeResourceLimits | undefined,
  workspaceMounts: readonly RemoteRuntimeWorkspaceMountRequest[],
  portExposures: readonly RemoteRuntimePortExposureRequest[],
): RemoteRuntimeLaunchSpecBase {
  return {
    specVersion: REMOTE_RUNTIME_LAUNCH_SPEC_VERSION,
    runtimeId: runtime.id,
    nodeId: runtime.nodeId,
    runtimeKind: runtime.runtimeKind,
    displayName: runtime.displayName,
    ...(runtime.version ? { version: runtime.version } : {}),
    environment,
    ...(resourceLimits ? { resourceLimits } : {}),
    workspaceMounts,
    portExposures,
  };
}

function readLaunchConfig(
  publicConfig: Readonly<Record<string, unknown>>,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): Readonly<Record<string, unknown>> {
  const value = publicConfig[REMOTE_RUNTIME_LAUNCH_CONFIG_KEY];
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    issues.push({
      path: REMOTE_RUNTIME_LAUNCH_CONFIG_KEY,
      reason: 'invalid-type',
      message: `${REMOTE_RUNTIME_LAUNCH_CONFIG_KEY} must be an object when provided.`,
    });
    return {};
  }
  return value;
}

function readEnvironmentRequest(
  launchConfig: Readonly<Record<string, unknown>>,
  secretRefs: Readonly<Record<string, RemoteFleetSecretRef>>,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): RemoteRuntimeEnvironmentRequest {
  return {
    public: readPublicEnvironmentVariables(launchConfig.env, issues),
    secrets: readSecretEnvironmentVariables(launchConfig.secretEnv, secretRefs, issues),
  };
}

function readPublicEnvironmentVariables(
  value: unknown,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): readonly RemoteRuntimePublicEnvironmentVariable[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    issues.push({ path: 'runtimeLaunch.env', reason: 'invalid-type', message: 'runtimeLaunch.env must be an object.' });
    return [];
  }

  const env: RemoteRuntimePublicEnvironmentVariable[] = [];
  for (const [name, envValue] of Object.entries(value)) {
    if (!isEnvironmentVariableName(name)) {
      issues.push({ path: `runtimeLaunch.env.${name}`, reason: 'invalid-value', message: 'Environment variable names must use POSIX-style uppercase names.' });
      continue;
    }
    if (typeof envValue !== 'string') {
      issues.push({ path: `runtimeLaunch.env.${name}`, reason: 'invalid-type', message: 'Public environment values must be strings.' });
      continue;
    }
    env.push({ name, value: envValue });
  }

  return env.sort(compareByName);
}

function readSecretEnvironmentVariables(
  value: unknown,
  secretRefs: Readonly<Record<string, RemoteFleetSecretRef>>,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): readonly RemoteRuntimeSecretEnvironmentVariable[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    issues.push({ path: 'runtimeLaunch.secretEnv', reason: 'invalid-type', message: 'runtimeLaunch.secretEnv must be an object.' });
    return [];
  }

  const env: RemoteRuntimeSecretEnvironmentVariable[] = [];
  for (const [name, secretRefName] of Object.entries(value)) {
    if (!isEnvironmentVariableName(name)) {
      issues.push({ path: `runtimeLaunch.secretEnv.${name}`, reason: 'invalid-value', message: 'Secret environment variable names must use POSIX-style uppercase names.' });
      continue;
    }
    if (typeof secretRefName !== 'string' || secretRefName.trim().length === 0) {
      issues.push({ path: `runtimeLaunch.secretEnv.${name}`, reason: 'invalid-type', message: 'Secret environment values must name a node secretRef.' });
      continue;
    }

    const normalizedSecretRefName = secretRefName.trim();
    const secretRef = secretRefs[normalizedSecretRefName];
    if (!secretRef) {
      issues.push({
        path: `runtimeLaunch.secretEnv.${name}`,
        reason: 'missing-secret-ref',
        message: `Secret environment variable ${name} references missing node secretRef ${normalizedSecretRefName}.`,
      });
      continue;
    }
    env.push({
      name,
      secretRefName: normalizedSecretRefName,
      secretRef,
      placeholder: buildSecretPlaceholder(name),
    });
  }

  return env.sort(compareByName);
}

function readResourceLimits(
  launchConfig: Readonly<Record<string, unknown>>,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): RemoteRuntimeResourceLimits | undefined {
  if (launchConfig.resources === undefined) {
    return undefined;
  }
  if (!isRecord(launchConfig.resources)) {
    issues.push({ path: 'runtimeLaunch.resources', reason: 'invalid-type', message: 'runtimeLaunch.resources must be an object.' });
    return undefined;
  }

  const cpuCores = readPositiveNumber(launchConfig.resources.cpuCores, 'runtimeLaunch.resources.cpuCores', issues);
  const memoryMb = readPositiveInteger(launchConfig.resources.memoryMb, 'runtimeLaunch.resources.memoryMb', issues);
  const gpuCount = readNonNegativeInteger(launchConfig.resources.gpuCount, 'runtimeLaunch.resources.gpuCount', issues);
  const ephemeralStorageMb = readPositiveInteger(launchConfig.resources.ephemeralStorageMb, 'runtimeLaunch.resources.ephemeralStorageMb', issues);
  const limits: RemoteRuntimeResourceLimits = {
    ...(cpuCores === undefined ? {} : { cpuCores }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(gpuCount === undefined ? {} : { gpuCount }),
    ...(ephemeralStorageMb === undefined ? {} : { ephemeralStorageMb }),
  };

  return Object.keys(limits).length > 0 ? limits : undefined;
}

function readWorkspaceMountRequests(
  launchConfig: Readonly<Record<string, unknown>>,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): readonly RemoteRuntimeWorkspaceMountRequest[] {
  if (launchConfig.workspaces === undefined) {
    return [];
  }
  if (!Array.isArray(launchConfig.workspaces)) {
    issues.push({ path: 'runtimeLaunch.workspaces', reason: 'invalid-type', message: 'runtimeLaunch.workspaces must be an array.' });
    return [];
  }

  return launchConfig.workspaces.flatMap((item, index) => readWorkspaceMountRequest(item, index, issues));
}

function readWorkspaceMountRequest(
  value: unknown,
  index: number,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): readonly RemoteRuntimeWorkspaceMountRequest[] {
  const basePath = `runtimeLaunch.workspaces.${index}`;
  if (!isRecord(value)) {
    issues.push({ path: basePath, reason: 'invalid-type', message: 'Workspace mount requests must be objects.' });
    return [];
  }

  const source = readWorkspaceMountSource(value.source, `${basePath}.source`, issues);
  const targetPath = readRequiredString(value.targetPath, `${basePath}.targetPath`, issues);
  const access = readRequiredStringEnum(value.access, `${basePath}.access`, ['read-only', 'read-write'], issues);
  const purpose = readStringEnum(value.purpose, `${basePath}.purpose`, ['workspace', 'cache', 'artifact', 'scratch'], issues);
  if (!source || !targetPath || !access) {
    return [];
  }

  return [{
    source,
    targetPath,
    access,
    ...(purpose ? { purpose } : {}),
  }];
}

function readWorkspaceMountSource(
  value: unknown,
  path: string,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): RemoteRuntimeWorkspaceMountSource | undefined {
  if (!isRecord(value)) {
    issues.push({ path, reason: 'invalid-type', message: 'Workspace mount source must be an object.' });
    return undefined;
  }

  switch (value.kind) {
    case 'workspace-ref': {
      const workspaceId = readRequiredString(value.workspaceId, `${path}.workspaceId`, issues);
      return workspaceId ? { kind: 'workspace-ref', workspaceId } : undefined;
    }
    case 'node-path': {
      const nodePath = readRequiredString(value.path, `${path}.path`, issues);
      return nodePath ? { kind: 'node-path', path: nodePath } : undefined;
    }
    case 'ephemeral-volume': {
      const name = readRequiredString(value.name, `${path}.name`, issues);
      const sizeMb = readPositiveInteger(value.sizeMb, `${path}.sizeMb`, issues);
      return name ? { kind: 'ephemeral-volume', name, ...(sizeMb === undefined ? {} : { sizeMb }) } : undefined;
    }
    default:
      issues.push({ path: `${path}.kind`, reason: 'invalid-value', message: 'Workspace mount source kind must be workspace-ref, node-path, or ephemeral-volume.' });
      return undefined;
  }
}

function readPortExposureRequests(
  launchConfig: Readonly<Record<string, unknown>>,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): readonly RemoteRuntimePortExposureRequest[] {
  if (launchConfig.ports === undefined) {
    return [];
  }
  if (!Array.isArray(launchConfig.ports)) {
    issues.push({ path: 'runtimeLaunch.ports', reason: 'invalid-type', message: 'runtimeLaunch.ports must be an array.' });
    return [];
  }

  return launchConfig.ports.flatMap((item, index) => readPortExposureRequest(item, index, issues));
}

function readPortExposureRequest(
  value: unknown,
  index: number,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): readonly RemoteRuntimePortExposureRequest[] {
  const basePath = `runtimeLaunch.ports.${index}`;
  if (!isRecord(value)) {
    issues.push({ path: basePath, reason: 'invalid-type', message: 'Port exposure requests must be objects.' });
    return [];
  }

  const name = readRequiredString(value.name, `${basePath}.name`, issues);
  const targetPort = readPortNumber(value.targetPort, `${basePath}.targetPort`, issues);
  const protocol = readRequiredStringEnum(value.protocol, `${basePath}.protocol`, ['tcp', 'udp', 'http', 'https'], issues);
  const exposure = readRequiredStringEnum(value.exposure, `${basePath}.exposure`, ['loopback', 'node-private', 'fleet-private', 'public'], issues);
  const requestedHostPort = readPortNumber(value.requestedHostPort, `${basePath}.requestedHostPort`, issues);
  if (!name || targetPort === undefined || !protocol || !exposure) {
    return [];
  }

  return [{
    name,
    targetPort,
    protocol,
    exposure,
    ...(requestedHostPort === undefined ? {} : { requestedHostPort }),
  }];
}

function readProvider(
  runtimeKind: RemoteFleetRuntimeKind,
  launchConfig: Readonly<Record<string, unknown>>,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): RemoteRuntimeLaunchSpec['provider'] | undefined {
  switch (runtimeKind) {
    case 'openclaw':
      return readOpenClawProvider(launchConfig, issues);
    case 'matcha-agent':
      return readMatchaAgentProvider(launchConfig, issues);
    case 'plugin-runtime':
      return readPluginRuntimeProvider(launchConfig, issues);
  }
}

function readOpenClawProvider(
  launchConfig: Readonly<Record<string, unknown>>,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): OpenClawRemoteRuntimeLaunchProvider {
  const config = readOptionalProviderConfig(launchConfig.openclaw, 'runtimeLaunch.openclaw', issues);
  const launchMode = readStringEnum(config.launchMode, 'runtimeLaunch.openclaw.launchMode', ['gateway', 'native-runtime'], issues) ?? 'gateway';
  const configProfile = readOptionalString(config.configProfile, 'runtimeLaunch.openclaw.configProfile', issues);
  return { kind: 'openclaw', launchMode, ...(configProfile ? { configProfile } : {}) };
}

function readMatchaAgentProvider(
  launchConfig: Readonly<Record<string, unknown>>,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): MatchaAgentRemoteRuntimeLaunchProvider {
  const config = readOptionalProviderConfig(launchConfig.matchaAgent, 'runtimeLaunch.matchaAgent', issues);
  const launchMode = readStringEnum(config.launchMode, 'runtimeLaunch.matchaAgent.launchMode', ['daemon', 'app-server'], issues) ?? 'daemon';
  const appServerBasePath = readOptionalString(config.appServerBasePath, 'runtimeLaunch.matchaAgent.appServerBasePath', issues);
  return { kind: 'matcha-agent', launchMode, ...(appServerBasePath ? { appServerBasePath } : {}) };
}

function readPluginRuntimeProvider(
  launchConfig: Readonly<Record<string, unknown>>,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): PluginRuntimeRemoteRuntimeLaunchProvider | undefined {
  const config = readOptionalProviderConfig(launchConfig.pluginRuntime, 'runtimeLaunch.pluginRuntime', issues);
  const pluginId = readRequiredString(config.pluginId, 'runtimeLaunch.pluginRuntime.pluginId', issues);
  const entrypoint = readOptionalString(config.entrypoint, 'runtimeLaunch.pluginRuntime.entrypoint', issues);
  return pluginId ? { kind: 'plugin-runtime', pluginId, ...(entrypoint ? { entrypoint } : {}) } : undefined;
}

function readOptionalProviderConfig(
  value: unknown,
  path: string,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): Readonly<Record<string, unknown>> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    issues.push({ path, reason: 'invalid-type', message: `${path} must be an object.` });
    return {};
  }
  return value;
}

function buildLaunchCommand(
  spec: RemoteRuntimeLaunchSpec,
  readiness: RemoteRuntimeReadinessSyncHints,
  capabilitySync: RemoteRuntimeCapabilitySyncHints,
  secretPlaceholders: readonly RemoteRuntimeSecretPlaceholder[],
): RemoteRuntimeLaunchCommand {
  const base = buildLaunchCommandBase(spec, readiness, capabilitySync, secretPlaceholders);
  switch (spec.runtimeKind) {
    case 'openclaw':
      return {
        ...base,
        runtimeKind: 'openclaw',
        provider: spec.provider,
        executable: {
          kind: 'openclaw-runtime',
          launchMode: spec.provider.launchMode,
          ...(spec.provider.configProfile ? { configProfile: spec.provider.configProfile } : {}),
        },
      };
    case 'matcha-agent':
      return {
        ...base,
        runtimeKind: 'matcha-agent',
        provider: spec.provider,
        executable: {
          kind: 'matcha-agent-runtime',
          launchMode: spec.provider.launchMode,
          ...(spec.provider.appServerBasePath ? { appServerBasePath: spec.provider.appServerBasePath } : {}),
        },
      };
    case 'plugin-runtime':
      return {
        ...base,
        runtimeKind: 'plugin-runtime',
        provider: spec.provider,
        executable: {
          kind: 'openclaw-plugin-runtime',
          pluginId: spec.provider.pluginId,
          entrypoint: spec.provider.entrypoint ?? 'runtime',
        },
      };
  }
}

function buildLaunchCommandBase(
  spec: RemoteRuntimeLaunchSpec,
  readiness: RemoteRuntimeReadinessSyncHints,
  capabilitySync: RemoteRuntimeCapabilitySyncHints,
  secretPlaceholders: readonly RemoteRuntimeSecretPlaceholder[],
): Omit<RemoteRuntimeLaunchCommandBase, 'runtimeKind'> {
  return {
    commandVersion: REMOTE_RUNTIME_LAUNCH_COMMAND_PAYLOAD_VERSION,
    commandType: 'start-runtime',
    runtimeId: spec.runtimeId,
    nodeId: spec.nodeId,
    displayName: spec.displayName,
    environment: {
      public: spec.environment.public,
      secretPlaceholders,
    },
    ...(spec.resourceLimits ? { resourceLimits: spec.resourceLimits } : {}),
    workspaceMounts: spec.workspaceMounts,
    portExposures: spec.portExposures,
    readiness,
    capabilitySync,
  };
}

function buildReadinessSyncHints(spec: RemoteRuntimeLaunchSpec): RemoteRuntimeReadinessSyncHints {
  return {
    expectedRuntimeId: spec.runtimeId,
    expectedNodeId: spec.nodeId,
    expectedRuntimeKind: spec.runtimeKind,
    requiredSignals: buildReadinessSignals(spec.runtimeKind),
    ackAdvancesLifecycle: true,
  };
}

function buildReadinessSignals(runtimeKind: RemoteFleetRuntimeKind): readonly RemoteRuntimeReadinessSignal[] {
  const commonSignals: RemoteRuntimeReadinessSignal[] = [
    {
      signal: 'process-started',
      required: true,
      description: 'RuntimeAgent must ACK that the runtime process launch was accepted or started before lifecycle can advance.',
    },
    {
      signal: 'runtime-endpoint-ready',
      required: true,
      description: 'RuntimeAgent must report the runtime endpoint identity before Remote Fleet treats the runtime as ready.',
    },
  ];

  if (runtimeKind === 'plugin-runtime') {
    return commonSignals;
  }

  return [
    ...commonSignals,
    {
      signal: 'health-probe-ready',
      required: true,
      description: 'RuntimeAgent must complete a provider readiness probe before capability sync is trusted.',
    },
  ];
}

function buildCapabilitySyncHints(spec: RemoteRuntimeLaunchSpec): RemoteRuntimeCapabilitySyncHints {
  return {
    syncAfterReady: true,
    expectedRuntimeId: spec.runtimeId,
    strategy: 'runtime-agent-capabilities-sync',
    capabilityKinds: buildCapabilitySyncKinds(spec.runtimeKind),
  };
}

function buildCapabilitySyncKinds(runtimeKind: RemoteFleetRuntimeKind): readonly RemoteRuntimeCapabilitySyncKind[] {
  switch (runtimeKind) {
    case 'openclaw':
      return ['agent-runtime-endpoint', 'session-runtime', 'tool-capabilities', 'plugin-capabilities'];
    case 'matcha-agent':
      return ['agent-runtime-endpoint', 'session-runtime', 'tool-capabilities'];
    case 'plugin-runtime':
      return ['agent-runtime-endpoint', 'plugin-capabilities'];
  }
}

function buildUnsupportedReasons(runtimeKind: RemoteFleetRuntimeKind): readonly RemoteRuntimeLaunchUnsupportedReason[] {
  switch (runtimeKind) {
    case 'openclaw':
    case 'matcha-agent':
    case 'plugin-runtime':
      return [];
  }
}

function buildSecretPlaceholders(secretEnv: readonly RemoteRuntimeSecretEnvironmentVariable[]): readonly RemoteRuntimeSecretPlaceholder[] {
  return secretEnv.map((entry) => ({
    envName: entry.name,
    secretRefName: entry.secretRefName,
    secretRef: entry.secretRef,
    placeholder: entry.placeholder,
  }));
}

function buildReferencedSecretRefs(secretEnv: readonly RemoteRuntimeSecretEnvironmentVariable[]): Record<string, RemoteFleetSecretRef> {
  return Object.fromEntries(secretEnv.map((entry) => [entry.secretRefName, entry.secretRef]));
}

function buildSanitizedLaunchPublicConfig(
  spec: RemoteRuntimeLaunchSpec,
  readiness: RemoteRuntimeReadinessSyncHints,
  capabilitySync: RemoteRuntimeCapabilitySyncHints,
): Record<string, unknown> {
  return {
    [REMOTE_RUNTIME_LAUNCH_CONFIG_KEY]: {
      specVersion: spec.specVersion,
      runtimeKind: spec.runtimeKind,
      provider: spec.provider,
      environment: {
        public: spec.environment.public,
        secrets: spec.environment.secrets.map((entry) => ({
          name: entry.name,
          secretRefName: entry.secretRefName,
          placeholder: entry.placeholder,
        })),
      },
      readiness,
      capabilitySync,
      ...(spec.resourceLimits ? { resourceLimits: spec.resourceLimits } : {}),
      workspaceMounts: spec.workspaceMounts,
      portExposures: spec.portExposures,
    },
  };
}

function buildSecretPlaceholder(envName: string): string {
  return `{{remote-fleet.secret-env.${envName}}}`;
}

function readRequiredString(
  value: unknown,
  path: string,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    issues.push({ path, reason: 'missing-required-field', message: `${path} must be a non-empty string.` });
    return undefined;
  }
  return value.trim();
}

function readOptionalString(
  value: unknown,
  path: string,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    issues.push({ path, reason: 'invalid-type', message: `${path} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringEnum<T extends string>(
  value: unknown,
  path: string,
  allowedValues: readonly T[],
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readEnumValue(value, path, allowedValues, issues, 'invalid-type');
}

function readRequiredStringEnum<T extends string>(
  value: unknown,
  path: string,
  allowedValues: readonly T[],
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): T | undefined {
  if (value === undefined) {
    issues.push({ path, reason: 'missing-required-field', message: `${path} must be one of: ${allowedValues.join(', ')}.` });
    return undefined;
  }
  return readEnumValue(value, path, allowedValues, issues, 'invalid-type');
}

function readEnumValue<T extends string>(
  value: unknown,
  path: string,
  allowedValues: readonly T[],
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
  invalidTypeReason: RemoteRuntimeLaunchSpecValidationIssue['reason'],
): T | undefined {
  if (typeof value !== 'string') {
    issues.push({ path, reason: invalidTypeReason, message: `${path} must be a string.` });
    return undefined;
  }
  if (!allowedValues.includes(value as T)) {
    issues.push({ path, reason: 'invalid-value', message: `${path} must be one of: ${allowedValues.join(', ')}.` });
    return undefined;
  }
  return value as T;
}

function readPositiveNumber(
  value: unknown,
  path: string,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    issues.push({ path, reason: 'invalid-value', message: `${path} must be a positive number.` });
    return undefined;
  }
  return value;
}

function readPositiveInteger(
  value: unknown,
  path: string,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): number | undefined {
  const numberValue = readPositiveNumber(value, path, issues);
  if (numberValue === undefined) {
    return undefined;
  }
  if (!Number.isInteger(numberValue)) {
    issues.push({ path, reason: 'invalid-value', message: `${path} must be an integer.` });
    return undefined;
  }
  return numberValue;
}

function readNonNegativeInteger(
  value: unknown,
  path: string,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    issues.push({ path, reason: 'invalid-value', message: `${path} must be a non-negative integer.` });
    return undefined;
  }
  return value;
}

function readPortNumber(
  value: unknown,
  path: string,
  issues: RemoteRuntimeLaunchSpecValidationIssue[],
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    issues.push({ path, reason: 'invalid-value', message: `${path} must be an integer port between 1 and 65535.` });
    return undefined;
  }
  return value;
}

function isEnvironmentVariableName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareByName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name);
}
