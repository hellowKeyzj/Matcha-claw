import { WorkbenchService } from '../../application/workbench/service';

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface WorkbenchRouteDeps {
  buildLocalRuntimeState: () => {
    lifecycle: string;
    plugins: Array<{ lifecycle?: string } & Record<string, any>>;
  };
}

export function handleWorkbenchRoute(
  method: string,
  routePath: string,
  deps: WorkbenchRouteDeps,
): LocalDispatchResponse | null {
  if (!(method === 'GET' && routePath === '/api/workbench/bootstrap')) {
    return null;
  }
  const service = new WorkbenchService({
    buildLocalRuntimeState: deps.buildLocalRuntimeState,
  });
  return {
    status: 200,
    data: service.bootstrap(),
  };
}
