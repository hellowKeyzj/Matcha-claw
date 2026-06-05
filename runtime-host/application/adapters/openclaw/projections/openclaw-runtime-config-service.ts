import { sanitizeOpenClawConfig } from './openclaw-config-sanitizer';
import { syncProxyConfigToOpenClaw, type ProxySettings, type SyncProxyOptions } from './openclaw-proxy-sync';
import {
  syncBrowserModeToOpenClaw,
  syncGatewayTokenToConfig,
  syncSessionIdleMinutesToOpenClaw,
} from './openclaw-runtime-config-sync';
import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';
import type { OpenClawOAuthPluginRegistrationService } from './openclaw-oauth-plugin-registration';
import type { OpenClawEnvironmentRepository } from '../infrastructure/openclaw-environment-repository';
import type { PluginFileSystemPort } from '../../../../plugin-engine/plugin-file-system';
import type { RuntimeHostLogger } from '../../../../shared/logger';

export class OpenClawRuntimeConfigService {
  constructor(
    private readonly configRepository: OpenClawConfigRepositoryPort,
    private readonly oauthPlugins: Pick<OpenClawOAuthPluginRegistrationService, 'discoverBundledPlugins' | 'ensureOAuthPluginEnabled'>,
    private readonly environment: OpenClawEnvironmentRepository,
    private readonly pluginFileSystem: Pick<PluginFileSystemPort, 'pathExists' | 'readJsonRecord' | 'listDirectoryEntries'>,
    private readonly logger: RuntimeHostLogger,
  ) {}

  async syncProxy(settings: ProxySettings, options: SyncProxyOptions = {}): Promise<void> {
    await syncProxyConfigToOpenClaw(this.configRepository, settings, this.logger, options);
  }

  async syncGatewayToken(token: string): Promise<void> {
    await syncGatewayTokenToConfig(this.configRepository, token, this.logger);
  }

  async sanitize(): Promise<void> {
    await sanitizeOpenClawConfig(this.configRepository, this.oauthPlugins, this.environment, this.logger);
  }

  async syncBrowserMode(mode: unknown): Promise<void> {
    await syncBrowserModeToOpenClaw(this.configRepository, this.pluginFileSystem, mode, this.logger);
  }

  async syncSessionIdleMinutes(): Promise<void> {
    await syncSessionIdleMinutesToOpenClaw(this.configRepository, this.logger);
  }
}
