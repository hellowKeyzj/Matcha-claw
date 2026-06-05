import { cronRoutes } from '../../api/routes/cron-routes';
import { fileRoutes } from '../../api/routes/file-routes';
import { licenseRoutes } from '../../api/routes/license-routes';
import { platformRoutes } from '../../api/routes/platform-routes';
import { securityRoutes } from '../../api/routes/security-routes';
import { toolchainUvRoutes } from '../../api/routes/toolchain-uv-routes';
import type { RuntimeHostRouteRegistry } from '../route-registry';
import type { CronService } from '../../application/cron/service';
import type { FileService } from '../../application/files/file-service';
import type { LicenseService } from '../../application/license/service';
import type { PlatformService } from '../../application/platform-runtime/service';
import type { SecurityRuntimeService } from '../../application/security/service';
import type { ToolchainUvService } from '../../application/toolchain/uv-service';

export interface OperationsRouteServices {
  readonly cronService: CronService;
  readonly fileService: FileService;
  readonly licenseService: LicenseService;
  readonly toolchainUvService: ToolchainUvService;
  readonly securityService: SecurityRuntimeService;
  readonly platformService: PlatformService;
}

export function registerOperationsRoutes(
  routes: RuntimeHostRouteRegistry,
  services: OperationsRouteServices,
): void {

  routes.registerDefinitions('cron_usage', cronRoutes, { cronService: services.cronService });
  routes.registerDefinitions('files', fileRoutes, { fileService: services.fileService });
  routes.registerDefinitions('license', licenseRoutes, { licenseService: services.licenseService });
  routes.registerDefinitions('toolchain_uv', toolchainUvRoutes, { toolchainUvService: services.toolchainUvService });
  routes.registerDefinitions('security', securityRoutes, { securityService: services.securityService });
  routes.registerDefinitions('platform', platformRoutes, { platformService: services.platformService });
}
