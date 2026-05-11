import { session } from 'electron';
import { buildElectronProxyConfig } from '../utils/proxy';
import { logger } from '../utils/logger';

export interface ElectronProxySettings {
  proxyEnabled: boolean;
  proxyServer: string;
  proxyBypassRules: string;
}

export async function applyProxySettings(
  settings: ElectronProxySettings,
): Promise<void> {
  const config = buildElectronProxyConfig(settings);

  await session.defaultSession.setProxy(config);
  try {
    await session.defaultSession.closeAllConnections();
  } catch (error) {
    logger.debug('Failed to close existing connections after proxy update:', error);
  }

  logger.info(
    `Applied Electron proxy (${config.mode}${config.proxyRules ? `, server=${config.proxyRules}` : ''}${config.proxyBypassRules ? `, bypass=${config.proxyBypassRules}` : ''})`
  );
}
