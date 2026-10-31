import type {
  ProviderCredentialStatusResponse,
  ProviderCredentialStatusTransport,
} from '../../main/providers/private-auth';
import type {
  ProviderAccountsListRequest,
  ProviderAccountsTransport,
} from '../../main/runtime-host-delivery/transport/providers/accounts';
import { isProviderAccountIdentifier } from '../../main/runtime-host-delivery/transport/providers/accounts';
import { isRecord } from '../../main/runtime-host-delivery/transport/client';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = {
  success: false,
  error: 'Provider account request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Provider accounts are unavailable',
} as const;

const LIST_REQUEST = Object.freeze<ProviderAccountsListRequest>({
  id: 'provider.accounts',
  operationId: 'providerAccounts.list',
  scope: { kind: 'provider-account-catalog' },
  target: { kind: 'provider-accounts' },
  input: { kind: 'list' },
});

function isHasApiKeyResponse(value: unknown): value is ProviderCredentialStatusResponse {
  return isRecord(value)
    && Object.keys(value).length === 1
    && Object.hasOwn(value, 'hasKey')
    && typeof value.hasKey === 'boolean';
}

export async function handleProviderAccountsRoutes(
  req: HostApiRequest,
  url: URL,
  transport: ProviderAccountsTransport,
  statusTransport: ProviderCredentialStatusTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname === '/api/provider-accounts' && req.method === 'GET') {
    try {
      const response = await transport.execute(LIST_REQUEST);
      return jsonResult(response.status, response.body);
    } catch {
      return jsonResult(503, UNAVAILABLE);
    }
  }

  const hasApiKeyMatch = url.pathname.match(/^\/api\/provider-accounts\/([^/]+)\/has-api-key$/);
  if (hasApiKeyMatch && req.method === 'GET') {
    let accountId: string;
    try {
      accountId = decodeURIComponent(hasApiKeyMatch[1]);
    } catch {
      return jsonResult(400, INVALID);
    }
    if (!isProviderAccountIdentifier(accountId)) {
      return jsonResult(400, INVALID);
    }
    try {
      const response = await statusTransport.hasApiKey(accountId);
      if (!isHasApiKeyResponse(response)) {
        return jsonResult(503, UNAVAILABLE);
      } else {
        return jsonResult(200, response);
      }
    } catch {
      return jsonResult(503, UNAVAILABLE);
    }
  }

  return undefined;
}
