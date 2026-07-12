import type { RemoteFleetConnectorCommandKind, RuntimeAgentCommandRequest } from './remote-fleet-connectors';
import type {
  RemoteFleetCommandRecord,
  RemoteFleetNodeRecord,
  RemoteFleetSecretRef,
  RemoteRuntimeEndpointRecord,
  RuntimeInstanceRecord,
} from './remote-fleet-model';
import { findUnsafeRemoteFleetEndpointUrlKey } from './remote-fleet-command-policy';
import { evaluateRemoteFleetSecretRefPolicy } from './remote-fleet-secret-policy';
import { buildRuntimeLaunchCommandRequest } from './remote-fleet-runtime-launch';

export const REMOTE_FLEET_COMMAND_DISPATCH_ENVELOPE_VERSION = 'remote-fleet-command-dispatch/v1';

export type RemoteFleetDispatchCommandName = Extract<RemoteFleetConnectorCommandKind, 'probe-node' | 'install-agent' | 'start-runtime' | 'stop-runtime'>;

export interface BuildRemoteFleetCommandDispatchEnvelopeInput {
  readonly command: RemoteFleetCommandRecord;
  readonly node?: RemoteFleetNodeRecord;
  readonly runtime?: RuntimeInstanceRecord;
  readonly endpoint?: RemoteRuntimeEndpointRecord;
}

export type BuildRemoteFleetCommandDispatchEnvelopeResult =
  | {
      readonly resultType: 'built';
      readonly envelope: RemoteFleetCommandDispatchEnvelope;
    }
  | {
      readonly resultType: 'invalid';
      readonly commandId: string;
      readonly commandName: string;
      readonly issues: readonly RemoteFleetCommandDispatchIssue[];
    };

export interface RemoteFleetCommandDispatchEnvelope {
  readonly envelopeVersion: typeof REMOTE_FLEET_COMMAND_DISPATCH_ENVELOPE_VERSION;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly agentId: string;
  readonly nodeId: string;
  readonly runtimeId?: string;
  readonly endpointId?: string;
  readonly commandName: RemoteFleetDispatchCommandName;
  readonly dispatchTarget?: RemoteFleetRuntimeAgentDispatchTarget;
  readonly request: RuntimeAgentCommandRequest;
}

export interface RemoteFleetRuntimeAgentDispatchTarget {
  readonly endpointUrl: string;
  readonly credentialRef: RemoteFleetSecretRef;
  readonly timeoutMs?: number;
}

export interface RemoteFleetCommandDispatchIssue {
  readonly reason:
    | 'unsupported-command'
    | 'missing-node'
    | 'missing-agent-id'
    | 'missing-runtime'
    | 'missing-endpoint'
    | 'command-node-mismatch'
    | 'command-runtime-mismatch'
    | 'command-endpoint-mismatch'
    | 'runtime-node-mismatch'
    | 'endpoint-node-mismatch'
    | 'endpoint-runtime-mismatch'
    | 'invalid-launch-spec';
  readonly path: string;
  readonly message: string;
}

export type RuntimeAgentProbeNodeCommandPayload = Readonly<Record<string, unknown>> & {
  readonly payloadType: 'runtime-agent-probe-node';
  readonly nodeId: string;
  readonly agentId: string;
  readonly target: RuntimeAgentProbeNodeTargetPayload;
};

export interface RuntimeAgentProbeNodeTargetPayload {
  readonly targetKind: RemoteFleetNodeRecord['targetKind'];
  readonly endpointUrl?: string;
  readonly labels: readonly string[];
}

export type RuntimeAgentInstallCommandPayload = Readonly<Record<string, unknown>> & {
  readonly payloadType: 'runtime-agent-install';
  readonly nodeId: string;
  readonly agentId: string;
  readonly target: RuntimeAgentInstallTargetPayload;
  readonly secretRefNames: readonly string[];
};

export interface RuntimeAgentInstallTargetPayload {
  readonly targetKind: RemoteFleetNodeRecord['targetKind'];
  readonly endpointUrl?: string;
  readonly labels: readonly string[];
}

export type RemoteRuntimeStopCommandPayload = Readonly<Record<string, unknown>> & {
  readonly payloadType: 'remote-runtime-stop';
  readonly runtimeId: string;
  readonly runtimeKind: RuntimeInstanceRecord['runtimeKind'];
  readonly endpointId: string;
  readonly endpointRef: RemoteRuntimeEndpointRecord['endpointRef'];
  readonly scope: RemoteRuntimeEndpointRecord['scope'];
};

