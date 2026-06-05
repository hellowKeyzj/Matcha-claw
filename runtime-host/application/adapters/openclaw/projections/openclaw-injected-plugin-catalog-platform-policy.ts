import type { RuntimeHostCatalogPlugin } from '../../../../bootstrap/runtime-config';
import type { InjectedPluginCatalogPlatformPolicyPort } from '../../../plugins/runtime-plugin-registry';

export class OpenClawInjectedPluginCatalogPlatformPolicy implements InjectedPluginCatalogPlatformPolicyPort {
  normalizePlatform(platform: unknown): RuntimeHostCatalogPlugin['platform'] {
    return platform === 'matchaclaw' || platform === 'openclaw' ? platform : 'openclaw';
  }
}
