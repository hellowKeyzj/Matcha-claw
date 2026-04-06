import { collectDiagnosticsBundle } from './diagnostics-bundle';

type DiagnosticsCollectInput = {
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

export async function collectDiagnosticsBundleLocal(input: DiagnosticsCollectInput) {
  return await collectDiagnosticsBundle({
    userDataDir: input.userDataDir,
    openclawConfigDir: input.openclawConfigDir,
    appInfo: input.appInfo,
    gateway: {
      status: input.gatewayStatus,
      runtimePaths: input.gatewayRuntimePaths,
    },
    license: {
      gateSnapshot: input.licenseGateSnapshot,
    },
  });
}
