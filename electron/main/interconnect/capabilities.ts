import type { SharedCapability } from '../../../src/types/desktop/interconnect';
import { isJsonValue, isRecord } from '../runtime-host-delivery/transport/client';
import { identifyCapability, type SharedCapabilityProvider } from './capability';

export function createSharedCapabilities(providers: readonly SharedCapabilityProvider[]) {
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) throw new Error('Duplicate shared capability provider.');
  const sources = new Map<string, SharedCapabilityProvider>();
  let listed = false;

  /** Unfiltered local candidates; never use this as a peer's authorized directory. */
  async function list(): Promise<SharedCapability[]> {
    const groups = await Promise.all(providers.map(async (provider) =>
      ({ provider, entries: await provider.list().catch(() => []) })));
    sources.clear();
    const descriptors = groups.flatMap(({ provider, entries }) => entries.map((entry) => {
      const descriptor = identifyCapability(entry);
      if (sources.has(descriptor.sourceId)) throw new Error('Duplicate shared capability source.');
      sources.set(descriptor.sourceId, provider);
      return descriptor;
    }));
    listed = true;
    return structuredClone(descriptors);
  }

  return {
    list,
    async resolve(sourceId: string): Promise<{
      descriptor: SharedCapability;
      execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
    } | undefined> {
      if (!/^sha256:[a-f0-9]{64}$/.test(sourceId)) return undefined;
      if (!listed || !sources.has(sourceId)) await list();
      const provider = sources.get(sourceId);
      if (!provider) return undefined;
      const entries = await provider.list().catch(() => []);
      for (const entry of entries) {
        const descriptor = identifyCapability(entry);
        if (descriptor.sourceId !== sourceId) continue;
        return {
          descriptor: structuredClone(descriptor),
          async execute(args, signal) {
            if (!isRecord(args) || !isJsonValue(args, new Set())) throw new Error('Shared capability input must be a JSON object.');
            return entry.execute(args, signal);
          },
        };
      }
      return undefined;
    },
  };
}
