import { OpenClawService } from '../../application/openclaw/service';

interface OpenClawRouteDeps {
  readOpenClawConfigJson: () => Record<string, unknown>;
  getOpenClawStatus: () => {
    packageExists: boolean;
    isBuilt: boolean;
    entryPath: string;
    dir: string;
    version?: string;
  };
  getOpenClawDirPath: () => string;
  getOpenClawConfigDir: () => string;
  getSubagentTemplateCatalogFromSources: () => unknown;
  getSubagentTemplateFromSources: (templateId: string) => unknown;
}

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

export function handleOpenClawRoute(
  method: string,
  routePath: string,
  deps: OpenClawRouteDeps,
): LocalDispatchResponse | null {
  const service = new OpenClawService(deps);

  if (method === 'GET' && routePath === '/api/openclaw/status') {
    return {
      status: 200,
      data: service.status(),
    };
  }

  if (method === 'GET' && routePath === '/api/openclaw/ready') {
    return {
      status: 200,
      data: service.ready(),
    };
  }

  if (method === 'GET' && routePath === '/api/openclaw/dir') {
    return {
      status: 200,
      data: service.dir(),
    };
  }

  if (method === 'GET' && routePath === '/api/openclaw/config-dir') {
    return {
      status: 200,
      data: service.configDir(),
    };
  }

  if (method === 'GET' && routePath === '/api/openclaw/subagent-templates') {
    return {
      status: 200,
      data: service.subagentTemplates(),
    };
  }

  if (method === 'GET' && routePath.startsWith('/api/openclaw/subagent-templates/')) {
    const templateIdRaw = routePath.slice('/api/openclaw/subagent-templates/'.length);
    return {
      status: 200,
      data: service.subagentTemplate(templateIdRaw),
    };
  }

  if (method === 'GET' && routePath === '/api/openclaw/workspace-dir') {
    return {
      status: 200,
      data: service.workspaceDir(),
    };
  }

  if (method === 'GET' && routePath === '/api/openclaw/task-workspace-dirs') {
    return {
      status: 200,
      data: service.taskWorkspaceDirs(),
    };
  }

  if (method === 'GET' && routePath === '/api/openclaw/skills-dir') {
    return {
      status: 200,
      data: service.skillsDir(),
    };
  }

  if (method === 'GET' && routePath === '/api/openclaw/cli-command') {
    return {
      status: 200,
      data: service.cliCommand(),
    };
  }

  return null;
}
