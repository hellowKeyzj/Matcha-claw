import type { ParentShellAction, ParentTransportUpstreamPayload } from '../dispatch/parent-transport';
import { ProviderAccountsService } from '../../application/providers/accounts';

interface LocalDispatchResponse {
  status: number;
  data: unknown;
}

interface ProviderStore {
  defaultAccountId: string | null;
  accounts: Record<string, any>;
  apiKeys: Record<string, string>;
}

interface ProviderRouteDeps {
  readProviderStoreLocal: () => Promise<ProviderStore>;
  writeProviderStoreLocal: (store: ProviderStore) => Promise<void>;
  sortProviderAccountsLocal: (accounts: any[], defaultAccountId: string | null) => any[];
  accountToStatusLocal: (account: any, apiKey: string | undefined) => any;
  normalizeProviderAccountLocal: (input: any, current?: any) => any;
  normalizeProviderFallbackAccountLocal: (accounts: any[], deletedId: string) => string | null;
  validateProviderApiKeyLocal: (input: unknown) => unknown;
  requestParentShellAction: (action: ParentShellAction, payload?: unknown) => Promise<ParentTransportUpstreamPayload>;
  mapParentTransportResponse: (upstream: ParentTransportUpstreamPayload) => LocalDispatchResponse;
  providerVendorDefinitions: unknown;
  completeBrowserOAuthLocal: (input: {
    providerType: 'google' | 'openai';
    accountId: string;
    accountLabel?: string | null;
    runtimeProviderId: string;
    token: {
      access: string;
      refresh: string;
      expires: number;
      email?: string;
      projectId?: string;
      accountId?: string;
    };
  }) => Promise<unknown>;
  completeDeviceOAuthLocal: (input: {
    providerType: 'minimax-portal' | 'minimax-portal-cn' | 'qwen-portal';
    accountId: string;
    accountLabel?: string | null;
    token: {
      access: string;
      refresh: string;
      expires: number;
      resourceUrl?: string;
      api: 'anthropic-messages' | 'openai-completions';
    };
  }) => Promise<unknown>;
}

export async function handleProviderRoute(
  method: string,
  routePath: string,
  routeUrl: URL,
  payload: unknown,
  deps: ProviderRouteDeps,
): Promise<LocalDispatchResponse | null> {
  if (!routePath.startsWith('/api/provider-accounts')) {
    return null;
  }

  const service = new ProviderAccountsService({
    readProviderStore: deps.readProviderStoreLocal,
    writeProviderStore: deps.writeProviderStoreLocal,
    sortAccounts: deps.sortProviderAccountsLocal,
    accountToStatus: deps.accountToStatusLocal,
    normalizeAccount: deps.normalizeProviderAccountLocal,
    normalizeFallbackAccount: deps.normalizeProviderFallbackAccountLocal,
    validateApiKey: deps.validateProviderApiKeyLocal,
    requestParentShellAction: deps.requestParentShellAction,
    mapParentTransportResponse: deps.mapParentTransportResponse,
    providerVendorDefinitions: deps.providerVendorDefinitions,
    completeBrowserOAuth: deps.completeBrowserOAuthLocal,
    completeDeviceOAuth: deps.completeDeviceOAuthLocal,
  });

  const accountApiKeyMatch = routePath.match(/^\/api\/provider-accounts\/([^/]+)\/api-key$/);
  const accountHasApiKeyMatch = routePath.match(/^\/api\/provider-accounts\/([^/]+)\/has-api-key$/);
  const accountMatch = routePath.match(/^\/api\/provider-accounts\/([^/]+)$/);

  if (method === 'GET' && routePath === '/api/provider-accounts') {
    return {
      status: 200,
      data: await service.list(),
    };
  }

  if (method === 'POST' && routePath === '/api/provider-accounts') {
    try {
      return await service.create(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'PUT' && routePath === '/api/provider-accounts/default') {
    try {
      return await service.setDefault(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/provider-accounts/validate') {
    return {
      status: 200,
      data: service.validate(payload),
    };
  }

  if (method === 'POST' && routePath === '/api/provider-accounts/oauth/start') {
    try {
      return await service.startOAuth(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/provider-accounts/oauth/cancel') {
    try {
      return await service.cancelOAuth();
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/provider-accounts/oauth/submit') {
    try {
      return await service.submitOAuth(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/provider-accounts/oauth/complete-browser') {
    try {
      return await service.completeBrowser(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'POST' && routePath === '/api/provider-accounts/oauth/complete-device') {
    try {
      return await service.completeDevice(payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'GET' && accountApiKeyMatch) {
    const accountId = decodeURIComponent(accountApiKeyMatch[1]);
    return {
      status: 200,
      data: await service.getApiKey(accountId),
    };
  }

  if (method === 'GET' && accountHasApiKeyMatch) {
    const accountId = decodeURIComponent(accountHasApiKeyMatch[1]);
    return {
      status: 200,
      data: await service.hasApiKey(accountId),
    };
  }

  if (method === 'GET' && accountMatch) {
    const accountId = decodeURIComponent(accountMatch[1]);
    return {
      status: 200,
      data: await service.get(accountId),
    };
  }

  if (method === 'PUT' && accountMatch) {
    try {
      const accountId = decodeURIComponent(accountMatch[1]);
      return await service.update(accountId, payload);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  if (method === 'DELETE' && accountMatch) {
    try {
      const accountId = decodeURIComponent(accountMatch[1]);
      const apiKeyOnly = routeUrl.searchParams.get('apiKeyOnly') === '1';
      return await service.delete(accountId, apiKeyOnly);
    } catch (error) {
      return {
        status: 500,
        data: { success: false, error: String(error) },
      };
    }
  }

  return null;
}
