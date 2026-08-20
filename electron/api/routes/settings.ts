import type { IncomingMessage, ServerResponse } from 'http';
import type {
  SettingsDesiredTransport,
  SettingsPublicSnapshot,
} from '../../main/runtime-host-delivery/products/settings/desired';
import { sendJson } from '../route-utils';

const UNAVAILABLE = {
  success: false,
  error: 'Settings are unavailable',
} as const;
const INVALID = {
  success: false,
  error: 'Settings key is invalid',
} as const;

const PUBLIC_KEYS = new Set<keyof SettingsPublicSnapshot>([
  'browserMode',
  'launchAtStartup',
  'gatewayAutoStart',
  'proxyEnabled',
  'proxyServer',
  'proxyBypassRules',
]);

export async function handleSettingsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  transport: SettingsDesiredTransport,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/api/settings') {
    try {
      const snapshot = await transport.read();
      sendJson(res, snapshot ? 200 : 503, snapshot ?? UNAVAILABLE);
    } catch {
      sendJson(res, 503, UNAVAILABLE);
    }
    return true;
  }
  const prefix = '/api/settings/';
  if (!url.pathname.startsWith(prefix)) return false;
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    sendJson(res, 400, INVALID);
    return true;
  }
  if (!key) {
    sendJson(res, 400, INVALID);
    return true;
  }
  try {
    const snapshot = await transport.read();
    if (!snapshot) {
      sendJson(res, 503, UNAVAILABLE);
      return true;
    }
    if (!PUBLIC_KEYS.has(key as keyof SettingsPublicSnapshot)) {
      sendJson(res, 200, {});
      return true;
    }
    sendJson(res, 200, { value: snapshot[key as keyof SettingsPublicSnapshot] });
  } catch {
    sendJson(res, 503, UNAVAILABLE);
  }
  return true;
}
