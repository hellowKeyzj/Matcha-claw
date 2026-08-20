import type { IncomingMessage, ServerResponse } from 'http';
import type {
  ProviderCredentialStatusResponse,
  ProviderCredentialStatusTransport,
} from '../../main/ipc/provider-private-auth';
import type {
  ProviderAccountsListRequest,
  ProviderAccountsTransport,
} from '../../main/runtime-host-delivery/transport/providers/accounts';
import { isProviderAccountIdentifier } from '../../main/runtime-host-delivery/transport/providers/accounts';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Provider account request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Provider accounts are unavailable',
} as const;

const LIST_REQUEST: ProviderAccountsListRequest = Object.freeze({
  id: 'provider.accounts',
  operationId: 'providerAccounts.list',
  scope: { kind: 'provider-account-catalog' },
  target: { kind: 'provider-accounts' },
  input: { kind: 'list' },
});

function isHasApiKeyResponse(value: unknown): value is ProviderCredentialStatusResponse {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && Object.hasOwn(value, 'hasKey')
    && typeof value.hasKey === 'boolean';
}

export async function handleProviderAccountsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: ProviderAccountsTransport,
  statusTransport: ProviderCredentialStatusTransport,
): Promise<boolean> {
  if (url.pathname === '/api/provider-accounts' && req.method === 'GET') {
    try {
      const response = await transport.execute(LIST_REQUEST);
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNAVAILABLE);
    }
    return true;
  }

  if (url.pathname === '/api/provider-accounts' && req.method === 'POST') {
    let body: unknown;
    try {
      body = await parseJsonBody(req);
    } catch {
      sendJson(res, 400, INVALID);
      return true;
    }
    try {
      const response = await transport.execute(body);
      sendJson(res, response.status, response.body);
    } catch {
      sendJson(res, 503, UNAVAILABLE);
    }
    return true;
  }

  const hasApiKeyMatch = url.pathname.match(/^\/api\/provider-accounts\/([^/]+)\/has-api-key$/);
  if (hasApiKeyMatch && req.method === 'GET') {
    let accountId: string;
    try {
      accountId = decodeURIComponent(hasApiKeyMatch[1]);
    } catch {
      sendJson(res, 400, INVALID);
      return true;
    }
    if (!isProviderAccountIdentifier(accountId)) {
      sendJson(res, 400, INVALID);
      return true;
    }
    try {
      const response = await statusTransport.hasApiKey(accountId);
      if (!isHasApiKeyResponse(response)) {
        sendJson(res, 503, UNAVAILABLE);
      } else {
        sendJson(res, 200, response);
      }
    } catch {
      sendJson(res, 503, UNAVAILABLE);
    }
    return true;
  }

  return false;
}
