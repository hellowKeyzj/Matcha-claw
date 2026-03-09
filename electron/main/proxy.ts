import { session } from 'electron';
import { getAllSettings, type AppSettings } from '../utils/store';
import { buildElectronProxyConfig, type ProxySettings } from '../utils/proxy';
import { logger } from '../utils/logger';

export async function applyProxySettings(
  partialSettings?: Partial<Pick<AppSettings, 'proxyEnabled' | 'proxyServer' | 'proxyHttpServer' | 'proxyHttpsServer' | 'proxyAllServer' | 'proxyBypassRules'>>
): Promise<void> {
  const baseSettings = await getAllSettings();
  const mergedSettings = partialSettings
    ? { ...baseSettings, ...partialSettings }
    : baseSettings;

  const proxySettings: ProxySettings = {
    proxyEnabled: mergedSettings.proxyEnabled,
    proxyServer: mergedSettings.proxyServer,
    proxyHttpServer: mergedSettings.proxyHttpServer,
    proxyHttpsServer: mergedSettings.proxyHttpsServer,
    proxyAllServer: mergedSettings.proxyAllServer,
    proxyBypassRules: mergedSettings.proxyBypassRules,
  };
  const config = buildElectronProxyConfig(proxySettings);

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
