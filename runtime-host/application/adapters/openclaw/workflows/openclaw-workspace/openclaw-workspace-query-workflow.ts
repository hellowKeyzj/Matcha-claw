import { join } from 'node:path';
import type { OpenClawWorkspaceConfigPort } from '../../infrastructure/openclaw-config-repository';
import { resolveMainWorkspaceDir, resolveTaskWorkspaceDirs, resolveWorkspaceDirForSession } from '../../infrastructure/openclaw-workspace-rules';

export interface OpenClawWorkspaceQueryWorkflowDeps {
  readonly config: OpenClawWorkspaceConfigPort;
}

export class OpenClawWorkspaceQueryWorkflow {
  constructor(private readonly deps: OpenClawWorkspaceQueryWorkflowDeps) {}

  getConfigDir(): string {
    return this.deps.config.getConfigDir();
  }

  getSkillsDir(): string {
    return join(this.getConfigDir(), 'skills');
  }

  getDefaultSkillReadmePath(skillKey: string): string {
    return join(this.getSkillsDir(), skillKey, 'SKILL.md');
  }

  async getPreviewRoots(): Promise<string[]> {
    const configDir = this.deps.config.getConfigDir();
    const config = await this.deps.config.read();
    return [
      this.getSkillsDir(),
      resolveMainWorkspaceDir(config, configDir),
      ...resolveTaskWorkspaceDirs(config, configDir),
    ];
  }

  async getMainWorkspaceDir(): Promise<string> {
    return resolveMainWorkspaceDir(await this.deps.config.read(), this.deps.config.getConfigDir());
  }

  async getWorkspaceDirForSession(sessionKey: string): Promise<string> {
    return resolveWorkspaceDirForSession(await this.deps.config.read(), this.deps.config.getConfigDir(), sessionKey);
  }

  async getTaskWorkspaceDirs(): Promise<string[]> {
    return resolveTaskWorkspaceDirs(await this.deps.config.read(), this.deps.config.getConfigDir());
  }
}
