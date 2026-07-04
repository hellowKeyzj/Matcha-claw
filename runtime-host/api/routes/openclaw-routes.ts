import {
  badRequest,
  decodeRouteParam,
  readRecord,
  routeResponder,
  type RuntimeRouteDefinition,
} from './route-utils';

type OpenClawToolPermissionMode = 'default' | 'fullAccess';

interface OpenClawRouteDeps {
  openClawService: OpenClawRouteService;
}

interface OpenClawRouteService {
  status(): Promise<unknown>;
  ready(): Promise<unknown>;
  dir(): unknown;
  configDir(): unknown;
  subagentTemplates(): Promise<unknown>;
  subagentTemplate(templateIdRaw: string): Promise<unknown>;
  workspaceDir(): Promise<unknown>;
  taskWorkspaceDirs(): Promise<unknown>;
  skillsDir(): unknown;
  cliCommand(): Promise<unknown>;
  toolPermissionMode(): Promise<unknown>;
  setToolPermissionMode(mode: OpenClawToolPermissionMode): Promise<unknown>;
}

function readPermissionMode(payload: unknown): OpenClawToolPermissionMode | null {
  const mode = readRecord(payload).mode;
  return mode === 'default' || mode === 'fullAccess' ? mode : null;
}

export const openClawRoutes: readonly RuntimeRouteDefinition<OpenClawRouteDeps>[] = [
  { method: 'GET', path: '/api/openclaw/status', handle: (_context, deps) => routeResponder.value(() => deps.openClawService.status()) },
  { method: 'GET', path: '/api/openclaw/ready', handle: (_context, deps) => routeResponder.value(() => deps.openClawService.ready()) },
  { method: 'GET', path: '/api/openclaw/dir', handle: (_context, deps) => routeResponder.ok(deps.openClawService.dir()) },
  { method: 'GET', path: '/api/openclaw/config-dir', handle: (_context, deps) => routeResponder.ok(deps.openClawService.configDir()) },
  { method: 'GET', path: '/api/openclaw/subagent-templates', handle: (_context, deps) => routeResponder.value(() => deps.openClawService.subagentTemplates()) },
  {
    method: 'GET',
    pattern: /^\/api\/openclaw\/subagent-templates\/(.+)$/,
    handle: (_context, deps, match) => routeResponder.value(() => deps.openClawService.subagentTemplate(decodeRouteParam(match.params[0]))),
  },
  { method: 'GET', path: '/api/openclaw/workspace-dir', handle: (_context, deps) => routeResponder.value(() => deps.openClawService.workspaceDir()) },
  { method: 'GET', path: '/api/openclaw/task-workspace-dirs', handle: (_context, deps) => routeResponder.value(() => deps.openClawService.taskWorkspaceDirs()) },
  { method: 'GET', path: '/api/openclaw/skills-dir', handle: (_context, deps) => routeResponder.ok(deps.openClawService.skillsDir()) },
  { method: 'GET', path: '/api/openclaw/cli-command', handle: (_context, deps) => routeResponder.value(() => deps.openClawService.cliCommand()) },
  { method: 'GET', path: '/api/openclaw/tool-permission-mode', handle: (_context, deps) => routeResponder.value(() => deps.openClawService.toolPermissionMode()) },
  {
    method: 'PUT',
    path: '/api/openclaw/tool-permission-mode',
    handle: (context, deps) => {
      const mode = readPermissionMode(context.payload);
      return mode
        ? routeResponder.value(() => deps.openClawService.setToolPermissionMode(mode))
        : badRequest('permission mode must be "default" or "fullAccess"');
    },
  },
] as const;

