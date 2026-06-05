import type { RuntimeCommandExecutorPort, RuntimeFileSystemPort, RuntimePlatform } from '../../common/runtime-ports';
import type { ToolchainUvRuntimePort } from '../../toolchain/uv-service';

export interface UvPythonInstallWorkflowDeps {
  readonly runtime: ToolchainUvRuntimePort;
  readonly commandExecutor: RuntimeCommandExecutorPort;
  readonly fileSystem: RuntimeFileSystemPort;
}

export class UvPythonInstallWorkflow {
  constructor(private readonly deps: UvPythonInstallWorkflowDeps) {}

  async checkInstalled(): Promise<boolean> {
    for (const candidate of this.deps.projection.getBundledUvPathCandidates()) {
      if (await this.deps.fileSystem.exists(candidate)) {
        return true;
      }
    }
    return await this.findUvInPath(this.deps.projection.getPlatform());
  }

  async executeInstall() {
    const uvExecutable = await this.resolveUvExecutableForInstall();
    if (uvExecutable === 'uv' && !(await this.findUvInPath(this.deps.projection.getPlatform()))) {
      return {
        success: false,
        error: 'uv not found in system PATH',
      };
    }

    try {
      await this.deps.commandExecutor.execFile(uvExecutable, ['python', 'install', '3.12'], {
        windowsHide: true,
      });
      return { success: true };
    } catch (error) {
      const execError = error as Partial<Error> & {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        code?: string | number;
      };
      return {
        success: false,
        error: String(execError.stderr || execError.stdout || execError.message || `uv exited with code ${String(execError.code)}`),
      };
    }
  }

  private async resolveUvExecutableForInstall(): Promise<string> {
    for (const candidate of this.deps.projection.getBundledUvPathCandidates()) {
      if (await this.deps.fileSystem.exists(candidate)) {
        return candidate;
      }
    }
    return 'uv';
  }

  private async findUvInPath(platform: RuntimePlatform): Promise<boolean> {
    const command = platform === 'win32' ? 'where.exe' : 'which';
    try {
      await this.deps.commandExecutor.execFile(command, ['uv'], {
        timeout: 5000,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }
}
