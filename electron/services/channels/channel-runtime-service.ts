import { createDefaultRuntimeHostHttpClient } from '../../main/runtime-host-client';
import { whatsAppLoginManager } from './whatsapp-login-manager';
import { weixinLoginManager } from './weixin-login-manager';
type PendingWeixinPersist = Record<string, unknown>;

export interface ChannelRuntimeService {
  readonly startWhatsApp: (accountId: string) => Promise<void>;
  readonly cancelWhatsApp: () => Promise<void>;
  readonly startOpenClawWeixin: (input: {
    accountId?: string;
    config?: Record<string, unknown>;
  }) => Promise<{ queued: true; sessionKey: string }>;
  readonly cancelOpenClawWeixin: () => Promise<void>;
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
  const runtimeHostClient = createDefaultRuntimeHostHttpClient({
    timeoutMs: 8000,
  });
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
    await runtimeHostClient.request('POST', '/api/channels/config', {
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
    await runtimeHostClient.request('POST', '/api/channels/config', {
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
    async startWhatsApp(accountId: string) {
      pendingWhatsAppAccounts.add(accountId);
      await whatsAppLoginManager.start(accountId);
    },
    async cancelWhatsApp() {
      pendingWhatsAppAccounts.clear();
      await whatsAppLoginManager.stop();
    },
    async startOpenClawWeixin(input: { accountId?: string; config?: Record<string, unknown> }) {
      const sessionKey = normalizeSessionKey(input.accountId) ?? 'default';
      const config: Record<string, unknown> = {
        ...(input.config && typeof input.config === 'object' ? input.config : {}),
        enabled: true,
      };
      pendingWeixinPersists.set(sessionKey, config);

      const routeTag = typeof config.routeTag === 'string' ? config.routeTag : undefined;
      const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : undefined;
      weixinLoginManager.startInBackground({
        accountId: sessionKey,
        baseUrl,
        routeTag,
      });
      return { queued: true as const, sessionKey };
    },
    async cancelOpenClawWeixin() {
      await weixinLoginManager.stop();
      pendingWeixinPersists.clear();
    },
  };
}
