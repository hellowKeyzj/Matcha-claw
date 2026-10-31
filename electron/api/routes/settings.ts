import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';
import type {
  SettingsDesiredTransport,
  SettingsPublicSnapshot,
} from '../../main/runtime-host-delivery/products/settings/desired';

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
  req: HostApiRequest,
  url: URL,
  transport: SettingsDesiredTransport,
): Promise<HostApiRouteResult> {
  if (req.method !== 'GET') return undefined;
  if (url.pathname === '/api/settings') {
    try {
      const snapshot = await transport.read();
      return jsonResult(snapshot ? 200 : 503, snapshot ?? UNAVAILABLE);
    } catch {
      return jsonResult(503, UNAVAILABLE);
    }
  }
  const prefix = '/api/settings/';
  if (!url.pathname.startsWith(prefix)) return undefined;
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return jsonResult(400, INVALID);
  }
  if (!key) {
    return jsonResult(400, INVALID);
  }
  try {
    const snapshot = await transport.read();
    if (!snapshot) {
      return jsonResult(503, UNAVAILABLE);
    }
    if (!PUBLIC_KEYS.has(key as keyof SettingsPublicSnapshot)) {
      return jsonResult(200, {});
    }
    return jsonResult(200, { value: snapshot[key as keyof SettingsPublicSnapshot] });
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}
