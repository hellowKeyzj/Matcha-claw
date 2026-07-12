import type { RuntimeHostBootstrapJobPort, GatewayPrelaunchInput } from './bootstrap-jobs';
import type {
  GatewayLaunchPlan,
  GatewayPrelaunchResult,
  GatewayPrelaunchWorkflow,
  HostBootstrapSettings,
} from '../workflows/runtime-bootstrap/gateway-prelaunch-workflow';
import { buildProviderEnvMap } from '../workflows/runtime-bootstrap/gateway-prelaunch-workflow';

export interface RuntimeHostRuntimeConfigPort {
  syncProxy(input: {
    proxyEnabled: boolean;
    proxyServer: string;
    proxyBypassRules: string;
  }, options: { preserveExistingWhenDisabled?: boolean }): Promise<void>;
  syncGatewayToken(token: string): Promise<void>;
  sanitize(): Promise<void>;
  syncBrowserMode(browserMode: string): Promise<void>;
  syncSessionIdleMinutes(): Promise<void>;
}

export interface RuntimeHostWorkspaceBootstrapPort {
  ensureDefaultIdentity(): Promise<unknown>;
  migrateMainAgentTemplatesIfNeeded(): Promise<unknown>;
  mergeContextSnippets(): Promise<unknown>;
}

export type {
  GatewayLaunchPlan,
  GatewayPrelaunchResult,
  HostBootstrapSettings,
};

export class RuntimeHostBootstrapService {
  constructor(
    private readonly deps: {
      gatewayPrelaunchWorkflow: Pick<
        GatewayPrelaunchWorkflow,
        | 'getHostBootstrapSettings'
        | 'buildGatewayLaunchPlan'
        | 'executeGatewayPrelaunch'
        | 'executeWorkspaceTemplateMigration'
      >;
      jobs: RuntimeHostBootstrapJobPort;
    },
  ) {}

  submitGatewayPrelaunch(input: GatewayPrelaunchInput) {
    return this.deps.jobs.submitGatewayPrelaunch(input);
  }

  submitWorkspaceTemplateMigration() {
    return this.deps.jobs.submitWorkspaceTemplateMigration();
  }

  async getHostBootstrapSettings(): Promise<HostBootstrapSettings> {
    return await this.deps.gatewayPrelaunchWorkflow.getHostBootstrapSettings();
  }

  async buildGatewayLaunchPlan(): Promise<GatewayLaunchPlan> {
    return await this.deps.gatewayPrelaunchWorkflow.buildGatewayLaunchPlan();
  }

  async executeGatewayPrelaunch(input: GatewayPrelaunchInput): Promise<GatewayPrelaunchResult> {
    return await this.deps.gatewayPrelaunchWorkflow.executeGatewayPrelaunch(input);
  }

  buildProviderEnvMap() {
    return buildProviderEnvMap();
  }

  async executeWorkspaceTemplateMigration() {
    return await this.deps.gatewayPrelaunchWorkflow.executeWorkspaceTemplateMigration();
  }

  onGatewayLifecycle(payload: unknown) {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    if (body.state === 'running') {
      return null;
    }
    return null;
  }
}
