import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
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
  readonly privateSecretRoot: string;
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
  /** Native TeamRun MCP stdio executable started by OpenClaw. */
  readonly runtimeHostMcpExecutable: string;
  /** Sealed Main-only provider credential resolver. */
  readonly providerCredentialResolver?: Readonly<{
    readonly endpoint: string;
    readonly authorization: string;
  }>;
  /** Electron Main's per-host verification key; its matching private key never leaves Main. */
  readonly deliveryVerificationKey: string;
  /** Dedicated Cron broker verification key; its matching private key stays in app-server private storage. */
  readonly cronBrokerVerificationKey: string;
  /** Loopback callback receiver URL for Rust-to-Main event delivery. */
  readonly parentCallbackBaseUrl: string;
  /** Per-runtime opaque token for the Rust-to-Main callback receiver. */
  readonly parentCallbackDispatchToken: string;
  /** Fixed loopback public session-list transport port. */
  readonly sessionTransportPort: number;
  /** Fixed loopback public Fleet transport port. */
  readonly fleetTransportPort: number;
  /** Fixed loopback public diagnostics archive transport port. */
  readonly diagnosticsTransportPort: number;
  /** Fixed loopback public workspace text transport port. */
  readonly workspaceTextTransportPort: number;
  /** Fixed loopback public workspace binary/stat transport port. */
  readonly workspaceBinaryTransportPort: number;
  /** Fixed loopback public workspace directory transport port. */
  readonly workspaceDirectoryTransportPort: number;
  /** Fixed loopback public workspace write transport port. */
  readonly workspaceWriteTransportPort: number;
  /** Fixed loopback public workspace media transport port. */
  readonly workspaceMediaTransportPort: number;
  /** Fixed loopback public session send transport port. */
  readonly sessionSendTransportPort: number;
  /** Fixed loopback public session abort transport port. */
  readonly sessionAbortTransportPort: number;
  /** Fixed loopback public security emergency transport port. */
  readonly securityEmergencyTransportPort: number;
  /** Fixed loopback public channel account status transport port. */
  readonly channelStatusTransportPort: number;
  /** Fixed loopback public channel catalog transport port. */
  readonly channelCatalogTransportPort: number;
  /** Fixed loopback public channel runtime control transport port. */
  readonly channelControlTransportPort: number;
  /** Fixed loopback public channel pairing-list transport port. */
  readonly channelPairingTransportPort: number;
  /** Fixed loopback Settings desired-state transport port. */
  readonly settingsDesiredTransportPort: number;
  /** Fixed loopback Security policy transport port. */
  readonly securityPolicyTransportPort: number;
  /** Fixed loopback public session approval transport port. */
  readonly sessionApprovalTransportPort: number;
  /** Fixed loopback public Matcha Agent chat history transport port. */
  readonly matchaHistoryTransportPort: number;
  /** Fixed loopback public OpenClaw usage history transport port. */
  readonly usageTransportPort: number;
  /** Fixed loopback public session model selection transport port. */
  readonly sessionModelSelectionTransportPort: number;
  /** Fixed loopback public cron CRUD/list transport port. */
  readonly cronTransportPort: number;
  /** Dedicated loopback Cron broker transport port. */
  readonly cronBrokerTransportPort: number;
  /** Fixed loopback public Task Manager transport port. */
  readonly taskManagerTransportPort: number;
  /** Fixed loopback public subagent management transport port. */
  readonly agentsTransportPort: number;
  /** Fixed loopback public Team projection transport port. */
  readonly teamPublicTransportPort: number;
  readonly teamTaskBoardTransportPort: number;
  /** Fixed loopback public Team role-session projection transport port. */
  readonly teamRoleSessionsTransportPort: number;
  /** Fixed loopback public Team pending approvals transport port. */
  readonly teamApprovalsTransportPort: number;
  /** Fixed loopback public Team human decision transport port. */
  readonly teamDecisionTransportPort: number;
  /** Fixed loopback public Team role-chat transport port. */
  readonly teamRoleChatTransportPort: number;
  /** Fixed loopback public Team graph YAML transport port. */
  readonly teamGraphTransportPort: number;
  /** Fixed loopback public provider model catalog transport port. */
  readonly providerModelsTransportPort: number;
  /** Fixed loopback public provider account catalog transport port. */
  readonly providerAccountsTransportPort: number;
  /** Fixed loopback public TeamSkill selection transport port. */
  readonly teamSkillTransportPort: number;
  /** Fixed loopback public Team trigger transport port. */
  readonly teamTriggerTransportPort: number;
  /** Fixed loopback public Team lifecycle transport port. */
  readonly teamLifecycleTransportPort: number;
  /** Fixed loopback public Manual Team materialize-and-create transport port. */
  readonly manualTeamTransportPort: number;
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
    privateSecretRoot: input.matcha.privateSecretRoot,
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
    cronBrokerVerificationKey: input.cronBrokerVerificationKey,
    parentCallbackBaseUrl: input.parentCallbackBaseUrl,
    parentCallbackDispatchToken: input.parentCallbackDispatchToken,
    sessionTransportPort: input.sessionTransportPort,
    fleetTransportPort: input.fleetTransportPort,
    diagnosticsTransportPort: input.diagnosticsTransportPort,
    workspaceTextTransportPort: input.workspaceTextTransportPort,
    workspaceBinaryTransportPort: input.workspaceBinaryTransportPort,
    workspaceDirectoryTransportPort: input.workspaceDirectoryTransportPort,
    workspaceWriteTransportPort: input.workspaceWriteTransportPort,
    workspaceMediaTransportPort: input.workspaceMediaTransportPort,
    sessionSendTransportPort: input.sessionSendTransportPort,
    sessionAbortTransportPort: input.sessionAbortTransportPort,
    securityEmergencyTransportPort: input.securityEmergencyTransportPort,
    channelStatusTransportPort: input.channelStatusTransportPort,
    channelCatalogTransportPort: input.channelCatalogTransportPort,
    channelControlTransportPort: input.channelControlTransportPort,
    channelPairingTransportPort: input.channelPairingTransportPort,
    settingsDesiredTransportPort: input.settingsDesiredTransportPort,
    securityPolicyTransportPort: input.securityPolicyTransportPort,
    sessionApprovalTransportPort: input.sessionApprovalTransportPort,
    matchaHistoryTransportPort: input.matchaHistoryTransportPort,
    usageTransportPort: input.usageTransportPort,
    sessionModelSelectionTransportPort: input.sessionModelSelectionTransportPort,
    cronTransportPort: input.cronTransportPort,
    cronBrokerTransportPort: input.cronBrokerTransportPort,
    taskManagerTransportPort: input.taskManagerTransportPort,
    agentsTransportPort: input.agentsTransportPort,
    teamPublicTransportPort: input.teamPublicTransportPort,
    teamTaskBoardTransportPort: input.teamTaskBoardTransportPort,
    teamRoleSessionsTransportPort: input.teamRoleSessionsTransportPort,
    teamApprovalsTransportPort: input.teamApprovalsTransportPort,
    teamDecisionTransportPort: input.teamDecisionTransportPort,
    teamRoleChatTransportPort: input.teamRoleChatTransportPort,
    teamGraphTransportPort: input.teamGraphTransportPort,
    providerModelsTransportPort: input.providerModelsTransportPort,
    providerAccountsTransportPort: input.providerAccountsTransportPort,
    teamSkillTransportPort: input.teamSkillTransportPort,
    teamTriggerTransportPort: input.teamTriggerTransportPort,
    teamLifecycleTransportPort: input.teamLifecycleTransportPort,
    manualTeamTransportPort: input.manualTeamTransportPort,
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
  validateCronBrokerVerificationKey(input.cronBrokerVerificationKey);
  validateAbsolutePath(input.runtimeHostStateDir, 'runtimeHostStateDir', input.platform);
  validateAbsolutePath(input.runtimeHostMcpExecutable, 'runtimeHostMcpExecutable', input.platform);
  validateParentCallbackBaseUrl(input.parentCallbackBaseUrl);
  validateParentCallbackDispatchToken(input.parentCallbackDispatchToken);
  validatePrivateResolver(input.providerCredentialResolver, 'providerCredentialResolver', '/resolve');
  validatePort(input.sessionTransportPort, 'sessionTransportPort');
  validatePort(input.fleetTransportPort, 'fleetTransportPort');
  validatePort(input.diagnosticsTransportPort, 'diagnosticsTransportPort');
  validatePort(input.workspaceTextTransportPort, 'workspaceTextTransportPort');
  validatePort(input.workspaceBinaryTransportPort, 'workspaceBinaryTransportPort');
  validatePort(input.workspaceDirectoryTransportPort, 'workspaceDirectoryTransportPort');
  validatePort(input.workspaceWriteTransportPort, 'workspaceWriteTransportPort');
  validatePort(input.workspaceMediaTransportPort, 'workspaceMediaTransportPort');
  validatePort(input.sessionSendTransportPort, 'sessionSendTransportPort');
  validatePort(input.sessionAbortTransportPort, 'sessionAbortTransportPort');
  validatePort(input.securityEmergencyTransportPort, 'securityEmergencyTransportPort');
  validatePort(input.channelStatusTransportPort, 'channelStatusTransportPort');
  validatePort(input.channelCatalogTransportPort, 'channelCatalogTransportPort');
  validatePort(input.channelControlTransportPort, 'channelControlTransportPort');
  validatePort(input.channelPairingTransportPort, 'channelPairingTransportPort');
  validatePort(input.settingsDesiredTransportPort, 'settingsDesiredTransportPort');
  validatePort(input.securityPolicyTransportPort, 'securityPolicyTransportPort');
  validatePort(input.sessionApprovalTransportPort, 'sessionApprovalTransportPort');
  validatePort(input.matchaHistoryTransportPort, 'matchaHistoryTransportPort');
  validatePort(input.usageTransportPort, 'usageTransportPort');
  validatePort(input.sessionModelSelectionTransportPort, 'sessionModelSelectionTransportPort');
  validatePort(input.cronTransportPort, 'cronTransportPort');
  validatePort(input.cronBrokerTransportPort, 'cronBrokerTransportPort');
  validatePort(input.taskManagerTransportPort, 'taskManagerTransportPort');
  validatePort(input.agentsTransportPort, 'agentsTransportPort');
  validatePort(input.teamPublicTransportPort, 'teamPublicTransportPort');
  validatePort(input.teamTaskBoardTransportPort, 'teamTaskBoardTransportPort');
  validatePort(input.teamRoleSessionsTransportPort, 'teamRoleSessionsTransportPort');
  validatePort(input.teamApprovalsTransportPort, 'teamApprovalsTransportPort');
  validatePort(input.teamDecisionTransportPort, 'teamDecisionTransportPort');
  validatePort(input.teamRoleChatTransportPort, 'teamRoleChatTransportPort');
  validatePort(input.teamGraphTransportPort, 'teamGraphTransportPort');
  validatePort(input.providerModelsTransportPort, 'providerModelsTransportPort');
  validatePort(input.providerAccountsTransportPort, 'providerAccountsTransportPort');
  validatePort(input.teamSkillTransportPort, 'teamSkillTransportPort');
  validatePort(input.teamTriggerTransportPort, 'teamTriggerTransportPort');
  validatePort(input.teamLifecycleTransportPort, 'teamLifecycleTransportPort');
  validatePort(input.manualTeamTransportPort, 'manualTeamTransportPort');
  if (
    new Set([
      input.sessionTransportPort,
      input.fleetTransportPort,
      input.diagnosticsTransportPort,
      input.workspaceTextTransportPort,
      input.workspaceBinaryTransportPort,
      input.workspaceDirectoryTransportPort,
      input.workspaceWriteTransportPort,
      input.workspaceMediaTransportPort,
      input.sessionSendTransportPort,
      input.sessionAbortTransportPort,
      input.securityEmergencyTransportPort,
      input.channelStatusTransportPort,
      input.channelCatalogTransportPort,
      input.channelControlTransportPort,
      input.channelPairingTransportPort,
      input.settingsDesiredTransportPort,
      input.securityPolicyTransportPort,
      input.sessionApprovalTransportPort,
      input.matchaHistoryTransportPort,
      input.usageTransportPort,
      input.sessionModelSelectionTransportPort,
      input.cronTransportPort,
      input.cronBrokerTransportPort,
      input.taskManagerTransportPort,
      input.agentsTransportPort,
      input.teamPublicTransportPort,
      input.teamTaskBoardTransportPort,
      input.teamRoleSessionsTransportPort,
      input.teamApprovalsTransportPort,
      input.teamDecisionTransportPort,
      input.teamRoleChatTransportPort,
      input.teamGraphTransportPort,
      input.providerModelsTransportPort,
      input.providerAccountsTransportPort,
      input.teamSkillTransportPort,
      input.teamTriggerTransportPort,
      input.teamLifecycleTransportPort,
      input.manualTeamTransportPort,
    ]).size !== 38
  ) {
    throw new RuntimeHostBootstrapValidationError('transportPorts');
  }

  validateMatchaInput(input.matcha, input.platform);
  validateOpenClawInput(input.openClaw, input.platform);
  const ports = [
    input.sessionTransportPort,
    input.fleetTransportPort,
    input.diagnosticsTransportPort,
    input.workspaceTextTransportPort,
    input.workspaceBinaryTransportPort,
    input.workspaceDirectoryTransportPort,
    input.workspaceWriteTransportPort,
    input.workspaceMediaTransportPort,
    input.sessionSendTransportPort,
    input.sessionAbortTransportPort,
    input.securityEmergencyTransportPort,
    input.channelStatusTransportPort,
    input.channelControlTransportPort,
    input.channelPairingTransportPort,
    input.settingsDesiredTransportPort,
    input.securityPolicyTransportPort,
    input.sessionApprovalTransportPort,
    input.matchaHistoryTransportPort,
    input.usageTransportPort,
    input.sessionModelSelectionTransportPort,
    input.cronTransportPort,
    input.cronBrokerTransportPort,
    input.taskManagerTransportPort,
    input.agentsTransportPort,
    input.teamPublicTransportPort,
    input.teamTaskBoardTransportPort,
    input.teamRoleSessionsTransportPort,
    input.teamApprovalsTransportPort,
    input.teamDecisionTransportPort,
    input.teamRoleChatTransportPort,
    input.teamGraphTransportPort,
    input.providerModelsTransportPort,
    input.providerAccountsTransportPort,
    input.teamSkillTransportPort,
    input.teamTriggerTransportPort,
    input.teamLifecycleTransportPort,
    input.manualTeamTransportPort,
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

function validateCronBrokerVerificationKey(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{59}$/.test(value)) {
    throw new RuntimeHostBootstrapValidationError('cronBrokerVerificationKey');
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

export function createRuntimeHostDeliveryIssuer(): RuntimeHostDeliveryIssuer {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    verificationKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    signDecision: (input) => {
      validateDecisionInput(input);
      const payload = Buffer.from(
        JSON.stringify({
          version: 1,
          principal: input.principal,
          endpoint: input.endpoint,
          scope: input.scope,
          capability: input.capability,
          subject: input.subject,
          expiresAt: input.expiresAt,
          correlation: input.correlation ?? `corr:${randomUUID()}`,
          revision: input.revision,
        })
      ).toString('base64url');
      const signed = `capability-decision.v1.${payload}`;
      return `${signed}.${sign(null, Buffer.from(signed), privateKey).toString('base64url')}`;
    },
  };
}

export interface RuntimeHostDeliveryDecisionInput {
  readonly principal: string;
  readonly endpoint: string;
  readonly scope: string;
  readonly capability: string;
  readonly subject: string;
  readonly expiresAt: number;
  readonly revision: string;
  readonly correlation?: string;
}

export interface RuntimeHostDeliveryIssuer {
  readonly verificationKey: string;
  readonly signDecision: (input: RuntimeHostDeliveryDecisionInput) => string;
}

function validateDecisionInput(input: RuntimeHostDeliveryDecisionInput): void {
  const values = [
    input.principal,
    input.endpoint,
    input.scope,
    input.capability,
    input.subject,
    input.revision,
    input.correlation,
  ];
  if (
    values.some(
      (value) =>
        value !== undefined &&
        (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    ) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= Date.now()
  ) {
    throw new RangeError('Runtime-host capability decision input is invalid.');
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
  validateAbsolutePath(input.privateSecretRoot, 'matcha.privateSecretRoot', platform);
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
