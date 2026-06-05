import { collectDiagnosticsBundle } from './diagnostics-bundle';
import type {
  RuntimeClockPort,
  RuntimeCommandExecutorPort,
  RuntimeFileSystemPort,
  RuntimeProcessInfoPort,
} from '../common/runtime-ports';
import type { DiagnosticsCollectInput, DiagnosticsJobPort } from './diagnostics-jobs';
import type { DiagnosticsRuntimeBundleLayoutPort } from './diagnostics-bundle';

export class DiagnosticsService {
  constructor(
    private readonly jobs: DiagnosticsJobPort,
    private readonly processInfo: Pick<RuntimeProcessInfoPort, 'pid'>,
    private readonly commandExecutor: RuntimeCommandExecutorPort,
    private readonly fileSystem: RuntimeFileSystemPort,
    private readonly clock: RuntimeClockPort,
    private readonly runtimeLayout: DiagnosticsRuntimeBundleLayoutPort,
  ) {}

  submitCollect(input: DiagnosticsCollectInput) {
    return this.jobs.submitCollect(input);
  }

  async collect(input: DiagnosticsCollectInput) {
    return await collectDiagnosticsBundle({
      userDataDir: input.userDataDir,
      runtimeDataRootDir: input.runtimeDataRootDir,
      runtimeLayout: this.runtimeLayout,
      appInfo: input.appInfo,
      gateway: {
        status: input.gatewayStatus,
        runtimePaths: input.gatewayRuntimePaths,
      },
      license: {
        gateSnapshot: input.licenseGateSnapshot,
      },
      processId: this.processInfo.pid,
      clock: this.clock,
      fileSystem: this.fileSystem,
      commandExecutor: this.commandExecutor,
    });
  }
}