export function buildRemoteFleetCommandDispatchEnvelope(
  input: BuildRemoteFleetCommandDispatchEnvelopeInput,
): BuildRemoteFleetCommandDispatchEnvelopeResult {
  const commandName = readDispatchCommandName(input.command.command);
  if (!commandName) {
    return invalid(input.command, input.command.command, [{
      reason: 'unsupported-command',
      path: 'command.command',
      message: `Remote Fleet command dispatch does not support command ${input.command.command}.`,
    }]);
  }

  switch (commandName) {
    case 'probe-node':
      return buildProbeNodeDispatchEnvelope(input.command, input.node);
    case 'install-agent':
      return buildInstallAgentDispatchEnvelope(input.command, input.node);
    case 'start-runtime':
      return buildStartRuntimeDispatchEnvelope(input.command, input.node, input.runtime, input.endpoint);
    case 'stop-runtime':
      return buildStopRuntimeDispatchEnvelope(input.command, input.node, input.runtime, input.endpoint);
  }
}

function buildProbeNodeDispatchEnvelope(
  command: RemoteFleetCommandRecord,
  node: RemoteFleetNodeRecord | undefined,
): BuildRemoteFleetCommandDispatchEnvelopeResult {
  const issue = validateNode(command, node) ?? validateAgentId(command);
  if (issue || !node || !command.agentId) {
    return invalid(command, 'probe-node', [issue ?? missingAgentIdIssue()]);
  }

  const request: RuntimeAgentCommandRequest = {
    commandId: command.id,
    kind: 'probe-node',
    node: sanitizeNodeForRuntimeAgent(node),
    publicConfig: buildRuntimeAgentCommandPublicConfig('probe-node'),
    payload: buildProbeNodePayload(command, node),
  };

  return built(command, 'probe-node', {
    agentId: command.agentId,
    nodeId: node.id,
    dispatchTarget: buildRuntimeAgentDispatchTarget(node),
    request,
  });
}

function buildInstallAgentDispatchEnvelope(
  command: RemoteFleetCommandRecord,
  node: RemoteFleetNodeRecord | undefined,
): BuildRemoteFleetCommandDispatchEnvelopeResult {
  const issue = validateNode(command, node) ?? validateAgentId(command);
  if (issue || !node || !command.agentId) {
    return invalid(command, 'install-agent', [issue ?? missingAgentIdIssue()]);
  }

  const request: RuntimeAgentCommandRequest = {
    commandId: command.id,
    kind: 'install-agent',
    node: sanitizeNodeForRuntimeAgent(node),
    publicConfig: buildRuntimeAgentCommandPublicConfig('install-agent'),
    payload: buildInstallAgentPayload(command, node),
  };

  return built(command, 'install-agent', {
    agentId: command.agentId,
    nodeId: node.id,
    dispatchTarget: buildRuntimeAgentDispatchTarget(node),
    request,
  });
}

function buildStartRuntimeDispatchEnvelope(
  command: RemoteFleetCommandRecord,
  node: RemoteFleetNodeRecord | undefined,
  runtime: RuntimeInstanceRecord | undefined,
  endpoint: RemoteRuntimeEndpointRecord | undefined,
): BuildRemoteFleetCommandDispatchEnvelopeResult {
  const issue = validateNode(command, node)
    ?? validateRuntime(command, node, runtime)
    ?? validateEndpoint(command, node, runtime, endpoint)
    ?? validateAgentId(command, runtime);
  if (issue || !node || !runtime || !endpoint || !(command.agentId ?? runtime.agentId)) {
    return invalid(command, 'start-runtime', [issue ?? missingAgentIdIssue()]);
  }

  const launchResult = buildRuntimeLaunchCommandRequest({ commandId: command.id, runtime, node });
  if (launchResult.resultType === 'invalid') {
    return invalid(command, 'start-runtime', launchResult.issues.map((launchIssue) => ({
      reason: 'invalid-launch-spec',
      path: launchIssue.path,
      message: launchIssue.message,
    })));
  }

  return built(command, 'start-runtime', {
    agentId: command.agentId ?? runtime.agentId!,
    nodeId: node.id,
    runtimeId: runtime.id,
    endpointId: endpoint.id,
    dispatchTarget: buildRuntimeAgentDispatchTarget(node),
    request: launchResult.request,
  });
}

