import { randomUUID } from 'node:crypto';
import type { RuntimeHostTransportBundle } from '../composition/transports';
import { hasExactKeys, isRecord } from '../runtime-host-delivery/transport/client';
import { isProductRuntimeEndpoint } from '../runtime-host-delivery/transport/runtime-scope';
import { isSessionIdentity, sameSessionIdentity } from '../runtime-host-delivery/transport/sessions/session-contract';
import { createSession, listSessionAgents, sendAndWaitSession } from '../sessions/execution';
import type { SharedCapabilityProvider } from './capability';

// The 64 KiB network request contains JSON escaped text inside a base64 encrypted envelope.
// Seven Ki UTF-16 units leave 8 KiB for the envelope even at six bytes per escaped unit.
const MAX_MESSAGE_LENGTH = 7 * 1024;
const INPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['message'],
  properties: {
    message: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_LENGTH, pattern: '^[^\\u0000]*[^\\s\\u0000][^\\u0000]*$' },
  },
};

export function createAgentCapabilityProvider(getTransports: () => Promise<RuntimeHostTransportBundle>): SharedCapabilityProvider {
  return {
    id: 'agent',
    async list() {
      const { agents } = await listSessionAgents(await getTransports());
      return agents.flatMap((agent) => {
        if (!agent.ready || !isProductRuntimeEndpoint(agent.endpoint)) return [];
        const endpoint = Object.freeze({ ...agent.endpoint });
        const { agentId } = agent;
        return [{
          definition: { kind: 'builtin', operation: 'agent.ask', endpoint, agentId, output: 'AppSessionExecutionResult@2' },
          descriptor: {
            name: `Ask agent — ${endpoint.runtimeAdapterId}/${agentId}`,
            description: 'Ask this fixed Agent once in a new native session. Sharing delegates the Agent\'s existing tool permissions; approvals remain with the native runtime. Accepted, queued or terminal alone does not prove an answer. Unknown results must not be automatically retried. Sessions are retained; cancelling observation does not cancel native execution.',
            inputSchema: structuredClone(INPUT_SCHEMA),
          },
          presentation: {
            kind: 'agent' as const,
            targetId: JSON.stringify([endpoint.kind, endpoint.runtimeAdapterId, endpoint.runtimeInstanceId, agentId]),
            targetName: agent.name,
            operation: 'agent.ask',
          },
          async execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
            if (!isRecord(args) || !hasExactKeys(args, ['message']) || typeof args.message !== 'string'
              || !args.message.trim().length || args.message.length > MAX_MESSAGE_LENGTH
              || args.message.includes('\0') || /[\ud800-\udfff]/u.test(args.message)) throw new Error('Invalid Agent question input.');
            const message = args.message;
            signal.throwIfAborted();
            const bundle = await getTransports();
            signal.throwIfAborted();
            const created = await createSession(bundle, { endpoint, agentId });
            if (created.outcome !== 'created') return created;
            signal.throwIfAborted();
            const { identity } = created.session;
            if (!isSessionIdentity(identity) || !sameSessionIdentity(identity, { endpoint, agentId, sessionKey: identity.sessionKey })) {
              return { outcome: 'unknown' };
            }
            return sendAndWaitSession(bundle, { identity, message, idempotencyKey: randomUUID() }, signal);
          },
        }];
      });
    },
  };
}
