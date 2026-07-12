import {
  evaluateRemoteFleetCommandPolicy,
  type RemoteFleetCommandPolicyDecision,
} from './remote-fleet-command-policy';
import type {
  RemoteFleetNodeRecord,
  RemoteFleetNodeTargetKind,
  RemoteFleetSecretRef,
  RuntimeInstanceRecord,
} from './remote-fleet-model';

export type RemoteFleetConnectorProviderKind = 'ssh' | 'docker' | 'vm' | 'k8s' | 'custom';

export type RemoteFleetConnectorCommandKind =
  | 'probe-node'
  | 'install-agent'
  | 'start-runtime'
  | 'stop-runtime'
  | 'sync-capabilities';

export const REMOTE_FLEET_CONNECTOR_TARGET_KINDS = [
  'ssh-host',
  'container',
  'vm',
  'k8s-pod',
  'custom',
] as const satisfies readonly RemoteFleetNodeTargetKind[];

export const REMOTE_FLEET_CONNECTOR_COMMAND_KINDS = [
  'probe-node',
  'install-agent',
  'start-runtime',
  'stop-runtime',
  'sync-capabilities',
] as const satisfies readonly RemoteFleetConnectorCommandKind[];

export type RemoteFleetConnectorExecutionMode = 'runtime-agent-command-channel';

export type RemoteFleetConnectorUnsupportedReason =
  | 'target-kind-not-registered'
  | 'command-not-declared-by-provider'
  | 'command-not-supported-by-provider'
  | 'bootstrap-provider-owned'
  | 'bootstrap-provider-unavailable'
  | 'capability-sync-owned-by-runtime-agent'
  | 'command-policy-unsupported';

export type RemoteFleetConnectorUnavailableReason = 'runtime-agent-command-channel-required';

export interface RemoteFleetConnectorCommandContractBase {
  readonly commandKind: RemoteFleetConnectorCommandKind;
  readonly requiredSecretRefNames: readonly string[];
}

export type RemoteFleetConnectorCommandContract =
  | (RemoteFleetConnectorCommandContractBase & {
      readonly support: 'supported';
    })
  | (RemoteFleetConnectorCommandContractBase & {
      readonly support: 'unsupported';
      readonly unsupportedReason: RemoteFleetConnectorUnsupportedReason;
      readonly message: string;
    });

export interface RemoteFleetConnectorProviderContract {
  readonly providerId: string;
  readonly providerKind: RemoteFleetConnectorProviderKind;
  readonly targetKind: RemoteFleetNodeTargetKind;
  readonly executionMode: RemoteFleetConnectorExecutionMode;
  readonly commandContracts: readonly RemoteFleetConnectorCommandContract[];
}

export interface RemoteFleetConnectorProviderRegistry {
  readonly contracts: readonly RemoteFleetConnectorProviderContract[];
  readonly providers: readonly RemoteFleetConnectorProvider[];
  getContractForTargetKind(targetKind: RemoteFleetNodeTargetKind): RemoteFleetConnectorProviderContract | undefined;
  getProviderForTargetKind(targetKind: RemoteFleetNodeTargetKind): RemoteFleetConnectorProvider | undefined;
  validateCommand(input: RemoteFleetConnectorCommandValidationInput): RemoteFleetConnectorCommandValidationResult;
}

export interface RemoteFleetConnectorProvider {
  readonly id: string;
  readonly kind: RemoteFleetConnectorProviderKind;
  createConnector(input: RemoteFleetConnectorProviderInput): RemoteFleetConnector;
}

export interface RemoteFleetConnectorProviderInput {
  readonly node: RemoteFleetNodeRecord;
  readonly runtime?: RuntimeInstanceRecord;
  readonly publicConfig: Readonly<Record<string, unknown>>;
  readonly secretRefs: Readonly<Record<string, RemoteFleetSecretRef>>;
  readonly secrets: RemoteFleetSecretReader;
  readonly commandChannel: RuntimeAgentCommandChannel;
}

export interface RemoteFleetConnector {
  dispatchCommand(command: RemoteFleetConnectorCommand): Promise<RemoteFleetConnectorCommandResult>;
  close?(): Promise<void>;
}

export interface RuntimeAgentCommandChannel {
  send(command: RuntimeAgentCommandRequest): Promise<RuntimeAgentCommandResult>;
}

