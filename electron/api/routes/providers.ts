import type { IncomingMessage, ServerResponse } from 'http';
import {
  getProviderConfig,
} from '../../utils/provider-registry';
import { deviceOAuthManager, type OAuthProviderType } from '../../utils/device-oauth';
import { browserOAuthManager, type BrowserOAuthProviderType } from '../../utils/browser-oauth';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  syncDefaultProviderToRuntime,
  syncDeletedProviderApiKeyToRuntime,
  syncDeletedProviderToRuntime,
  syncSavedProviderToRuntime,
  syncUpdatedProviderToRuntime,
} from '../../services/providers/provider-runtime-sync';
import { validateApiKeyWithProvider } from '../../services/providers/provider-validation';
import { getProviderService } from '../../services/providers/provider-service';
import { providerAccountToConfig } from '../../services/providers/provider-store';
import type { ProviderAccount } from '../../shared/providers/types';

function pickFallbackDefaultAccount(accounts: ProviderAccount[]): ProviderAccount | null {
  if (accounts.length === 0) {
    return null;
  }
  const sorted = [...accounts].sort((left, right) => {
    const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
    if (byUpdatedAt !== 0) {
      return byUpdatedAt;
    }
    return left.id.localeCompare(right.id);
  });
  return sorted[0] ?? null;
}

