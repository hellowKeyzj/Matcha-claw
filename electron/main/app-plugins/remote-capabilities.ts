import type { SharedCapabilityCandidate, SharedCapabilityProvider } from '../interconnect/capability';
import type { ApplicationPluginOwner } from './owner';
import type { AppPluginHost } from './host';
import { toolError } from './protocol';

/** Local share candidates only; remote discovery must intersect provider grants. */
export function createPluginCapabilityProvider(plugins: ApplicationPluginOwner, host: AppPluginHost): SharedCapabilityProvider {
  return {
    id: 'plugins',
    async list() {
      const catalog = await plugins.list().catch(() => { throw new Error('Application plugin catalog is unavailable.'); });
      return catalog.plugins.filter((plugin) => plugin.enabled && (plugin.manifest.main || plugin.manifest.backend)).flatMap((plugin) =>
        (plugin.manifest.contributes.tools ?? []).map((tool): SharedCapabilityCandidate => ({
          definition: { kind: 'app-plugin', pluginId: plugin.manifest.id, digest: plugin.digest, tool },
          descriptor: {
            name: `${plugin.manifest.name} · ${tool.name}`,
            description: `${plugin.manifest.name}: ${tool.description}`,
            inputSchema: structuredClone(tool.inputSchema),
          },
          presentation: { kind: 'plugin', targetId: plugin.manifest.id, targetName: plugin.manifest.name, operation: tool.name },
          async execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
            if (signal.aborted) throw new Error('Shared plugin call observation was cancelled.');
            try {
              const result = await host.call({ id: plugin.manifest.id, digest: plugin.digest, name: tool.name, arguments: args }, signal);
              return result.isError ? toolError('The plugin tool returned an error; external effects may already have occurred. The call was not retried.') : result;
            } catch {
              throw new Error('The plugin call outcome could not be confirmed; external effects may already have occurred. The call was not retried.');
            }
          },
        })));
    },
  };
}