export interface RemoteFleetConnectorCommand {
  readonly id: string;
  readonly kind: RemoteFleetConnectorCommandKind;
  readonly nodeId: string;
  readonly runtimeId?: string;
  readonly idempotencyKey: string;
  readonly timeoutMs?: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface RuntimeAgentCommandRequest {
  readonly commandId: string;
  readonly kind: RemoteFleetConnectorCommandKind;
  readonly node: RemoteFleetNodeRecord;
  readonly runtime?: RuntimeInstanceRecord;
  readonly publicConfig: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type RemoteFleetConnectorCommandResult =
  | {
      readonly resultType: 'accepted';
      readonly commandId: string;
      readonly remoteCommandId?: string;
      readonly message?: string;
    }
  | {
      readonly resultType: 'completed';
      readonly commandId: string;
      readonly exitCode?: number;
      readonly outputSummary?: string;
    }
  | {
      readonly resultType: 'rejected';
      readonly commandId: string;
      readonly reason: 'disabled-node' | 'missing-secret' | 'unsupported-command' | 'invalid-config';
      readonly message: string;
    }
  | {
      readonly resultType: 'unsupported';
      readonly commandId: string;
      readonly reason: RemoteFleetConnectorUnsupportedReason;
      readonly message: string;
      readonly targetKind?: RemoteFleetNodeTargetKind;
      readonly providerKind?: RemoteFleetConnectorProviderKind;
      readonly commandKind?: string;
      readonly runtimeKind?: string;
    }
  | {
      readonly resultType: 'unavailable';
      readonly commandId: string;
      readonly reason: RemoteFleetConnectorUnavailableReason;
      readonly message: string;
      readonly targetKind?: RemoteFleetNodeTargetKind;
      readonly providerKind?: RemoteFleetConnectorProviderKind;
    }
  | {
      readonly resultType: 'failed';
      readonly commandId: string;
      readonly reason: 'auth' | 'network' | 'timeout' | 'remote-error';
      readonly message: string;
    };

export type RuntimeAgentCommandResult = RemoteFleetConnectorCommandResult;

export interface RemoteFleetConnectorCommandValidationInput {
  readonly node: RemoteFleetNodeRecord;
  readonly runtime?: RuntimeInstanceRecord;
  readonly publicConfig: Readonly<Record<string, unknown>>;
  readonly secretRefs: Readonly<Record<string, RemoteFleetSecretRef>>;
  readonly command: RemoteFleetConnectorCommand;
  readonly commandChannel?: RuntimeAgentCommandChannel;
  readonly contract?: RemoteFleetConnectorProviderContract;
}

export type RemoteFleetConnectorCommandValidationResult =
  | {
      readonly resultType: 'valid';
      readonly contract: RemoteFleetConnectorProviderContract;
      readonly commandContract: Extract<RemoteFleetConnectorCommandContract, { readonly support: 'supported' }>;
      readonly policyDecision: Extract<RemoteFleetCommandPolicyDecision, { readonly resultType: 'allowed' }>;
      readonly requiredSecretRefNames: readonly string[];
    }
  | Extract<RemoteFleetConnectorCommandResult, { readonly resultType: 'rejected' | 'unsupported' | 'unavailable' }>;

export interface RemoteFleetSecretReader {
  readSecret(ref: RemoteFleetSecretRef): Promise<RemoteFleetSecretReadResult>;
}

export type RemoteFleetSecretReadResult =
  | { readonly resultType: 'found'; readonly value: string }
  | { readonly resultType: 'missing'; readonly ref: string }
  | { readonly resultType: 'access-denied'; readonly ref: string }
  | { readonly resultType: 'invalid-ref'; readonly ref: string; readonly message: string };

const CAPABILITY_SYNC_UNSUPPORTED_MESSAGE = 'Remote Fleet capability sync is ingressed by RuntimeAgent via runtime-agent.capabilities.sync; this connector slice does not issue host-side sync-capabilities commands.';
const BOOTSTRAP_PROVIDER_OWNED_MESSAGE = 'Remote Fleet install-agent/probe-node bootstrap for this target is owned by the host remoteFleetBootstrap provider seam; post-enrollment runtime commands use the RuntimeAgent command channel.';

export const REMOTE_FLEET_CONNECTOR_PROVIDER_CONTRACTS = [
  {
    providerId: 'remote-fleet.connector.ssh',
    providerKind: 'ssh',
    targetKind: 'ssh-host',
    executionMode: 'runtime-agent-command-channel',
    commandContracts: [
      supportedCommand('probe-node'),
      unsupportedCommand('install-agent', 'bootstrap-provider-owned', BOOTSTRAP_PROVIDER_OWNED_MESSAGE),
      supportedCommand('start-runtime'),
      supportedCommand('stop-runtime'),
      unsupportedCommand('sync-capabilities', 'capability-sync-owned-by-runtime-agent', CAPABILITY_SYNC_UNSUPPORTED_MESSAGE),
    ],
  },
  {
    providerId: 'remote-fleet.connector.docker',
    providerKind: 'docker',
    targetKind: 'container',
    executionMode: 'runtime-agent-command-channel',
    commandContracts: [
      supportedCommand('probe-node'),
      unsupportedCommand('install-agent', 'bootstrap-provider-owned', BOOTSTRAP_PROVIDER_OWNED_MESSAGE),
      supportedCommand('start-runtime'),
      supportedCommand('stop-runtime'),
      unsupportedCommand('sync-capabilities', 'capability-sync-owned-by-runtime-agent', CAPABILITY_SYNC_UNSUPPORTED_MESSAGE),
    ],
  },
  {
    providerId: 'remote-fleet.connector.vm',
    providerKind: 'vm',
    targetKind: 'vm',
    executionMode: 'runtime-agent-command-channel',
    commandContracts: [
      supportedCommand('probe-node'),
      unsupportedCommand('install-agent', 'bootstrap-provider-owned', BOOTSTRAP_PROVIDER_OWNED_MESSAGE),
      supportedCommand('start-runtime'),
      supportedCommand('stop-runtime'),
      unsupportedCommand('sync-capabilities', 'capability-sync-owned-by-runtime-agent', CAPABILITY_SYNC_UNSUPPORTED_MESSAGE),
    ],
  },
  {
    providerId: 'remote-fleet.connector.k8s',
    providerKind: 'k8s',
    targetKind: 'k8s-pod',
    executionMode: 'runtime-agent-command-channel',
    commandContracts: [
      supportedCommand('probe-node'),
      unsupportedCommand('install-agent', 'bootstrap-provider-owned', BOOTSTRAP_PROVIDER_OWNED_MESSAGE),
      supportedCommand('start-runtime'),
      supportedCommand('stop-runtime'),
      unsupportedCommand('sync-capabilities', 'capability-sync-owned-by-runtime-agent', CAPABILITY_SYNC_UNSUPPORTED_MESSAGE),
    ],
  },
  {
    providerId: 'remote-fleet.connector.custom',
    providerKind: 'custom',
    targetKind: 'custom',
    executionMode: 'runtime-agent-command-channel',
    commandContracts: [
      supportedCommand('probe-node'),
      unsupportedCommand('install-agent', 'bootstrap-provider-unavailable', 'Remote Fleet custom target bootstrap provider is not registered; enroll a RuntimeAgent before dispatching custom commands.'),
      supportedCommand('start-runtime'),
      supportedCommand('stop-runtime'),
      unsupportedCommand('sync-capabilities', 'capability-sync-owned-by-runtime-agent', CAPABILITY_SYNC_UNSUPPORTED_MESSAGE),
    ],
  },
] as const satisfies readonly RemoteFleetConnectorProviderContract[];

export const REMOTE_FLEET_CONNECTOR_PROVIDER_REGISTRY = createRemoteFleetConnectorProviderRegistry();

export function createRemoteFleetConnectorProviderRegistry(
  contracts: readonly RemoteFleetConnectorProviderContract[] = REMOTE_FLEET_CONNECTOR_PROVIDER_CONTRACTS,
): RemoteFleetConnectorProviderRegistry {
  const providers = contracts.map(createRemoteFleetConnectorProvider);
  return {
    contracts,
    providers,
    getContractForTargetKind(targetKind) {
      return findRemoteFleetConnectorProviderContract(contracts, targetKind);
    },
    getProviderForTargetKind(targetKind) {
      const contract = findRemoteFleetConnectorProviderContract(contracts, targetKind);
      return contract ? providers.find((provider) => provider.id === contract.providerId) : undefined;
    },
    validateCommand(input) {
      return validateRemoteFleetConnectorCommand(input);
    },
  };
}

export function listRemoteFleetConnectorProviderContracts(): readonly RemoteFleetConnectorProviderContract[] {
  return REMOTE_FLEET_CONNECTOR_PROVIDER_CONTRACTS;
}

export function getRemoteFleetConnectorProviderContract(
  targetKind: RemoteFleetNodeTargetKind,
): RemoteFleetConnectorProviderContract | undefined {
  return findRemoteFleetConnectorProviderContract(REMOTE_FLEET_CONNECTOR_PROVIDER_CONTRACTS, targetKind);
}

export function validateRemoteFleetConnectorCommand(
  input: RemoteFleetConnectorCommandValidationInput,
): RemoteFleetConnectorCommandValidationResult {
  const contract = input.contract ?? getRemoteFleetConnectorProviderContract(input.node.targetKind);
  if (!contract) {
    return unsupportedResult(
      input.command,
      'target-kind-not-registered',
      `Remote Fleet has no connector provider registered for target kind ${input.node.targetKind}.`,
      { targetKind: input.node.targetKind },
    );
  }

  if (contract.targetKind !== input.node.targetKind) {
    return {
      resultType: 'rejected',
      commandId: input.command.id,
      reason: 'invalid-config',
      message: `Remote Fleet connector provider ${contract.providerId} targets ${contract.targetKind}, not node target kind ${input.node.targetKind}.`,
    };
  }

  const commandContract = findRemoteFleetConnectorCommandContract(contract, input.command.kind);
  if (!commandContract) {
    return unsupportedResult(
      input.command,
      'command-not-declared-by-provider',
      `Remote Fleet connector provider ${contract.providerId} does not declare command ${input.command.kind}.`,
      contract,
    );
  }

  if (commandContract.support === 'unsupported') {
    return unsupportedResult(
      input.command,
      commandContract.unsupportedReason,
      commandContract.message,
      contract,
    );
  }

  const policyDecision = evaluateRemoteFleetCommandPolicy({
    node: buildPolicyNode(input),
    runtime: input.runtime,
    command: input.command,
    policy: { requiredSecretRefNames: commandContract.requiredSecretRefNames },
  });
  if (policyDecision.resultType === 'denied') {
    return connectorResultFromPolicyDecision(input.command, policyDecision, contract);
  }

  if (!hasRuntimeAgentCommandChannel(input.commandChannel)) {
    return {
      resultType: 'unavailable',
      commandId: input.command.id,
      reason: 'runtime-agent-command-channel-required',
      message: `Remote Fleet connector provider ${contract.providerId} requires a RuntimeAgent command channel for command execution.`,
      targetKind: contract.targetKind,
      providerKind: contract.providerKind,
    };
  }

  return {
    resultType: 'valid',
    contract,
    commandContract,
    policyDecision,
    requiredSecretRefNames: policyDecision.requiredSecretRefNames,
  };
}

export async function dispatchRemoteFleetConnectorCommand(
  input: RemoteFleetConnectorProviderInput,
  command: RemoteFleetConnectorCommand,
): Promise<RemoteFleetConnectorCommandResult> {
  const validation = validateRemoteFleetConnectorCommand({
    node: input.node,
    runtime: input.runtime,
    publicConfig: input.publicConfig,
    secretRefs: input.secretRefs,
    command,
    commandChannel: input.commandChannel,
  });
  if (validation.resultType !== 'valid') return validation;

  try {
    return await input.commandChannel.send(buildRuntimeAgentCommandRequest(input, command));
  } catch {
    return {
      resultType: 'failed',
      commandId: command.id,
      reason: 'remote-error',
      message: 'Remote Fleet connector could not dispatch the command through the RuntimeAgent command channel.',
    };
  }
}

export function readRemoteFleetSecret(
  input: RemoteFleetSecretLookupInput,
): Promise<RemoteFleetSecretReadResult> {
  const secretRef = input.secretRefs[input.name];
  if (!secretRef) {
    return Promise.resolve({ resultType: 'missing', ref: input.name });
  }
  return input.secrets.readSecret(secretRef);
}

export interface RemoteFleetSecretLookupInput {
  readonly name: string;
  readonly secretRefs: Readonly<Record<string, RemoteFleetSecretRef>>;
  readonly secrets: RemoteFleetSecretReader;
}

function createRemoteFleetConnectorProvider(contract: RemoteFleetConnectorProviderContract): RemoteFleetConnectorProvider {
  return {
    id: contract.providerId,
    kind: contract.providerKind,
    createConnector(input) {
      return {
        dispatchCommand(command) {
          return dispatchRemoteFleetConnectorCommand(input, command);
        },
      };
    },
  };
}

function buildRuntimeAgentCommandRequest(
  input: RemoteFleetConnectorProviderInput,
  command: RemoteFleetConnectorCommand,
): RuntimeAgentCommandRequest {
  return {
    commandId: command.id,
    kind: command.kind,
    node: {
      ...input.node,
      publicConfig: {},
      secretRefs: { ...input.secretRefs },
    },
    ...(input.runtime ? { runtime: input.runtime } : {}),
    publicConfig: input.publicConfig,
    ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    ...(command.payload === undefined ? {} : { payload: command.payload }),
  };
}

function buildPolicyNode(input: RemoteFleetConnectorCommandValidationInput): RemoteFleetNodeRecord {
  return {
    ...input.node,
    publicConfig: { ...input.publicConfig },
    secretRefs: { ...input.secretRefs },
  };
}

function connectorResultFromPolicyDecision(
  command: RemoteFleetConnectorCommand,
  decision: Extract<RemoteFleetCommandPolicyDecision, { readonly resultType: 'denied' }>,
  contract: RemoteFleetConnectorProviderContract,
): Extract<RemoteFleetConnectorCommandResult, { readonly resultType: 'rejected' | 'unsupported' }> {
  if (decision.reason === 'unsupported-command-kind' || decision.reason === 'unsupported-runtime-kind') {
    return unsupportedResult(command, 'command-policy-unsupported', decision.message, contract, {
      runtimeKind: decision.runtimeKind,
      commandKind: decision.commandKind,
    });
  }

  return {
    resultType: 'rejected',
    commandId: command.id,
    reason: mapCommandPolicyDeniedReason(decision.reason),
    message: decision.message,
  };
}

function mapCommandPolicyDeniedReason(
  reason: Extract<RemoteFleetCommandPolicyDecision, { readonly resultType: 'denied' }>['reason'],
): Extract<RemoteFleetConnectorCommandResult, { readonly resultType: 'rejected' }>['reason'] {
  switch (reason) {
    case 'node-disabled':
      return 'disabled-node';
    case 'missing-secret-ref':
      return 'missing-secret';
    case 'unsupported-command-kind':
    case 'unsupported-runtime-kind':
      return 'unsupported-command';
    case 'node-not-provided':
    case 'command-node-mismatch':
    case 'runtime-required':
    case 'runtime-node-mismatch':
    case 'command-runtime-mismatch':
    case 'unsafe-public-config-key':
    case 'invalid-port-exposure':
    case 'public-port-exposure-denied':
    case 'invalid-workspace-mount':
    case 'node-path-workspace-mount-denied':
      return 'invalid-config';
  }
}

function unsupportedResult(
  command: RemoteFleetConnectorCommand,
  reason: RemoteFleetConnectorUnsupportedReason,
  message: string,
  contract: Pick<RemoteFleetConnectorProviderContract, 'targetKind' | 'providerKind'> | { readonly targetKind: RemoteFleetNodeTargetKind },
  overrides: Pick<Extract<RemoteFleetConnectorCommandResult, { readonly resultType: 'unsupported' }>, 'runtimeKind' | 'commandKind'> = {},
): Extract<RemoteFleetConnectorCommandResult, { readonly resultType: 'unsupported' }> {
  return {
    resultType: 'unsupported',
    commandId: command.id,
    reason,
    message,
    targetKind: contract.targetKind,
    ...('providerKind' in contract ? { providerKind: contract.providerKind } : {}),
    commandKind: overrides.commandKind ?? command.kind,
    ...(overrides.runtimeKind ? { runtimeKind: overrides.runtimeKind } : {}),
  };
}

function findRemoteFleetConnectorProviderContract(
  contracts: readonly RemoteFleetConnectorProviderContract[],
  targetKind: RemoteFleetNodeTargetKind,
): RemoteFleetConnectorProviderContract | undefined {
  return contracts.find((contract) => contract.targetKind === targetKind);
}

function findRemoteFleetConnectorCommandContract(
  contract: RemoteFleetConnectorProviderContract,
  commandKind: RemoteFleetConnectorCommandKind,
): RemoteFleetConnectorCommandContract | undefined {
  return contract.commandContracts.find((commandContract) => commandContract.commandKind === commandKind);
}

function supportedCommand(
  commandKind: RemoteFleetConnectorCommandKind,
  requiredSecretRefNames: readonly string[] = [],
): RemoteFleetConnectorCommandContract {
  return { commandKind, support: 'supported', requiredSecretRefNames };
}

function unsupportedCommand(
  commandKind: RemoteFleetConnectorCommandKind,
  unsupportedReason: RemoteFleetConnectorUnsupportedReason,
  message: string,
): RemoteFleetConnectorCommandContract {
  return { commandKind, support: 'unsupported', requiredSecretRefNames: [], unsupportedReason, message };
}

function hasRuntimeAgentCommandChannel(
  commandChannel: RuntimeAgentCommandChannel | undefined,
): commandChannel is RuntimeAgentCommandChannel {
  return typeof commandChannel?.send === 'function';
}