function buildStopRuntimeDispatchEnvelope(
  command: RemoteFleetCommandRecord,
  node: RemoteFleetNodeRecord | undefined,
  runtime: RuntimeInstanceRecord | undefined,
  endpoint: RemoteRuntimeEndpointRecord | undefined,
): BuildRemoteFleetCommandDispatchEnvelopeResult {
  const issue = validateNode(command, node)
    ?? validateRuntime(command, node, runtime)
    ?? validateEndpoint(command, node, runtime, endpoint)
    ?? validateAgentId(command, runtime);
  if (issue || !node || !runtime || !endpoint || !(command.agentId ?? runtime.agentId)) {
    return invalid(command, 'stop-runtime', [issue ?? missingAgentIdIssue()]);
  }

  const request: RuntimeAgentCommandRequest = {
    commandId: command.id,
    kind: 'stop-runtime',
    node: sanitizeNodeForRuntimeAgent(node),
    runtime,
    publicConfig: buildRuntimeAgentCommandPublicConfig('stop-runtime'),
    payload: buildStopRuntimePayload(runtime, endpoint),
  };

  return built(command, 'stop-runtime', {
    agentId: command.agentId ?? runtime.agentId!,
    nodeId: node.id,
    runtimeId: runtime.id,
    endpointId: endpoint.id,
    dispatchTarget: buildRuntimeAgentDispatchTarget(node),
    request,
  });
}

function built(
  command: RemoteFleetCommandRecord,
  commandName: RemoteFleetDispatchCommandName,
  envelope: Omit<RemoteFleetCommandDispatchEnvelope, 'envelopeVersion' | 'commandId' | 'idempotencyKey' | 'commandName'>,
): BuildRemoteFleetCommandDispatchEnvelopeResult {
  return {
    resultType: 'built',
    envelope: {
      envelopeVersion: REMOTE_FLEET_COMMAND_DISPATCH_ENVELOPE_VERSION,
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      commandName,
      ...envelope,
    },
  };
}

function invalid(
  command: RemoteFleetCommandRecord,
  commandName: string,
  issues: readonly RemoteFleetCommandDispatchIssue[],
): BuildRemoteFleetCommandDispatchEnvelopeResult {
  return {
    resultType: 'invalid',
    commandId: command.id,
    commandName,
    issues,
  };
}

function validateNode(
  command: RemoteFleetCommandRecord,
  node: RemoteFleetNodeRecord | undefined,
): RemoteFleetCommandDispatchIssue | undefined {
  if (!node) {
    return {
      reason: 'missing-node',
      path: 'node',
      message: `Remote Fleet command ${command.id} requires a node projection before dispatch.`,
    };
  }
  if (command.nodeId && command.nodeId !== node.id) {
    return {
      reason: 'command-node-mismatch',
      path: 'node.id',
      message: `Remote Fleet command ${command.id} targets node ${command.nodeId}, not node ${node.id}.`,
    };
  }
  return undefined;
}

function validateRuntime(
  command: RemoteFleetCommandRecord,
  node: RemoteFleetNodeRecord | undefined,
  runtime: RuntimeInstanceRecord | undefined,
): RemoteFleetCommandDispatchIssue | undefined {
  if (!runtime) {
    return {
      reason: 'missing-runtime',
      path: 'runtime',
      message: `Remote Fleet command ${command.id} requires a runtime projection before dispatch.`,
    };
  }
  if (command.runtimeId && command.runtimeId !== runtime.id) {
    return {
      reason: 'command-runtime-mismatch',
      path: 'runtime.id',
      message: `Remote Fleet command ${command.id} targets runtime ${command.runtimeId}, not runtime ${runtime.id}.`,
    };
  }
  if (node && runtime.nodeId !== node.id) {
    return {
      reason: 'runtime-node-mismatch',
      path: 'runtime.nodeId',
      message: `Remote Fleet runtime ${runtime.id} belongs to node ${runtime.nodeId}, not node ${node.id}.`,
    };
  }
  return undefined;
}

function validateEndpoint(
  command: RemoteFleetCommandRecord,
  node: RemoteFleetNodeRecord | undefined,
  runtime: RuntimeInstanceRecord | undefined,
  endpoint: RemoteRuntimeEndpointRecord | undefined,
): RemoteFleetCommandDispatchIssue | undefined {
  if (!endpoint) {
    return {
      reason: 'missing-endpoint',
      path: 'endpoint',
      message: `Remote Fleet command ${command.id} requires an endpoint projection before dispatch.`,
    };
  }
  if (command.endpointId && command.endpointId !== endpoint.id) {
    return {
      reason: 'command-endpoint-mismatch',
      path: 'endpoint.id',
      message: `Remote Fleet command ${command.id} targets endpoint ${command.endpointId}, not endpoint ${endpoint.id}.`,
    };
  }
  if (node && endpoint.nodeId !== node.id) {
    return {
      reason: 'endpoint-node-mismatch',
      path: 'endpoint.nodeId',
      message: `Remote Fleet endpoint ${endpoint.id} belongs to node ${endpoint.nodeId}, not node ${node.id}.`,
    };
  }
  if (runtime && endpoint.runtimeId !== runtime.id) {
    return {
      reason: 'endpoint-runtime-mismatch',
      path: 'endpoint.runtimeId',
      message: `Remote Fleet endpoint ${endpoint.id} belongs to runtime ${endpoint.runtimeId}, not runtime ${runtime.id}.`,
    };
  }
  return undefined;
}

