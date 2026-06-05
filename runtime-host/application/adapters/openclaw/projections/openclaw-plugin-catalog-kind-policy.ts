import type { RuntimeHostCatalogPlugin } from '../../../../bootstrap/runtime-config';
import type { RuntimeHostDiscoveredPlugin } from '../../../../shared/types';
import type { PluginCatalogKindPolicyPort } from '../../../plugins/catalog';

export class OpenClawPluginCatalogKindPolicy implements PluginCatalogKindPolicyPort {
  inferPluginKind(input: {
    discovered: RuntimeHostDiscoveredPlugin;
    packageJson: Record<string, unknown> | null;
  }): RuntimeHostCatalogPlugin['kind'] {
    if (input.discovered.source === 'openclaw-extension' || input.discovered.source === 'matchaclaw-extension') {
      return 'third-party';
    }

    const packageName = typeof input.packageJson?.name === 'string' ? input.packageJson.name.trim() : '';
    if (packageName.startsWith('@matchaclaw/')) {
      return 'builtin';
    }

    return input.discovered.platform === 'matchaclaw' ? 'builtin' : 'third-party';
  }
}
