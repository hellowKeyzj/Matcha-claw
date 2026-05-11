import { cronRoutes } from '../../api/routes/cron-routes';
import { fileRoutes } from '../../api/routes/file-routes';
import { licenseRoutes } from '../../api/routes/license-routes';
import { platformRoutes } from '../../api/routes/platform-routes';
import { securityRoutes } from '../../api/routes/security-routes';
import { taskRoutes } from '../../api/routes/task-routes';
import { teamRuntimeRoutes } from '../../api/routes/team-runtime-routes';
import { toolchainUvRoutes } from '../../api/routes/toolchain-uv-routes';
import type { RuntimeHostApplicationServices } from '../application-services';
import type { RuntimeHostRouteRegistry } from '../route-registry';

export function registerOperationsRoutes(
  routes: RuntimeHostRouteRegistry,
  services: RuntimeHostApplicationServices,
): void {
  routes.registerDefinitions('cron_usage', cronRoutes, {
    cronService: services.cronService,
  });
  routes.registerDefinitions('files', fileRoutes, {
    fileService: services.fileService,
  });
  routes.registerDefinitions('license', licenseRoutes, {
    licenseService: services.licenseService,
  });
  routes.registerDefinitions('team_runtime', teamRuntimeRoutes, services.teamRuntimeService);
  routes.registerDefinitions('toolchain_uv', toolchainUvRoutes, {
    toolchainUvService: services.toolchainUvService,
  });
  routes.registerDefinitions('security', securityRoutes, {
    securityService: services.securityService,
  });
  routes.registerDefinitions('tasks', taskRoutes, {
    taskService: services.taskService,
  });
  routes.registerDefinitions('platform', platformRoutes, {
    platformService: services.platformService,
  });
}