function validateAgentId(
  command: RemoteFleetCommandRecord,
  runtime?: RuntimeInstanceRecord,
): RemoteFleetCommandDispatchIssue | undefined {
  if (command.agentId ?? runtime?.agentId) {
    return undefined;
  }
  return missingAgentIdIssue();
}

function missingAgentIdIssue(): RemoteFleetCommandDispatchIssue {
  return {
    reason: 'missing-agent-id',
    path: 'command.agentId',
    message: 'Remote Fleet command dispatch requires a RuntimeAgent id.',
  };
}

function buildProbeNodePayload(
  command: RemoteFleetCommandRecord,
  node: RemoteFleetNodeRecord,
): RuntimeAgentProbeNodeCommandPayload {
  return {
    payloadType: 'runtime-agent-probe-node',
    nodeId: node.id,
    agentId: command.agentId!,
    target: buildNodeTargetPayload(node),
  };
}

function buildInstallAgentPayload(
  command: RemoteFleetCommandRecord,
  node: RemoteFleetNodeRecord,
): RuntimeAgentInstallCommandPayload {
  return {
    payloadType: 'runtime-agent-install',
    nodeId: node.id,
    agentId: command.agentId!,
    target: buildNodeTargetPayload(node),
    secretRefNames: Object.keys(node.secretRefs).sort(),
  };
}

function buildNodeTargetPayload(node: RemoteFleetNodeRecord): RuntimeAgentProbeNodeTargetPayload {
  const endpointUrl = findUnsafeRemoteFleetEndpointUrlKey(node.endpointUrl) ? undefined : node.endpointUrl;
  return {
    targetKind: node.targetKind,
    ...(endpointUrl ? { endpointUrl } : {}),
    labels: node.labels,
  };
}

function buildStopRuntimePayload(
  runtime: RuntimeInstanceRecord,
  endpoint: RemoteRuntimeEndpointRecord,
): RemoteRuntimeStopCommandPayload {
  return {
    payloadType: 'remote-runtime-stop',
    runtimeId: runtime.id,
    runtimeKind: runtime.runtimeKind,
    endpointId: endpoint.id,
    endpointRef: endpoint.endpointRef,
    scope: endpoint.scope,
  };
}

function sanitizeNodeForRuntimeAgent(node: RemoteFleetNodeRecord): RemoteFleetNodeRecord {
  const { endpointUrl: rawEndpointUrl, ...nodeWithoutEndpointUrl } = node;
  const endpointUrl = findUnsafeRemoteFleetEndpointUrlKey(rawEndpointUrl) ? undefined : node.endpointUrl;
  return {
    ...nodeWithoutEndpointUrl,
    ...(endpointUrl ? { endpointUrl } : {}),
    publicConfig: {},
    secretRefs: {},
  };
}

function buildRuntimeAgentDispatchTarget(node: RemoteFleetNodeRecord): RemoteFleetRuntimeAgentDispatchTarget | undefined {
  const runtimeAgent = readRecord(node.publicConfig.runtimeAgent);
  const endpointUrl = readOptionalString(runtimeAgent.endpointUrl);
  const credentialRefName = readOptionalString(runtimeAgent.credentialRefName) ?? 'runtimeAgentToken';
  const credentialRef = node.secretRefs[credentialRefName];
  const timeoutMs = readOptionalPositiveInteger(runtimeAgent.timeoutMs);

  if (!endpointUrl || findUnsafeRemoteFleetEndpointUrlKey(endpointUrl) || !credentialRef) {
    return undefined;
  }
  if (evaluateRemoteFleetSecretRefPolicy(credentialRef.ref).decision !== 'allowed') {
    return undefined;
  }

  return {
    endpointUrl,
    credentialRef,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function buildRuntimeAgentCommandPublicConfig(commandName: RemoteFleetDispatchCommandName): Readonly<Record<string, unknown>> {
  return {
    dispatchContract: {
      envelopeVersion: REMOTE_FLEET_COMMAND_DISPATCH_ENVELOPE_VERSION,
      commandName,
    },
  };
}

function readDispatchCommandName(commandName: string): RemoteFleetDispatchCommandName | undefined {
  if (commandName === 'probe-node' || commandName === 'install-agent' || commandName === 'start-runtime' || commandName === 'stop-runtime') {
    return commandName;
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === 'number' && value > 0 ? value : undefined;
}
