import type { OpenClawEnvironmentRepository } from '../openclaw/openclaw-environment-repository';
import { accepted, badRequest, ok } from '../common/application-response';
import type { RuntimePlatform, RuntimeProcessInfoPort } from '../common/runtime-ports';
import type { LicenseService } from '../license/service';
import type { DiagnosticsService } from '../support/diagnostics';
import type { RuntimeHostBootstrapService } from './bootstrap';
import type { ParentShellPort } from './parent-shell-port';
import type { RuntimeJobsService } from './runtime-jobs-service';
import type { RuntimeHostStatePort } from './runtime-state';

type DiagnosticsInput = {
  userDataDir: string;
  openclawConfigDir: string;
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

type RuntimeJobsListInput = {
  type?: string;
};

export interface RuntimeHostServiceDeps {
  readonly environment: Pick<OpenClawEnvironmentRepository, 'getPlatform' | 'getArch' | 'getOpenClawConfigDir'>;
  readonly processInfo: Pick<RuntimeProcessInfoPort, 'nodeVersion'>;
  readonly systemEnvironment: {
    readonly appName: string;
    readonly appVersion: string;
    readonly isPackaged: boolean;
    readonly platform: RuntimePlatform;
    readonly arch: string;
    readonly electronVersion?: string;
  };
  readonly runtimeState: RuntimeHostStatePort;
  readonly bootstrap: Pick<
    RuntimeHostBootstrapService,
    | 'submitGatewayPrelaunch'
    | 'submitProviderAuthBootstrap'
    | 'buildProviderEnvMap'
    | 'getHostBootstrapSettings'
    | 'buildGatewayLaunchPlan'
    | 'onGatewayLifecycle'
  >;
  readonly diagnostics: Pick<DiagnosticsService, 'submitCollect'>;
  readonly license: Pick<LicenseService, 'gate'>;
  readonly jobs: Pick<RuntimeJobsService, 'list' | 'get'>;
  readonly parentShell: Pick<ParentShellPort, 'request'>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class RuntimeHostService {
  constructor(private readonly deps: RuntimeHostServiceDeps) {}

  health() {
    return this.deps.runtimeState.health();
  }

  transportStats() {
    return this.deps.runtimeState.transportStats();
  }

  async prepareGatewayLaunch(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return accepted(this.deps.bootstrap.submitGatewayPrelaunch({
      ...(typeof body.gatewayToken === 'string' ? { gatewayToken: body.gatewayToken } : {}),
      ...(typeof body.proxyEnabled === 'boolean' ? { proxyEnabled: body.proxyEnabled } : {}),
      ...(typeof body.proxyServer === 'string' ? { proxyServer: body.proxyServer } : {}),
      ...(typeof body.proxyBypassRules === 'string' ? { proxyBypassRules: body.proxyBypassRules } : {}),
    }));
  }

  providerEnvMap() {
    return {
      success: true,
      ...this.deps.bootstrap.buildProviderEnvMap(),
    };
  }

  async hostBootstrapSettings() {
    return ok({
      success: true,
      settings: await this.deps.bootstrap.getHostBootstrapSettings(),
    });
  }

  async gatewayLaunchPlan() {
    return ok({
      success: true,
      plan: await this.deps.bootstrap.buildGatewayLaunchPlan(),
    });
  }

  syncProviderAuthBootstrap() {
    return accepted(this.deps.bootstrap.submitProviderAuthBootstrap());
  }

  gatewayLifecycle(payload: unknown) {
    return ok({
      success: true,
      job: this.deps.bootstrap.onGatewayLifecycle(payload),
    });
  }

  async collectDiagnostics(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const hostSnapshot = await this.readHostDiagnosticsSnapshot();
    const snapshot = isRecord(hostSnapshot.snapshot) ? hostSnapshot.snapshot : {};
    const appInfo = isRecord(body.appInfo)
      ? body.appInfo
      : (isRecord(snapshot.appInfo) ? snapshot.appInfo : this.buildRuntimeHostAppInfo());
    const userDataDir = typeof body.userDataDir === 'string'
      ? body.userDataDir.trim()
      : (typeof snapshot.userDataDir === 'string' ? snapshot.userDataDir.trim() : '');
    const openclawConfigDir = typeof body.openclawConfigDir === 'string'
      ? body.openclawConfigDir.trim()
      : this.deps.environment.getOpenClawConfigDir();
    if (!userDataDir || !openclawConfigDir || !appInfo) {
      return badRequest('diagnostics payload invalid: userDataDir/openclawConfigDir/appInfo are required');
    }

    const input = {
        userDataDir,
        openclawConfigDir,
        appInfo: {
          name: typeof appInfo.name === 'string' ? appInfo.name : 'MatchaClaw',
          version: typeof appInfo.version === 'string' ? appInfo.version : '0.0.0',
          isPackaged: appInfo.isPackaged === true,
          platform: typeof appInfo.platform === 'string' ? appInfo.platform as RuntimePlatform : this.deps.environment.getPlatform(),
          arch: typeof appInfo.arch === 'string' ? appInfo.arch : this.deps.environment.getArch(),
          ...(typeof appInfo.electron === 'string' ? { electron: appInfo.electron } : {}),
          node: typeof appInfo.node === 'string' ? appInfo.node : this.deps.processInfo.nodeVersion,
        },
        gatewayStatus: 'gatewayStatus' in body ? body.gatewayStatus : snapshot.gatewayStatus,
        gatewayRuntimePaths: body.gatewayRuntimePaths,
        licenseGateSnapshot: (await this.deps.license.gate()).data,
      };
    return accepted(this.deps.diagnostics.submitCollect(input));
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

  runtimeJobs(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return this.deps.jobs.list(typeof body.type === 'string' ? body.type : undefined);
  }

  runtimeJob(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
    if (!jobId) {
      return badRequest('jobId is required');
    }
    return ok(this.deps.jobs.get(jobId));
  }
}
