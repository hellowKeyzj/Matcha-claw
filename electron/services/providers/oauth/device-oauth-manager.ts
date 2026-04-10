import { EventEmitter } from 'events';
import { shell } from 'electron';
import { logger } from '../../../utils/logger';
import { createDefaultRuntimeHostHttpClient } from '../../../main/runtime-host-client';
import {
  loginMiniMaxPortalOAuth,
  type MiniMaxOAuthToken,
  type MiniMaxRegion,
  loginQwenPortalOAuth,
  type QwenOAuthToken,
} from './device-oauth-providers';

export type OAuthProviderType = 'minimax-portal' | 'minimax-portal-cn' | 'qwen-portal';
export type { MiniMaxRegion };

const runtimeHostClient = createDefaultRuntimeHostHttpClient({
  timeoutMs: 8000,
});

class DeviceOAuthManager extends EventEmitter {
  private activeProvider: OAuthProviderType | null = null;
  private activeAccountId: string | null = null;
  private activeLabel: string | null = null;
  private active = false;
  async startFlow(
    provider: OAuthProviderType,
    region: MiniMaxRegion = 'global',
    options?: { accountId?: string; label?: string },
  ): Promise<boolean> {
    if (this.active) {
      await this.stopFlow();
    }

    this.active = true;
    this.emit('oauth:start', { provider, accountId: options?.accountId || provider });
    this.activeProvider = provider;
    this.activeAccountId = options?.accountId || provider;
    this.activeLabel = options?.label || null;

    try {
      if (provider === 'minimax-portal' || provider === 'minimax-portal-cn') {
        const actualRegion = provider === 'minimax-portal-cn' ? 'cn' : (region || 'global');
        await this.runMiniMaxFlow(actualRegion, provider);
      } else if (provider === 'qwen-portal') {
        await this.runQwenFlow();
      } else {
        throw new Error(`Unsupported OAuth provider type: ${provider}`);
      }
      return true;
    } catch (error) {
      if (!this.active) {
        return false;
      }
      logger.error(`[DeviceOAuth] Flow error for ${provider}:`, error);
      this.emitError(error instanceof Error ? error.message : String(error));
      this.active = false;
      this.activeProvider = null;
      this.activeAccountId = null;
      this.activeLabel = null;
      return false;
    }
  }

  async stopFlow(): Promise<void> {
    this.active = false;
    this.activeProvider = null;
    this.activeAccountId = null;
    this.activeLabel = null;
    logger.info('[DeviceOAuth] Flow explicitly stopped');
  }

  private async runMiniMaxFlow(region?: MiniMaxRegion, providerType: OAuthProviderType = 'minimax-portal'): Promise<void> {
    const provider = this.activeProvider!;

    const token: MiniMaxOAuthToken = await loginMiniMaxPortalOAuth({
      region,
      openUrl: async (url) => {
        logger.info(`[DeviceOAuth] MiniMax opening browser: ${url}`);
        shell.openExternal(url).catch((err) =>
          logger.warn('[DeviceOAuth] Failed to open browser:', err),
        );
      },
      note: async (message, _title) => {
        if (!this.active) return;
        const { verificationUri, userCode } = this.parseNote(message);
        if (verificationUri && userCode) {
          this.emitCode({ provider, verificationUri, userCode, expiresIn: 300 });
        } else {
          logger.info(`[DeviceOAuth] MiniMax note: ${message}`);
        }
      },
      progress: {
        update: (msg) => logger.info(`[DeviceOAuth] MiniMax progress: ${msg}`),
        stop: (msg) => logger.info(`[DeviceOAuth] MiniMax progress done: ${msg ?? ''}`),
      },
    });

    if (!this.active) return;

    await this.onSuccess(providerType, {
      access: token.access,
      refresh: token.refresh,
      expires: token.expires,
      resourceUrl: token.resourceUrl,
      api: 'anthropic-messages',
      region,
    });
  }

  private async runQwenFlow(): Promise<void> {
    const provider = this.activeProvider!;

    const token: QwenOAuthToken = await loginQwenPortalOAuth({
      openUrl: async (url) => {
        logger.info(`[DeviceOAuth] Qwen opening browser: ${url}`);
        shell.openExternal(url).catch((err) =>
          logger.warn('[DeviceOAuth] Failed to open browser:', err),
        );
      },
      note: async (message, _title) => {
        if (!this.active) return;
        const { verificationUri, userCode } = this.parseNote(message);
        if (verificationUri && userCode) {
          this.emitCode({ provider, verificationUri, userCode, expiresIn: 300 });
        } else {
          logger.info(`[DeviceOAuth] Qwen note: ${message}`);
        }
      },
      progress: {
        update: (msg) => logger.info(`[DeviceOAuth] Qwen progress: ${msg}`),
        stop: (msg) => logger.info(`[DeviceOAuth] Qwen progress done: ${msg ?? ''}`),
      },
    });

    if (!this.active) return;

    await this.onSuccess('qwen-portal', {
      access: token.access,
      refresh: token.refresh,
      expires: token.expires,
      resourceUrl: token.resourceUrl,
      api: 'openai-completions',
    });
  }

  private async onSuccess(providerType: OAuthProviderType, token: {
    access: string;
    refresh: string;
    expires: number;
    resourceUrl?: string;
    api: 'anthropic-messages' | 'openai-completions';
    region?: MiniMaxRegion;
  }) {
    const accountId = this.activeAccountId || providerType;
    const accountLabel = this.activeLabel;
    this.active = false;
    this.activeProvider = null;
    this.activeAccountId = null;
    this.activeLabel = null;
    logger.info(`[DeviceOAuth] Successfully completed OAuth for ${providerType}`);
    await runtimeHostClient.request(
      'POST',
      '/api/provider-accounts/oauth/complete-device',
      {
        providerType,
        accountId,
        ...(accountLabel ? { accountLabel } : {}),
        token,
      },
    );

    this.emit('oauth:success', { provider: providerType, accountId });
  }

  private parseNote(message: string): { verificationUri?: string; userCode?: string } {
    const urlMatch = message.match(/Open\s+(https?:\/\/\S+?)\s+to/i);
    const verificationUri = urlMatch?.[1];

    let userCode: string | undefined;

    if (verificationUri) {
      try {
        const parsed = new URL(verificationUri);
        const qp = parsed.searchParams.get('user_code');
        if (qp) userCode = qp;
      } catch {
        // fall through
      }
    }

    if (!userCode) {
      const codeMatch = message.match(/enter.*?code\s+([A-Za-z0-9][A-Za-z0-9_-]{3,})/i);
      if (codeMatch?.[1]) userCode = codeMatch[1].replace(/\.$/, '');
    }

    return { verificationUri, userCode };
  }

  private emitCode(data: {
    provider: string;
    verificationUri: string;
    userCode: string;
    expiresIn: number;
  }) {
    this.emit('oauth:code', data);
  }

  private emitError(message: string) {
    this.emit('oauth:error', { message });
  }
}

export const deviceOAuthManager = new DeviceOAuthManager();
