import type { RuntimeAdapterRegistrationFactory } from '../../../agent-runtime/contracts/runtime-endpoint-types';
import { MatchaAgentRuntimeAdapter, type MatchaAgentRuntimeAdapterOptions } from './matcha-agent-runtime-adapter';

export { MatchaAgentAppServerClient } from './matcha-agent-app-server-client';
export { MatchaAgentEventBridge } from './matcha-agent-event-bridge';
export { matchaAgentRuntimeEndpointProfile } from './matcha-agent-profile';
export { MatchaAgentProtocolAdapter } from './matcha-agent-protocol-adapter';
export { MatchaAgentRuntimeAdapter, readMatchaAgentAppServerEndpoint } from './matcha-agent-runtime-adapter';
export {
  MATCHA_AGENT_RUNTIME_ADAPTER_ID,
  MATCHA_AGENT_RUNTIME_ENDPOINT_ID,
  MATCHA_AGENT_RUNTIME_INSTANCE_ID,
  MATCHA_AGENT_RUNTIME_PROTOCOL_ID,
} from './matcha-agent-runtime-identity';
export { MatchaAgentRuntimeTransport } from './matcha-agent-transport';
export { InMemoryMatchaAgentSessionCheckpointStore } from './matcha-agent-session-checkpoint-store';

export function createMatchaAgentRuntimeAdapterRegistrationFactory(
  options: MatchaAgentRuntimeAdapterOptions = {},
): RuntimeAdapterRegistrationFactory {
  return {
    create: () => [new MatchaAgentRuntimeAdapter(options)],
  };
}
