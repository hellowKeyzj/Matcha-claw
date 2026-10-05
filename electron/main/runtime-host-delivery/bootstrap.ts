import { posix, win32 } from 'node:path';

const RUNTIME_HOST_BOOTSTRAP_VERSION = 1;
const MAX_PORT = 65_535;

export type RuntimeHostBootstrapPlatform = 'unix' | 'win32';

export interface RuntimeHostBootstrapMatchaInput {
  readonly bunExecutable: string;
  readonly entry: string;
  readonly workingDirectory: string;
  readonly storageRoot: string;
  readonly port: number;
}

export interface RuntimeHostBootstrapOpenClawInput {
  readonly electronImage: string;
  readonly workingDirectory: string;
  readonly openclawDir: string;
  readonly managedPluginRoot: string;
  readonly companionSkillSourceRoot: string;
  readonly subagentTemplateDir: string;
  readonly entry: string;
  readonly stateDir: string;
  readonly port: number;
}

interface RuntimeHostBootstrapBaseInput {
  readonly appVersion: string;
  /** Electron Main's own log directory, collected by the Host diagnostics archive. */
  readonly appLogDir: string;
  /** MatchaClaw Host-owned durable state root. */
  readonly runtimeHostStateDir: string;
  /** Native Matcha MCP stdio executable started by OpenClaw. */
  readonly runtimeHostMcpExecutable: string;
  /** Sealed Main-only provider credential resolver. */
  readonly providerCredentialResolver?: Readonly<{
    readonly endpoint: string;
    readonly authorization: string;
  }>;
  /** Electron Main's per-host verification key; its matching private key never leaves Main. */
  readonly deliveryVerificationKey: string;
  /** Loopback callback receiver URL for Rust-to-Main event delivery. */
  readonly parentCallbackBaseUrl: string;
  /** Per-runtime opaque token for the Rust-to-Main callback receiver. */
  readonly parentCallbackDispatchToken: string;
  /** Fixed loopback runtime-host compatibility transport port. */
  readonly runtimeHostTransportPort: number;
  readonly matcha: RuntimeHostBootstrapMatchaInput;
  readonly openClaw: RuntimeHostBootstrapOpenClawInput;
}

export interface UnixRuntimeHostBootstrapInput extends RuntimeHostBootstrapBaseInput {
  readonly platform: 'unix';
  readonly guardianExecutable: string;
}

export interface WindowsRuntimeHostBootstrapInput extends RuntimeHostBootstrapBaseInput {
  readonly platform: 'win32';
  readonly matcha: RuntimeHostBootstrapMatchaInput & {
    readonly gitBash: string;
  };
}

export type RuntimeHostBootstrapInput =
  UnixRuntimeHostBootstrapInput | WindowsRuntimeHostBootstrapInput;

export class RuntimeHostBootstrapValidationError extends Error {
  constructor(readonly fieldName: string) {
    super(`Runtime-host bootstrap ${fieldName} is invalid.`);
    this.name = 'RuntimeHostBootstrapValidationError';
  }
}

export function buildRuntimeHostBootstrap(input: RuntimeHostBootstrapInput): Uint8Array {
  validateBootstrapInput(input);

  const matcha = {
    bunExecutable: input.matcha.bunExecutable,
    entry: input.matcha.entry,
    workingDirectory: input.matcha.workingDirectory,
    storageRoot: input.matcha.storageRoot,
    port: input.matcha.port,
    ...(input.platform === 'win32' ? { gitBash: input.matcha.gitBash } : {}),
  };
  const payload = {
    version: RUNTIME_HOST_BOOTSTRAP_VERSION,
    appVersion: input.appVersion,
    appLogDir: input.appLogDir,
    runtimeHostStateDir: input.runtimeHostStateDir,
    runtimeHostMcpExecutable: input.runtimeHostMcpExecutable,
    ...(input.providerCredentialResolver
      ? {
          providerCredentialResolver: {
            endpoint: input.providerCredentialResolver.endpoint,
            authorization: input.providerCredentialResolver.authorization,
          },
        }
      : {}),
    deliveryVerificationKey: input.deliveryVerificationKey,
    parentCallbackBaseUrl: input.parentCallbackBaseUrl,
    parentCallbackDispatchToken: input.parentCallbackDispatchToken,
    runtimeHostTransportPort: input.runtimeHostTransportPort,
    matcha,
    openClaw: {
      electronImage: input.openClaw.electronImage,
      workingDirectory: input.openClaw.workingDirectory,
      openclawDir: input.openClaw.openclawDir,
      managedPluginRoot: input.openClaw.managedPluginRoot,
      companionSkillSourceRoot: input.openClaw.companionSkillSourceRoot,
      subagentTemplateDir: input.openClaw.subagentTemplateDir,
      entry: input.openClaw.entry,
      stateDir: input.openClaw.stateDir,
      port: input.openClaw.port,
    },
    ...(input.platform === 'unix' ? { guardianExecutable: input.guardianExecutable } : {}),
  };

  return new TextEncoder().encode(JSON.stringify(payload));
}

