import { GatewayManager } from '../../../gateway/manager';
import { deviceOAuthManager } from '../../../utils/device-oauth';
import { browserOAuthManager } from '../../../utils/browser-oauth';
import { logger } from '../../../utils/logger';

export function registerProviderHandlers(gatewayManager: GatewayManager): void {
  // Listen for OAuth success to automatically restart the Gateway with new tokens/configs.
  // 使用较长 debounce，避免 OAuth 与提供商配置更新触发重复重启。
  deviceOAuthManager.on('oauth:success', ({ provider, accountId }) => {
    logger.info(`[IPC] Scheduling Gateway restart after ${provider} OAuth success for ${accountId}...`);
    gatewayManager.debouncedRestart(8000);
  });
  browserOAuthManager.on('oauth:success', ({ provider, accountId }) => {
    logger.info(`[IPC] Scheduling Gateway restart after ${provider} OAuth success for ${accountId}...`);
    gatewayManager.debouncedRestart(8000);
  });
}