import type { RuntimePlatform, RuntimeProcessInfoPort } from '../../common/runtime-ports';
import { accepted, badRequest } from '../../common/application-response';
import type { LicenseService } from '../../license/service';
import type { DiagnosticsService } from '../../support/diagnostics';
import type { ParentShellPort } from '../../runtime-host/parent-shell-port';
import type { RuntimeHostEnvironmentPort } from '../../runtime-host/service';

type DiagnosticsInput = {
  userDataDir: string;
  runtimeDataRootDir: string;
  appInfo: {
    name: string;
    version: string;
    isPackaged: boolean;
    platform: RuntimePlatform;
    arch: string;
    electron?: string;
    node: string;
  };
  gatewayStatus?: unknown;
  gatewayRuntimePaths?: unknown;
};

export interface DiagnosticsCollectionWorkflowDeps {
  readonly environment: RuntimeHostEnvironmentPort;
  readonly processInfo: Pick<RuntimeProcessInfoPort, 'nodeVersion'>;
  readonly systemEnvironment: {
    readonly appName: string;
    readonly appVersion: string;
    readonly isPackaged: boolean;
    readonly platform: RuntimePlatform;
    readonly arch: string;
    readonly electronVersion?: string;
  };
  readonly diagnostics: Pick<DiagnosticsService, 'submitCollect'>;
  readonly license: Pick<LicenseService, 'gate'>;
  readonly parentShell: Pick<ParentShellPort, 'request'>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class DiagnosticsCollectionWorkflow {
  constructor(private readonly deps: DiagnosticsCollectionWorkflowDeps) {}

  async execute(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const hostSnapshot = await this.readHostDiagnosticsSnapshot();
    const snapshot = isRecord(hostSnapshot.snapshot) ? hostSnapshot.snapshot : {};
    const appInfo = isRecord(body.appInfo)
      ? body.appInfo
      : (isRecord(snapshot.appInfo) ? snapshot.appInfo : this.buildRuntimeHostAppInfo());
    const userDataDir = typeof body.userDataDir === 'string'
      ? body.userDataDir.trim()
      : (typeof snapshot.userDataDir === 'string' ? snapshot.userDataDir.trim() : '');
    const runtimeDataRootDir = typeof body.runtimeDataRootDir === 'string'
      ? body.runtimeDataRootDir.trim()
      : this.deps.environment.getRuntimeDataRootDir();
    if (!userDataDir || !runtimeDataRootDir || !appInfo) {
      return badRequest('diagnostics payload invalid: userDataDir/runtimeDataRootDir/appInfo are required');
    }

    return accepted(this.deps.diagnostics.submitCollect({
      userDataDir,
      runtimeDataRootDir,
      appInfo: {
        name: typeof appInfo.name === 'string' ? appInfo.name : 'MatchaClaw',
        version: typeof appInfo.version === 'string' ? appInfo.version : '0.0.0',
        isPackaged: appInfo.isPackaged === true,
        platform: typeof appInfo.platform === 'string' ? appInfo.platform as RuntimePlatform : this.deps.systemEnvironment.platform,
        arch: typeof appInfo.arch === 'string' ? appInfo.arch : this.deps.systemEnvironment.arch,
        ...(typeof appInfo.electron === 'string' ? { electron: appInfo.electron } : {}),
        node: typeof appInfo.node === 'string' ? appInfo.node : this.deps.processInfo.nodeVersion,
      },
      gatewayStatus: 'gatewayStatus' in body ? body.gatewayStatus : snapshot.gatewayStatus,
      gatewayRuntimePaths: body.gatewayRuntimePaths,
      licenseGateSnapshot: (await this.deps.license.gate()).data,
    }));
  }

  private buildRuntimeHostAppInfo(): DiagnosticsInput['appInfo'] {
    return {
      name: this.deps.systemEnvironment.appName,
      version: this.deps.systemEnvironment.appVersion,
      isPackaged: this.deps.systemEnvironment.isPackaged,
      platform: this.deps.systemEnvironment.platform,
      arch: this.deps.systemEnvironment.arch,
      ...(this.deps.systemEnvironment.electronVersion ? { electron: this.deps.systemEnvironment.electronVersion } : {}),
      node: this.deps.processInfo.nodeVersion,
    };
  }

  private async readHostDiagnosticsSnapshot(): Promise<Record<string, unknown>> {
    try {
      const response = await this.deps.parentShell.request('host_diagnostics_snapshot');
      if (!response.success) {
        return {};
      }
      return isRecord(response.data) ? response.data : {};
    } catch {
      return {};
    }
  }
}
