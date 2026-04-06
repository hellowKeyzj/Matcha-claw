import type { OpenClawBridge } from '../../openclaw-bridge';
import { getOpenClawConfigDir } from '../storage/paths';
import { CronService } from '../../application/cron/service';

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface CronRouteDeps {
  openclawBridge: Pick<
    OpenClawBridge,
    'listCronJobs' | 'addCronJob' | 'updateCronJob' | 'removeCronJob' | 'runCronJob'
  >;
}

export async function handleCronAndUsageRoute(
  method: string,
  routePath: string,
  routeUrl: URL,
  payload: unknown,
  deps: CronRouteDeps,
): Promise<LocalDispatchResponse | null> {
  const service = new CronService({
    openclawBridge: deps.openclawBridge,
    getOpenClawConfigDir,
  });

  if (method === 'GET' && routePath === '/api/runtime-host/usage/recent') {
    try {
      return {
        status: 200,
        data: await service.usageRecent(payload, routeUrl),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'GET' && routePath === '/api/cron/jobs') {
    try {
      return {
        status: 200,
        data: await service.listJobs(),
      };
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'GET' && routePath === '/api/cron/session-history') {
    try {
      return await service.sessionHistory(routeUrl);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/cron/jobs') {
    try {
      return await service.createJob(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  const cronJobRouteMatch = routePath.match(/^\/api\/cron\/jobs\/([^/]+)$/);
  if (method === 'PUT' && cronJobRouteMatch) {
    try {
      const id = decodeURIComponent(cronJobRouteMatch[1]);
      return await service.updateJob(id, payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'DELETE' && cronJobRouteMatch) {
    try {
      const id = decodeURIComponent(cronJobRouteMatch[1]);
      return await service.deleteJob(id);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/cron/toggle') {
    try {
      return await service.toggleJob(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/cron/trigger') {
    try {
      return await service.trigger(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  return null;
}
