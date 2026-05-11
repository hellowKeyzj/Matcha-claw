import type { RuntimeCommandExecutorPort, RuntimeFileSystemPort, RuntimePlatform } from '../common/runtime-ports';
import type { OpenClawEnvironmentRepository } from '../openclaw/openclaw-environment-repository';
import type { ToolchainJobPort } from './toolchain-jobs';

async function findUvInPath(
  commandExecutor: RuntimeCommandExecutorPort,
  platform: RuntimePlatform,
): Promise<boolean> {
  const command = platform === 'win32' ? 'where.exe' : 'which';
  try {
    await commandExecutor.execFile(command, ['uv'], {
      timeout: 5000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveUvExecutableForInstall(environment: OpenClawEnvironmentRepository): Promise<string> {
  for (const candidate of environment.getBundledUvPathCandidates()) {
    if (await environment.pathExists(candidate)) {
      return candidate;
    }
  }
  return 'uv';
}

export class ToolchainUvService {
  constructor(
    private readonly environment: OpenClawEnvironmentRepository,
    private readonly commandExecutor: RuntimeCommandExecutorPort,
    private readonly fileSystem: RuntimeFileSystemPort,
    private readonly jobs: ToolchainJobPort,
  ) {}

  async checkInstalled(): Promise<boolean> {
    for (const candidate of this.environment.getBundledUvPathCandidates()) {
      if (await this.fileSystem.exists(candidate)) {
        return true;
      }
    }
    return await findUvInPath(this.commandExecutor, this.environment.getPlatform());
  }

  install() {
    return this.jobs.submitUvInstall();
  }

  async executeInstall() {
    const uvExecutable = await resolveUvExecutableForInstall(this.environment);
    if (uvExecutable === 'uv' && !(await findUvInPath(this.commandExecutor, this.environment.getPlatform()))) {
      return {
        success: false,
        error: 'uv not found in system PATH',
      };
    }

    try {
      await this.commandExecutor.execFile(uvExecutable, ['python', 'install', '3.12'], {
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
}
