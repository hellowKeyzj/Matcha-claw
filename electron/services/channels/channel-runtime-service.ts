import { saveChannelConfigLocal } from '../../../runtime-host/application/channels/channel-runtime';
import { whatsAppLoginManager } from './whatsapp-login-manager';
import { weixinLoginManager } from './weixin-login-manager';
type PendingWeixinPersist = Record<string, unknown>;

export interface ChannelRuntimeService {
  readonly startChannelSession: (input: {
    channelType: string;
    accountId?: string;
    config?: Record<string, unknown>;
  }) => Promise<{ queued: true; sessionKey: string }>;
  readonly cancelChannelSession: (channelType: string) => Promise<void>;
}

function normalizeSessionKey(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized || undefined;
}

export function createChannelRuntimeService(
  deps: { scheduleGatewayRestart: (reason: string) => void },
): ChannelRuntimeService {
  const pendingWeixinPersists = new Map<string, PendingWeixinPersist>();
  const pendingWhatsAppAccounts = new Set<string>();
  let weixinPersistHooked = false;
  let whatsAppPersistHooked = false;

  function scheduleGatewayChannelRestart(reason: string): void {
    deps.scheduleGatewayRestart(reason);
  }

  async function commitWeixinConfigAfterLoginSuccess(data: unknown): Promise<void> {
    const payload = (data && typeof data === 'object' ? data : {}) as {
      sessionKey?: unknown;
      requestedAccountId?: unknown;
      accountId?: unknown;
    };

    const bySession = normalizeSessionKey(payload.sessionKey);
    const byRequested = normalizeSessionKey(payload.requestedAccountId);
    const key = bySession ?? byRequested ?? (pendingWeixinPersists.size === 1 ? [...pendingWeixinPersists.keys()][0] : undefined);
    if (!key) {
      return;
    }

    const pending = pendingWeixinPersists.get(key);
    if (!pending) {
      return;
    }
    pendingWeixinPersists.delete(key);

    const resolvedAccountId = normalizeSessionKey(payload.accountId);
    const persistedConfig = {
      ...pending,
      enabled: true,
    };
    await saveChannelConfigLocal({
      channelType: 'openclaw-weixin',
      ...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
      config: persistedConfig,
      enabled: true,
    });
    scheduleGatewayChannelRestart('channel:openclaw-weixin:loginSuccess');
  }

  async function commitWhatsAppConfigAfterLoginSuccess(data: unknown): Promise<void> {
    const payload = (data && typeof data === 'object' ? data : {}) as { accountId?: unknown };
    const accountId = normalizeSessionKey(payload.accountId)
      ?? (pendingWhatsAppAccounts.size === 1 ? [...pendingWhatsAppAccounts][0] : undefined);
    if (!accountId || !pendingWhatsAppAccounts.has(accountId)) {
      return;
    }
    pendingWhatsAppAccounts.delete(accountId);
    await saveChannelConfigLocal({
      channelType: 'whatsapp',
      accountId,
      config: { enabled: true },
      enabled: true,
    });
    scheduleGatewayChannelRestart('channel:whatsapp:loginSuccess');
  }

  function ensureWeixinPersistHooks(): void {
    if (weixinPersistHooked) {
      return;
    }
    weixinPersistHooked = true;

    weixinLoginManager.on('success', (data) => {
      void commitWeixinConfigAfterLoginSuccess(data).catch((error) => {
        console.error('[channels] Failed to persist weixin config after login success:', error);
      });
    });

    weixinLoginManager.on('error', () => {
      pendingWeixinPersists.clear();
    });
  }

  function ensureWhatsAppPersistHooks(): void {
    if (whatsAppPersistHooked) {
      return;
    }
    whatsAppPersistHooked = true;

    whatsAppLoginManager.on('success', (data) => {
      void commitWhatsAppConfigAfterLoginSuccess(data).catch((error) => {
        console.error('[channels] Failed to persist whatsapp config after login success:', error);
      });
    });

    whatsAppLoginManager.on('error', (data) => {
      const payload = (data && typeof data === 'object' ? data : {}) as { accountId?: unknown };
      const accountId = normalizeSessionKey(payload.accountId);
      if (accountId) {
        pendingWhatsAppAccounts.delete(accountId);
      } else {
        pendingWhatsAppAccounts.clear();
      }
    });
  }

  ensureWeixinPersistHooks();
  ensureWhatsAppPersistHooks();

  return {
    async startChannelSession(input: { channelType: string; accountId?: string; config?: Record<string, unknown> }) {
      const accountId = normalizeSessionKey(input.accountId) ?? 'default';
      if (input.channelType === 'whatsapp') {
        pendingWhatsAppAccounts.add(accountId);
        await whatsAppLoginManager.start(accountId);
        return { queued: true as const, sessionKey: accountId };
      }

      if (input.channelType === 'openclaw-weixin') {
        const config: Record<string, unknown> = {
          ...(input.config && typeof input.config === 'object' ? input.config : {}),
          enabled: true,
        };
        pendingWeixinPersists.set(accountId, config);

        const routeTag = typeof config.routeTag === 'string' ? config.routeTag : undefined;
        const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : undefined;
        weixinLoginManager.startInBackground({
          accountId,
          baseUrl,
          routeTag,
        });
        return { queued: true as const, sessionKey: accountId };
      }

      throw new Error(`Unsupported channel session start: ${input.channelType}`);
    },
    async cancelChannelSession(channelType: string) {
      if (channelType === 'whatsapp') {
        pendingWhatsAppAccounts.clear();
        await whatsAppLoginManager.stop();
        return;
      }

      if (channelType === 'openclaw-weixin') {
        await weixinLoginManager.stop();
        pendingWeixinPersists.clear();
        return;
      }

      throw new Error(`Unsupported channel session cancel: ${channelType}`);
    },
  };
}
