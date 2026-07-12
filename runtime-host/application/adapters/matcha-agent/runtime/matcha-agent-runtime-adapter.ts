import type { CapabilityDescriptor } from '../../../capabilities/contracts/capability-descriptor';
import type { GatewayChatPort, GatewayRpcPort } from '../../../gateway/gateway-runtime-port';
import type {
  RuntimeAdapter,
  RuntimeEndpointProfile,
  RuntimeSessionTransport,
} from '../../../agent-runtime/contracts/runtime-endpoint-types';
import { nativeRuntimeEndpoint } from '../../../agent-runtime/contracts/runtime-address';
import { buildRuntimeEndpointCapabilityDescriptors } from '../../../agent-runtime/contracts/runtime-capability-descriptors';
import { matchaAgentRuntimeEndpointProfile } from './matcha-agent-profile';
import { MatchaAgentAppServerClient, type MatchaAgentAppServerEndpoint } from './matcha-agent-app-server-client';
import { MatchaAgentProtocolAdapter } from './matcha-agent-protocol-adapter';
import { MatchaAgentRuntimeTransport } from './matcha-agent-transport';
import { InMemoryMatchaAgentSessionCheckpointStore } from './matcha-agent-session-checkpoint-store';
import type { MatchaTerminalDeliveryTrace } from '../../../../shared/matcha-terminal-delivery-trace';
import {
  MATCHA_AGENT_RUNTIME_ADAPTER_ID,
  MATCHA_AGENT_RUNTIME_INSTANCE_ID,
} from './matcha-agent-runtime-identity';

export type MatchaAgentRuntimeAdapterEnv = Record<string, string | undefined>;

export type MatchaAgentRuntimeAdapterOptions = {
  env?: MatchaAgentRuntimeAdapterEnv;
  createClient?: (endpoint: MatchaAgentAppServerEndpoint) => MatchaAgentAppServerClient;
  terminalDeliveryTrace?: MatchaTerminalDeliveryTrace;
};

export class MatchaAgentRuntimeAdapter implements RuntimeAdapter {
  readonly runtimeAdapterId = MATCHA_AGENT_RUNTIME_ADAPTER_ID;
  readonly protocol = new MatchaAgentProtocolAdapter();
  readonly endpoints: RuntimeEndpointProfile[];
  readonly capabilities: CapabilityDescriptor[];

  private readonly endpoint: MatchaAgentAppServerEndpoint | null;
  private readonly createClient: (endpoint: MatchaAgentAppServerEndpoint) => MatchaAgentAppServerClient;
  private readonly transportsByEndpointUrl = new Map<string, MatchaAgentRuntimeTransport>();
  private readonly checkpoints = new InMemoryMatchaAgentSessionCheckpointStore();

  constructor(private readonly options: MatchaAgentRuntimeAdapterOptions = {}) {
    const env = this.options.env ?? process.env;
    this.endpoint = readMatchaAgentAppServerEndpoint(env);
    this.endpoints = this.endpoint ? [matchaAgentRuntimeEndpointProfile] : [];
    this.capabilities = this.endpoint ? buildMatchaAgentRuntimeCapabilities(matchaAgentRuntimeEndpointProfile) : [];
    this.createClient = this.options.createClient ?? ((endpoint) => new MatchaAgentAppServerClient(endpoint));
  }

  createTransport(
    _endpoint: RuntimeEndpointProfile,
    _runtimePorts: { gateway: GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'> },
  ): RuntimeSessionTransport {
    if (!this.endpoint) {
      throw new Error('matcha-agent app-server endpoint is not enabled');
    }
    const transportKey = this.endpoint.url;
    const existingTransport = this.transportsByEndpointUrl.get(transportKey);
    if (existingTransport) return existingTransport;
    const transport = new MatchaAgentRuntimeTransport(
      this.createClient(this.endpoint),
      this.checkpoints,
      this.options.terminalDeliveryTrace,
    );
    this.transportsByEndpointUrl.set(transportKey, transport);
    return transport;
  }
}

export function readMatchaAgentAppServerEndpoint(env: MatchaAgentRuntimeAdapterEnv): MatchaAgentAppServerEndpoint | null {
  if (env.MATCHACLAW_MATCHA_AGENT_APP_SERVER_ENABLED !== '1') return null;
  const url = env.MATCHACLAW_MATCHA_AGENT_APP_SERVER_URL?.trim();
  if (!url) return null;
  return {
    url,
    ...(env.MATCHACLAW_MATCHA_AGENT_APP_SERVER_TOKEN ? { token: env.MATCHACLAW_MATCHA_AGENT_APP_SERVER_TOKEN } : {}),
  };
}

function buildMatchaAgentRuntimeCapabilities(endpoint: RuntimeEndpointProfile): CapabilityDescriptor[] {
  const endpointRef = nativeRuntimeEndpoint({
    runtimeAdapterId: MATCHA_AGENT_RUNTIME_ADAPTER_ID,
    runtimeInstanceId: MATCHA_AGENT_RUNTIME_INSTANCE_ID,
  });
  return [
    ...buildRuntimeEndpointCapabilityDescriptors({
      endpoint,
      endpointRef,
      scope: { kind: 'runtime-instance', endpoint: endpointRef },
      supportLevel: 'native',
      ownerModuleId: MATCHA_AGENT_RUNTIME_ADAPTER_ID,
      routeOwnerId: 'sessions',
    }),
    ...endpoint.agentIds.flatMap((agentId) => buildRuntimeEndpointCapabilityDescriptors({
      endpoint,
      endpointRef,
      agentId,
      supportLevel: 'native',
      ownerModuleId: MATCHA_AGENT_RUNTIME_ADAPTER_ID,
      routeOwnerId: 'sessions',
    })),
  ];
}
