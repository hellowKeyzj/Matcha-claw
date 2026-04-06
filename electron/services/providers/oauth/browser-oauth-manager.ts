import { EventEmitter } from 'events';
import { shell } from 'electron';
import { logger } from '../../../utils/logger';
import { setProviderSecret } from '../../secrets/secret-store';
import { createDefaultRuntimeHostHttpClient } from '../../../main/runtime-host-client';
import { loginGeminiCliOAuth, type GeminiCliOAuthCredentials } from './gemini-cli-oauth';
import { loginOpenAICodexOAuth, type OpenAICodexOAuthCredentials } from './openai-codex-oauth';

export type BrowserOAuthProviderType = 'google' | 'openai';

const GOOGLE_RUNTIME_PROVIDER_ID = 'google-gemini-cli';
const OPENAI_RUNTIME_PROVIDER_ID = 'openai-codex';
const runtimeHostClient = createDefaultRuntimeHostHttpClient({
  timeoutMs: 8000,
});

class BrowserOAuthManager extends EventEmitter {
  private activeProvider: BrowserOAuthProviderType | null = null;
  private activeAccountId: string | null = null;
  private activeLabel: string | null = null;
  private active = false;
  private pendingManualCodeResolve: ((value: string) => void) | null = null;
  private pendingManualCodeReject: ((reason?: unknown) => void) | null = null;

  async startFlow(
    provider: BrowserOAuthProviderType,
    options?: { accountId?: string; label?: string },
  ): Promise<boolean> {
    if (this.active) {
      await this.stopFlow();
    }

    this.active = true;
    this.activeProvider = provider;
    this.activeAccountId = options?.accountId || provider;
    this.activeLabel = options?.label || null;
    this.emit('oauth:start', { provider, accountId: this.activeAccountId });

    if (provider === 'openai') {
      void this.executeFlow(provider);
      return true;
    }

    await this.executeFlow(provider);
    return true;
  }

  private async executeFlow(provider: BrowserOAuthProviderType): Promise<void> {
    try {
      const token = provider === 'google'
        ? await loginGeminiCliOAuth({
          isRemote: false,
          openUrl: async (url) => {
            await shell.openExternal(url);
          },
          log: (message) => logger.info(`[BrowserOAuth] ${message}`),
          note: async (message, title) => {
            logger.info(`[BrowserOAuth] ${title || 'OAuth note'}: ${message}`);
          },
          prompt: async () => {
            throw new Error('Manual browser OAuth fallback is not implemented in ClawX yet.');
          },
          progress: {
            update: (message) => logger.info(`[BrowserOAuth] ${message}`),
            stop: (message) => {
              if (message) {
                logger.info(`[BrowserOAuth] ${message}`);
              }
            },
          },
        })
        : await loginOpenAICodexOAuth({
          openUrl: async (url) => {
            await shell.openExternal(url);
          },
          onProgress: (message) => logger.info(`[BrowserOAuth] ${message}`),
          onManualCodeRequired: ({ authorizationUrl, reason }) => {
            const message = reason === 'port_in_use'
              ? 'OpenAI OAuth callback port 1455 is in use. Complete sign-in, then paste the final callback URL or code.'
              : 'OpenAI OAuth callback timed out. Paste the final callback URL or code to continue.';
            const payload = {
              provider,
              mode: 'manual' as const,
              authorizationUrl,
              message,
            };
            this.emit('oauth:code', payload);
          },
          onManualCodeInput: async () => {
            return await new Promise<string>((resolve, reject) => {
              this.pendingManualCodeResolve = resolve;
              this.pendingManualCodeReject = reject;
            });
          },
        });

      await this.onSuccess(provider, token);
    } catch (error) {
      if (!this.active) {
        return;
      }
      logger.error(`[BrowserOAuth] Flow error for ${provider}:`, error);
      this.emitError(error instanceof Error ? error.message : String(error));
      this.active = false;
      this.activeProvider = null;
      this.activeAccountId = null;
      this.activeLabel = null;
      this.pendingManualCodeResolve = null;
      this.pendingManualCodeReject = null;
    }
  }

  async stopFlow(): Promise<void> {
    this.active = false;
    this.activeProvider = null;
    this.activeAccountId = null;
    this.activeLabel = null;
    if (this.pendingManualCodeReject) {
      this.pendingManualCodeReject(new Error('OAuth flow cancelled'));
    }
    this.pendingManualCodeResolve = null;
    this.pendingManualCodeReject = null;
    logger.info('[BrowserOAuth] Flow explicitly stopped');
  }

  submitManualCode(code: string): boolean {
    const value = code.trim();
    if (!value || !this.pendingManualCodeResolve) {
      return false;
    }
    this.pendingManualCodeResolve(value);
    this.pendingManualCodeResolve = null;
    this.pendingManualCodeReject = null;
    return true;
  }

  private async onSuccess(
    providerType: BrowserOAuthProviderType,
    token: GeminiCliOAuthCredentials | OpenAICodexOAuthCredentials,
  ) {
    const accountId = this.activeAccountId || providerType;
    const accountLabel = this.activeLabel;
    this.active = false;
    this.activeProvider = null;
    this.activeAccountId = null;
    this.activeLabel = null;
    this.pendingManualCodeResolve = null;
    this.pendingManualCodeReject = null;
    logger.info(`[BrowserOAuth] Successfully completed OAuth for ${providerType}`);

    const isGoogle = providerType === 'google';
    const runtimeProviderId = isGoogle ? GOOGLE_RUNTIME_PROVIDER_ID : OPENAI_RUNTIME_PROVIDER_ID;
    const oauthTokenEmail = typeof token.email === 'string' ? token.email : undefined;
    const oauthTokenSubject = typeof token.projectId === 'string'
      ? token.projectId
      : (typeof token.accountId === 'string' ? token.accountId : undefined);

    await setProviderSecret({
      type: 'oauth',
      accountId,
      accessToken: token.access,
      refreshToken: token.refresh,
      expiresAt: token.expires,
      ...(oauthTokenEmail ? { email: oauthTokenEmail } : {}),
      ...(oauthTokenSubject ? { subject: oauthTokenSubject } : {}),
    });

    const response = await runtimeHostClient.request<{ account?: { id?: unknown } }>(
      'POST',
      '/api/provider-accounts/oauth/complete-browser',
      {
        providerType,
        accountId,
        ...(accountLabel ? { accountLabel } : {}),
        runtimeProviderId,
        token,
      },
    );
    const completedAccountId = typeof response.data?.account?.id === 'string'
      ? response.data.account.id
      : accountId;
    this.emit('oauth:success', { provider: providerType, accountId: completedAccountId });
  }

  private emitError(message: string) {
    this.emit('oauth:error', { message });
  }
}

export const browserOAuthManager = new BrowserOAuthManager();