function validateBootstrapInput(input: RuntimeHostBootstrapInput): void {
  if (input.platform !== 'unix' && input.platform !== 'win32') {
    throw new RuntimeHostBootstrapValidationError('platform');
  }
  if (typeof input.appVersion !== 'string' || input.appVersion.trim().length === 0) {
    throw new RuntimeHostBootstrapValidationError('appVersion');
  }
  validateAbsolutePath(input.appLogDir, 'appLogDir', input.platform);
  validateDeliveryVerificationKey(input.deliveryVerificationKey);
  validateAbsolutePath(input.runtimeHostStateDir, 'runtimeHostStateDir', input.platform);
  validateAbsolutePath(input.runtimeHostMcpExecutable, 'runtimeHostMcpExecutable', input.platform);
  validateParentCallbackBaseUrl(input.parentCallbackBaseUrl);
  validateParentCallbackDispatchToken(input.parentCallbackDispatchToken);
  validatePrivateResolver(input.providerCredentialResolver, 'providerCredentialResolver', '/resolve');
  validatePort(input.runtimeHostTransportPort, 'runtimeHostTransportPort');
  validateMatchaInput(input.matcha, input.platform);
  validateOpenClawInput(input.openClaw, input.platform);
  const ports = [
    input.runtimeHostTransportPort,
    input.matcha.port,
    input.openClaw.port,
  ];
  if (new Set(ports).size !== ports.length) {
    throw new RuntimeHostBootstrapValidationError('ports');
  }

  if (input.platform === 'unix') {
    validateAbsolutePath(input.guardianExecutable, 'guardianExecutable', input.platform);
  } else {
    validateAbsolutePath(input.matcha.gitBash, 'matcha.gitBash', input.platform);
  }
}

function validateDeliveryVerificationKey(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{59}$/.test(value)) {
    throw new RuntimeHostBootstrapValidationError('deliveryVerificationKey');
  }
}

function validateParentCallbackBaseUrl(value: string): void {
  if (
    typeof value !== 'string'
    || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)
  ) {
    throw new RuntimeHostBootstrapValidationError('parentCallbackBaseUrl');
  }
  const port = Number(value.slice(value.lastIndexOf(':') + 1));
  if (port > MAX_PORT) {
    throw new RuntimeHostBootstrapValidationError('parentCallbackBaseUrl');
  }
}

function validateParentCallbackDispatchToken(value: string): void {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > 256
    || value.includes('\\0')
  ) {
    throw new RuntimeHostBootstrapValidationError('parentCallbackDispatchToken');
  }
}

function validatePrivateResolver(
  resolver: Readonly<{ endpoint: string; authorization: string }> | undefined,
  fieldName: string,
  path: string,
): void {
  if (!resolver) return;
  const endpoint = typeof resolver.endpoint === 'string'
    ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})(\/[a-z-]+)$/.exec(resolver.endpoint)
    : undefined;
  if (!endpoint
    || Number(endpoint[1]) > MAX_PORT
    || endpoint[2] !== path
    || typeof resolver.authorization !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(resolver.authorization)) {
    throw new RuntimeHostBootstrapValidationError(fieldName);
  }
}


function validateMatchaInput(
  input: RuntimeHostBootstrapMatchaInput,
  platform: RuntimeHostBootstrapPlatform
): void {
  validateAbsolutePath(input.bunExecutable, 'matcha.bunExecutable', platform);
  validateAbsolutePath(input.entry, 'matcha.entry', platform);
  validateAbsolutePath(input.workingDirectory, 'matcha.workingDirectory', platform);
  validateAbsolutePath(input.storageRoot, 'matcha.storageRoot', platform);
  validatePort(input.port, 'matcha.port');
}

function validateOpenClawInput(
  input: RuntimeHostBootstrapOpenClawInput,
  platform: RuntimeHostBootstrapPlatform
): void {
  validateAbsolutePath(input.electronImage, 'openClaw.electronImage', platform);
  validateAbsolutePath(input.workingDirectory, 'openClaw.workingDirectory', platform);
  validateAbsolutePath(input.openclawDir, 'openClaw.openclawDir', platform);
  validateAbsolutePath(input.managedPluginRoot, 'openClaw.managedPluginRoot', platform);
  validateAbsolutePath(input.companionSkillSourceRoot, 'openClaw.companionSkillSourceRoot', platform);
  validateAbsolutePath(input.subagentTemplateDir, 'openClaw.subagentTemplateDir', platform);
  validateAbsolutePath(input.entry, 'openClaw.entry', platform);
  validateAbsolutePath(input.stateDir, 'openClaw.stateDir', platform);
  validatePort(input.port, 'openClaw.port');
}

function validateAbsolutePath(
  value: string,
  fieldName: string,
  platform: RuntimeHostBootstrapPlatform
): void {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new RuntimeHostBootstrapValidationError(fieldName);
  }

  const isAbsolute = platform === 'win32' ? win32.isAbsolute(value) : posix.isAbsolute(value);
  if (!isAbsolute) {
    throw new RuntimeHostBootstrapValidationError(fieldName);
  }
}

function validatePort(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PORT) {
    throw new RuntimeHostBootstrapValidationError(fieldName);
  }
}
