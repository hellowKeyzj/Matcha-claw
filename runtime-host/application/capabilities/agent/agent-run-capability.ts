import { badRequest, ok } from '../../common/application-response';
import type { GatewayRpcPort } from '../../gateway/gateway-runtime-port';
import type { CapabilityOperationDescriptor } from '../contracts/capability-descriptor';
import type { CapabilityOperationRoute } from '../contracts/capability-router';

export const AGENT_RUN_CAPABILITY_ID = 'agent.run';

export const agentRunCapabilityOperations: readonly CapabilityOperationDescriptor[] = [
  { id: 'agent.wait', title: 'Wait for agent run', targetKind: 'agent' },
] as const;

export function createAgentRunCapabilityOperationRoutes(deps: {
  gateway: Pick<GatewayRpcPort, 'gatewayRpc'>;
}): readonly CapabilityOperationRoute[] {
  return [{
    capabilityId: AGENT_RUN_CAPABILITY_ID,
    operationId: 'agent.wait',
    handle: async (context) => {
      const body = context.domainInput;
      const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
      if (!runId) {
        return badRequest('runId is required');
      }
      const waitSliceMs = typeof body.waitSliceMs === 'number' && Number.isFinite(body.waitSliceMs)
        ? Math.max(1000, Math.floor(body.waitSliceMs))
        : 30000;
      const rpcTimeoutBufferMs = typeof body.rpcTimeoutBufferMs === 'number' && Number.isFinite(body.rpcTimeoutBufferMs)
        ? Math.max(0, Math.floor(body.rpcTimeoutBufferMs))
        : 10000;
      return ok(await deps.gateway.gatewayRpc('agent.wait', {
        runId,
        timeoutMs: waitSliceMs,
      }, waitSliceMs + rpcTimeoutBufferMs));
    },
  }];
}
