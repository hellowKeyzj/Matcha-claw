import { dirname, join } from 'node:path';
import type { RuntimePlatform } from '../../common/runtime-ports';
import type { OpenClawStatusSnapshot } from '../../infrastructure/openclaw-environment-repository';

export interface OpenClawCliCommandWorkflowDeps {
  readonly environment: {
    getOpenClawStatus(): Promise<OpenClawStatusSnapshot>;
    getPlatform(): RuntimePlatform;
    pathExists(pathname: string): Promise<boolean>;
  };
}

export type OpenClawCliCommandResult =
  | { readonly success: true; readonly command: string }
  | { readonly success: false; readonly error: string };

export class OpenClawCliCommandWorkflow {
  constructor(private readonly deps: OpenClawCliCommandWorkflowDeps) {}

  async cliCommand(): Promise<OpenClawCliCommandResult> {
    const status = await this.deps.environment.getOpenClawStatus();
    if (!status.packageExists) {
      return { success: false, error: `OpenClaw package not found at: ${status.dir}` };
    }
    if (!(await this.deps.environment.pathExists(status.entryPath))) {
      return { success: false, error: `OpenClaw entry script not found at: ${status.entryPath}` };
    }
    const platform = this.deps.environment.getPlatform();
    const binName = platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
    const binPath = join(dirname(status.dir), '.bin', binName);
    if (await this.deps.environment.pathExists(binPath)) {
      return { success: true, command: platform === 'win32' ? `& '${binPath}'` : `"${binPath}"` };
    }
    return { success: true, command: platform === 'win32' ? `node '${status.entryPath}'` : `node "${status.entryPath}"` };
  }
}
