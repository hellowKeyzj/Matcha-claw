import { hasExactKeys } from '../runtime-host-delivery/transport/client';
import type { RuntimeHostTransports } from '../runtime-host-delivery/transport/host-api-transports';
import type { SharedCapabilityCandidate, SharedCapabilityProvider } from './capability';

export function createRuntimeCapabilityProvider(getTransports: () => Promise<RuntimeHostTransports>): SharedCapabilityProvider {
  const runtime: SharedCapabilityCandidate = {
    definition: {
      kind: 'builtin', operation: 'runtime.list', scope: 'local-runtime-directory', policyScope: 'runtime:endpoints:read',
      output: { endpoints: ['endpoint', 'name', 'ready'] },
    },
    descriptor: {
      name: 'Runtime endpoints',
      description: 'List the local runtime endpoints, their names and current readiness. This does not grant access to agents or sessions.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    presentation: { kind: 'runtime', targetId: 'local-runtime-directory', targetName: 'Runtime endpoints', operation: 'runtime.list' },
    async execute(args, signal) {
      if (!hasExactKeys(args, [])) throw new Error('Runtime listing accepts no arguments.');
      if (signal.aborted) throw new Error('Runtime listing observation was cancelled.');
      try {
        const transports = await getTransports();
        if (signal.aborted) throw new Error('Runtime listing observation was cancelled.');
        const response = await transports.runtimeDirectoryTransport.list();
        if (signal.aborted || response.status !== 200) throw new Error('Runtime listing is unavailable.');
        return { endpoints: response.body.endpoints.map((endpoint) => ({ endpoint: endpoint.endpointRef, name: endpoint.displayName, ready: endpoint.lifecycle.ready })) };
      } catch {
        throw new Error('Runtime listing is unavailable.');
      }
    },
  };
  return { id: 'runtime', list: async () => [runtime] };
}
