import type { RuntimeHostLogger } from '../../../../shared/logger';
import type { OpenClawConfigRepositoryPort } from '../infrastructure/openclaw-config-repository';
import type { OpenClawOAuthPluginRegistrationService } from './openclaw-oauth-plugin-registration';
import { applyOpenClawConfigSanitizerRules } from './openclaw-config-sanitizer-rules';
import type { OpenClawEnvironmentRepository } from '../infrastructure/openclaw-environment-repository';

function markRestartCommand(config: Record<string, unknown>): void {
  const commands = (
    config.commands && typeof config.commands === 'object'
      ? { ...(config.commands as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  commands.restart = true;
  config.commands = commands;
}

export async function sanitizeOpenClawConfig(
  configRepository: OpenClawConfigRepositoryPort,
  oauthPlugins: Pick<OpenClawOAuthPluginRegistrationService, 'discoverBundledPlugins' | 'ensureOAuthPluginEnabled'>,
  environment: OpenClawEnvironmentRepository,
  logger: RuntimeHostLogger,
): Promise<void> {
  const openclawConfigPath = configRepository.getConfigFilePath();
  if (!(await environment.pathExists(openclawConfigPath))) {
    logger.info('[sanitize] openclaw.json does not exist yet, skipping sanitization');
    return;
  }

  let sanitized = false;
  await configRepository.updateDirty(async (config) => {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { result: undefined, changed: false };
    }
    const modified = await applyOpenClawConfigSanitizerRules(config, {
      fileExists: (pathname) => environment.pathExists(pathname),
      discoverBundledPluginIds: async () => (await oauthPlugins.discoverBundledPlugins()).all,
      ensureOAuthPluginEnabled: async (targetConfig, provider) => await oauthPlugins.ensureOAuthPluginEnabled(targetConfig, provider),
      localBuildOpenClawPluginsDir: environment.getLocalBuildOpenClawPluginsDir(),
      info: (message) => logger.info(message),
    });

    if (modified) {
      markRestartCommand(config);
      sanitized = true;
    }
    return { result: undefined, changed: modified };
  });
  if (sanitized) {
    logger.info('[sanitize] openclaw.json sanitized successfully');
  }
}
