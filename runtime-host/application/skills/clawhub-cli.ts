import type { RuntimeCommandExecutorPort, RuntimeFileSystemPort, RuntimeProcessInfoPort } from '../common/runtime-ports';
import type { OpenClawConfigRepositoryPort } from '../openclaw/openclaw-config-repository';
import type { OpenClawEnvironmentRepository } from '../openclaw/openclaw-environment-repository';
import type { ClawHubRegistryClient } from './clawhub-registry-client';

async function resolveCliEntry(
  environment: OpenClawEnvironmentRepository,
  fileSystem: RuntimeFileSystemPort,
) {
  const candidates = environment.getClawHubCliEntryCandidates();
  for (const candidate of candidates) {
    if (await fileSystem.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

type CliCommandResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string };

export class ClawHubCliRunner {
  constructor(
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly environment: OpenClawEnvironmentRepository,
    private readonly registryClient: Pick<ClawHubRegistryClient, 'resolveRegistryBases'>,
    private readonly commandExecutor: RuntimeCommandExecutorPort,
    private readonly processInfo: RuntimeProcessInfoPort,
    private readonly fileSystem: RuntimeFileSystemPort,
  ) {}

  async runWithRegistryFallback(args: string[]): Promise<CliCommandResult> {
    const registries = this.registryClient.resolveRegistryBases();
    const errors: string[] = [];
    for (const registryBase of registries) {
      const result = await this.runCommand(args, registryBase);
      if (result.ok) {
        return result;
      }
      errors.push(`${registryBase}: ${result.error}`);
    }
    return {
      ok: false,
      error: errors.join(' | ') || 'clawhub command failed',
    };
  }

  private async runCommand(args: string[], registryBase: string): Promise<CliCommandResult> {
    const entry = await resolveCliEntry(this.environment, this.fileSystem);
    if (!entry) {
      return {
        ok: false,
        error: `ClawHub CLI entry not found. Checked: ${this.environment.getClawHubCliEntryCandidates().join(' | ')}`,
      };
    }

    const workDir = this.configRepository.getConfigDir();
    try {
      const result = await this.commandExecutor.execFile(this.processInfo.execPath, [entry, ...args], {
        cwd: workDir,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
        env: {
          ...this.environment.getProcessEnv(),
          ELECTRON_RUN_AS_NODE: '1',
          CI: 'true',
          FORCE_COLOR: '0',
          CLAWHUB_WORKDIR: workDir,
          CLAWHUB_REGISTRY: registryBase,
        },
      });
      return {
        ok: true,
        stdout: String(result.stdout || '').trim(),
        stderr: String(result.stderr || '').trim(),
      };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown; code?: unknown };
      const output = String(failure.stderr || failure.stdout || '').trim();
      const code = failure.code == null ? '' : ` with code ${String(failure.code)}`;
      return { ok: false, error: output || failure.message || `clawhub exited${code}` };
    }
  }
}