export async function handleProviderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  const providerService = getProviderService();

  const runProviderValidation = async (
    body: { vendorId?: string; accountId?: string; apiKey: string; options?: { baseUrl?: string } },
  ) => {
    const account = body.accountId ? await providerService.getAccount(body.accountId) : null;
    const vendorId = account?.vendorId || body.vendorId;
    if (!vendorId) {
      throw new Error('vendorId or accountId is required');
    }
    const registryBaseUrl = getProviderConfig(vendorId)?.baseUrl;
    const resolvedBaseUrl = body.options?.baseUrl || account?.baseUrl || registryBaseUrl;
    return validateApiKeyWithProvider(vendorId, body.apiKey, { baseUrl: resolvedBaseUrl });
  };

  const startProviderOAuthFlow = async (body: {
    provider: OAuthProviderType | BrowserOAuthProviderType;
    region?: 'global' | 'cn';
    accountId?: string;
    label?: string;
  }) => {
    if (body.provider === 'google' || body.provider === 'openai') {
      await browserOAuthManager.startFlow(body.provider, {
        accountId: body.accountId,
        label: body.label,
      });
      return;
    }

    await deviceOAuthManager.startFlow(body.provider, body.region, {
      accountId: body.accountId,
      label: body.label,
    });
  };

  if (url.pathname === '/api/provider-vendors' && req.method === 'GET') {
    sendJson(res, 200, await providerService.listVendors());
    return true;
  }

  if (url.pathname === '/api/provider-accounts' && req.method === 'GET') {
    sendJson(res, 200, await providerService.listAccounts());
    return true;
  }

  if (url.pathname === '/api/provider-accounts' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ account: ProviderAccount; apiKey?: string }>(req);
      const account = await providerService.createAccount(body.account, body.apiKey);
      await syncSavedProviderToRuntime(providerAccountToConfig(account), body.apiKey, ctx.gatewayManager);
      sendJson(res, 200, { success: true, account });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/provider-accounts/status' && req.method === 'GET') {
    sendJson(res, 200, await providerService.listAccountStatuses());
    return true;
  }

  if (url.pathname === '/api/provider-accounts/default' && req.method === 'GET') {
    sendJson(res, 200, { accountId: await providerService.getDefaultAccountId() ?? null });
    return true;
  }

  if (url.pathname === '/api/provider-accounts/default' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{ accountId: string }>(req);
      await providerService.setDefaultAccount(body.accountId);
      await syncDefaultProviderToRuntime(body.accountId, ctx.gatewayManager);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/provider-accounts/validate' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ vendorId?: string; accountId?: string; apiKey: string; options?: { baseUrl?: string } }>(req);
      sendJson(res, 200, await runProviderValidation(body));
    } catch (error) {
      sendJson(res, 500, { valid: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/provider-accounts/oauth/start' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        provider: OAuthProviderType | BrowserOAuthProviderType;
        region?: 'global' | 'cn';
        accountId?: string;
        label?: string;
      }>(req);
      await startProviderOAuthFlow(body);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/provider-accounts/oauth/cancel' && req.method === 'POST') {
    try {
      await deviceOAuthManager.stopFlow();
      await browserOAuthManager.stopFlow();
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/provider-accounts/oauth/submit' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ code: string }>(req);
      const accepted = browserOAuthManager.submitManualCode(body.code || '');
      if (!accepted) {
        sendJson(res, 400, { success: false, error: 'No active manual OAuth input pending' });
        return true;
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const accountApiKeyMatch = url.pathname.match(/^\/api\/provider-accounts\/([^/]+)\/api-key$/);
  if (accountApiKeyMatch && req.method === 'GET') {
    const accountId = decodeURIComponent(accountApiKeyMatch[1]);
    sendJson(res, 200, { apiKey: await providerService.getAccountApiKey(accountId) });
    return true;
  }

  const accountHasApiKeyMatch = url.pathname.match(/^\/api\/provider-accounts\/([^/]+)\/has-api-key$/);
  if (accountHasApiKeyMatch && req.method === 'GET') {
    const accountId = decodeURIComponent(accountHasApiKeyMatch[1]);
    sendJson(res, 200, { hasKey: await providerService.hasAccountApiKey(accountId) });
    return true;
  }

  const accountMatch = url.pathname.match(/^\/api\/provider-accounts\/([^/]+)$/);
  if (accountMatch && req.method === 'GET') {
    const accountId = decodeURIComponent(accountMatch[1]);
    sendJson(res, 200, await providerService.getAccount(accountId));
    return true;
  }

  if (accountMatch && req.method === 'PUT') {
    const accountId = decodeURIComponent(accountMatch[1]);
    try {
      const body = await parseJsonBody<{ updates: Partial<ProviderAccount>; apiKey?: string }>(req);
      const existing = await providerService.getAccount(accountId);
      if (!existing) {
        sendJson(res, 404, { success: false, error: 'Provider account not found' });
        return true;
      }
      const nextAccount = await providerService.updateAccount(accountId, body.updates, body.apiKey);
      await syncUpdatedProviderToRuntime(providerAccountToConfig(nextAccount), body.apiKey, ctx.gatewayManager);
      sendJson(res, 200, { success: true, account: nextAccount });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (accountMatch && req.method === 'DELETE') {
    const accountId = decodeURIComponent(accountMatch[1]);
    try {
      const existing = await providerService.getAccount(accountId);
      const defaultAccountIdBeforeDelete = await providerService.getDefaultAccountId();
      const runtimeProviderKey = existing?.authMode === 'oauth_browser'
        ? (existing.vendorId === 'google'
          ? 'google-gemini-cli'
          : (existing.vendorId === 'openai' ? 'openai-codex' : undefined))
        : undefined;
      if (url.searchParams.get('apiKeyOnly') === '1') {
        await providerService.deleteAccountApiKey(accountId);
        await syncDeletedProviderApiKeyToRuntime(
          existing ? providerAccountToConfig(existing) : null,
          accountId,
          runtimeProviderKey,
        );
        sendJson(res, 200, { success: true });
        return true;
      }
      await providerService.deleteAccount(accountId);
      await syncDeletedProviderToRuntime(
        existing ? providerAccountToConfig(existing) : null,
        accountId,
        ctx.gatewayManager,
        runtimeProviderKey,
      );

      if (defaultAccountIdBeforeDelete === accountId) {
        const remainingAccounts = await providerService.listAccounts();
        const fallbackDefault = pickFallbackDefaultAccount(remainingAccounts);
        if (fallbackDefault) {
          await providerService.setDefaultAccount(fallbackDefault.id);
          await syncDefaultProviderToRuntime(fallbackDefault.id, ctx.gatewayManager);
        }
      }

      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
