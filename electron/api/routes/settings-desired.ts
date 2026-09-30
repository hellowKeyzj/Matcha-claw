import type { IncomingMessage, ServerResponse } from 'http';
import { isCallId } from '../../../src/types/call-log/decode';
import {
  normalizeSettingsProxyServer,
  type SettingsDesiredRequest,
  type SettingsDesiredTransport,
} from '../../main/runtime-host-delivery/products/settings/desired';
import { parseJsonBody, sendJson } from '../route-utils';

const INVALID = {
  success: false,
  error: 'Settings desired request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Settings desired is unavailable',
} as const;

export async function handleSettingsDesiredRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: SettingsDesiredTransport,
): Promise<boolean> {
  const projection = url.pathname === '/api/settings/desired/projection';
  if ((!projection && url.pathname !== '/api/settings/desired') || req.method !== 'POST') return false;

  let body: unknown;
  try {
    body = await parseJsonBody(req);
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (projection) {
    if (!isRecord(body) || !hasExactKeys(body, ['callId']) || !isCallId(body.callId)) {
      sendJson(res, 400, INVALID);
      return true;
    }
    const response = await transport.project(body.callId);
    sendJson(res, response.status, response.body);
    return true;
  }
  const request = normalizeRequest(body);
  if (!request) {
    sendJson(res, 400, INVALID);
    return true;
  }
  try {
    const response = await transport.submit(request);
    sendJson(res, response.status, response.body);
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}

function normalizeRequest(value: unknown): SettingsDesiredRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'browserMode',
    'launchAtStartup',
    'gatewayAutoStart',
    'proxyEnabled',
    'proxyServer',
    'proxyBypassRules',
  ])) return null;
  const browserMode = value.browserMode;
  const launchAtStartup = value.launchAtStartup;
  const gatewayAutoStart = value.gatewayAutoStart;
  const proxyEnabled = value.proxyEnabled;
  const proxyServer = value.proxyServer;
  const proxyBypassRules = value.proxyBypassRules;
  if (!isBrowserMode(browserMode)
    || typeof launchAtStartup !== 'boolean'
    || typeof gatewayAutoStart !== 'boolean'
    || typeof proxyEnabled !== 'boolean'
    || !isText(proxyBypassRules, 4096)) return null;
  const server = normalizeSettingsProxyServer(proxyServer, proxyEnabled);
  if (server === null) return null;
  return {
    id: 'settings.desired',
    operationId: 'settings.replace',
    scope: { kind: 'settings-desired' },
    target: { kind: 'settings' },
    input: {
      browserMode,
      launchAtStartup,
      gatewayAutoStart,
      proxy: {
        enabled: proxyEnabled,
        server,
        bypassRules: proxyBypassRules,
        credentialReference: null,
      },
    },
  };
}

function isBrowserMode(value: unknown): value is SettingsDesiredRequest['input']['browserMode'] {
  return value === 'native' || value === 'relay' || value === 'off';
}

function isText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !value.includes('\0') && !/[\r\n]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
