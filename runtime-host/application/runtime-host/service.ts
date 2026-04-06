type DiagnosticsInput = {
  userDataDir: string;
  openclawConfigDir: string;
  appInfo: {
    name: string;
    version: string;
    isPackaged: boolean;
    platform: NodeJS.Platform;
    arch: string;
    electron?: string;
    node: string;
  };
  gatewayStatus?: unknown;
  gatewayRuntimePaths?: unknown;
  licenseGateSnapshot?: unknown;
};

export interface RuntimeHostServiceDeps {
  readonly createHealthPayload: () => unknown;
  readonly buildTransportStatsSnapshot: () => unknown;
  readonly syncGatewayConfig: (input: {
    gatewayToken?: string;
    proxyEnabled?: boolean;
    proxyServer?: string;
    proxyBypassRules?: string;
  }) => Promise<{ configuredChannels: string[] }>;
  readonly buildProviderEnvMap: () => {
    keyableProviderTypes: string[];
    envVarByProviderType: Record<string, string>;
  };
  readonly syncProviderAuthBootstrap: () => Promise<{
    syncedApiKeyCount: number;
    defaultProviderId?: string;
  }>;
  readonly collectDiagnostics: (input: DiagnosticsInput) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class RuntimeHostService {
  constructor(private readonly deps: RuntimeHostServiceDeps) {}

  health() {
    return this.deps.createHealthPayload();
  }

  transportStats() {
    return this.deps.buildTransportStatsSnapshot();
  }

  async syncGatewayConfig(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return {
      success: true,
      ...(await this.deps.syncGatewayConfig({
        gatewayToken: typeof body.gatewayToken === 'string' ? body.gatewayToken : undefined,
        proxyEnabled: body.proxyEnabled === true,
        proxyServer: typeof body.proxyServer === 'string' ? body.proxyServer : undefined,
        proxyBypassRules: typeof body.proxyBypassRules === 'string' ? body.proxyBypassRules : undefined,
      })),
    };
  }

  providerEnvMap() {
    return {
      success: true,
      ...this.deps.buildProviderEnvMap(),
    };
  }

  async syncProviderAuthBootstrap() {
    return {
      success: true,
      ...(await this.deps.syncProviderAuthBootstrap()),
    };
  }

  async collectDiagnostics(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const appInfo = isRecord(body.appInfo) ? body.appInfo : null;
    const userDataDir = typeof body.userDataDir === 'string' ? body.userDataDir.trim() : '';
    const openclawConfigDir = typeof body.openclawConfigDir === 'string' ? body.openclawConfigDir.trim() : '';
    if (!userDataDir || !openclawConfigDir || !appInfo) {
      return {
        status: 400,
        data: {
          success: false,
          error: 'diagnostics payload invalid: userDataDir/openclawConfigDir/appInfo are required',
        },
      };
    }

    return {
      status: 200,
      data: await this.deps.collectDiagnostics({
        userDataDir,
        openclawConfigDir,
        appInfo: {
          name: typeof appInfo.name === 'string' ? appInfo.name : 'MatchaClaw',
          version: typeof appInfo.version === 'string' ? appInfo.version : '0.0.0',
          isPackaged: appInfo.isPackaged === true,
          platform: (typeof appInfo.platform === 'string' ? appInfo.platform : process.platform) as NodeJS.Platform,
          arch: typeof appInfo.arch === 'string' ? appInfo.arch : process.arch,
          ...(typeof appInfo.electron === 'string' ? { electron: appInfo.electron } : {}),
          node: typeof appInfo.node === 'string' ? appInfo.node : process.versions.node,
        },
        gatewayStatus: body.gatewayStatus,
        gatewayRuntimePaths: body.gatewayRuntimePaths,
        licenseGateSnapshot: body.licenseGateSnapshot,
      }),
    };
  }
}
