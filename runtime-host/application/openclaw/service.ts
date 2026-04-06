import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveMainWorkspaceDir, resolveTaskWorkspaceDirs } from './openclaw-workspace-rules';

interface OpenClawStatus {
  packageExists: boolean;
  isBuilt: boolean;
  entryPath: string;
  dir: string;
  version?: string;
}

export interface OpenClawServiceDeps {
  readonly readOpenClawConfigJson: () => Record<string, unknown>;
  readonly getOpenClawStatus: () => OpenClawStatus;
  readonly getOpenClawDirPath: () => string;
  readonly getOpenClawConfigDir: () => string;
  readonly getSubagentTemplateCatalogFromSources: () => unknown;
  readonly getSubagentTemplateFromSources: (templateId: string) => unknown;
}

export class OpenClawService {
  constructor(private readonly deps: OpenClawServiceDeps) {}

  status() {
    return this.deps.getOpenClawStatus();
  }

  ready() {
    return this.deps.getOpenClawStatus().packageExists;
  }

  dir() {
    return this.deps.getOpenClawDirPath();
  }

  configDir() {
    return this.deps.getOpenClawConfigDir();
  }

  subagentTemplates() {
    return this.deps.getSubagentTemplateCatalogFromSources();
  }

  subagentTemplate(templateIdRaw: string) {
    let templateId = '';
    try {
      templateId = decodeURIComponent(templateIdRaw);
    } catch {
      templateId = templateIdRaw;
    }
    return this.deps.getSubagentTemplateFromSources(templateId);
  }

  workspaceDir() {
    return resolveMainWorkspaceDir(this.deps.readOpenClawConfigJson(), this.deps.getOpenClawConfigDir());
  }

  taskWorkspaceDirs() {
    return resolveTaskWorkspaceDirs(this.deps.readOpenClawConfigJson(), this.deps.getOpenClawConfigDir());
  }

  skillsDir() {
    return join(this.deps.getOpenClawConfigDir(), 'skills');
  }

  cliCommand() {
    const status = this.deps.getOpenClawStatus();
    if (!status.packageExists) {
      return { success: false, error: `OpenClaw package not found at: ${status.dir}` };
    }
    if (!existsSync(status.entryPath)) {
      return { success: false, error: `OpenClaw entry script not found at: ${status.entryPath}` };
    }
    const binName = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
    const binPath = join(dirname(status.dir), '.bin', binName);
    if (existsSync(binPath)) {
      if (process.platform === 'win32') {
        return { success: true, command: `& '${binPath}'` };
      }
      return { success: true, command: `"${binPath}"` };
    }
    if (process.platform === 'win32') {
      return { success: true, command: `node '${status.entryPath}'` };
    }
    return { success: true, command: `node "${status.entryPath}"` };
  }
}
