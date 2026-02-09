/**
 * Proxy Utilities
 * Applies proxy settings for the main process (Electron session)
 * and synchronizes environment variables for Node-based requests.
 */
import { session } from 'electron';
import { getSetting } from '../utils/store';

type ProxySettings = {
  enabled: boolean;
  http?: string;
  https?: string;
  all?: string;
};

function normalizeProxyRule(value: string): { scheme?: string; hostPort: string } {
  if (!value.includes('://')) {
    return { hostPort: value };
  }
  try {
    const url = new URL(value);
    const hostPort = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    const scheme = url.protocol.replace(':', '');
    return { scheme, hostPort };
  } catch {
    return { hostPort: value };
  }
}

function buildProxyRules(settings: ProxySettings): string | null {
  if (!settings.enabled) return null;

  const allProxy = settings.all?.trim();
  if (allProxy) {
    const normalized = normalizeProxyRule(allProxy);
    const scheme = normalized.scheme || 'socks5';
    return `${scheme}=${normalized.hostPort}`;
  }

  const rules: string[] = [];
  const httpProxy = settings.http?.trim();
  const httpsProxy = settings.https?.trim();

  if (httpProxy) {
    const normalized = normalizeProxyRule(httpProxy);
    rules.push(`http=${normalized.hostPort}`);
  }
  if (httpsProxy) {
    const normalized = normalizeProxyRule(httpsProxy);
    rules.push(`https=${normalized.hostPort}`);
  }

  return rules.length > 0 ? rules.join(';') : null;
}

function syncEnv(settings: ProxySettings): void {
  const httpProxy = settings.http?.trim() || '';
  const httpsProxy = settings.https?.trim() || '';
  const allProxy = settings.all?.trim() || '';

  if (settings.enabled) {
    if (httpProxy) {
      process.env.HTTP_PROXY = httpProxy;
      process.env.http_proxy = httpProxy;
    }
    if (httpsProxy) {
      process.env.HTTPS_PROXY = httpsProxy;
      process.env.https_proxy = httpsProxy;
    }
    if (allProxy) {
      process.env.ALL_PROXY = allProxy;
      process.env.all_proxy = allProxy;
    }
  } else {
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
  }
}

export async function applyProxyFromSettings(): Promise<void> {
  const settings: ProxySettings = {
    enabled: Boolean(await getSetting('gatewayProxyEnabled')),
    http: await getSetting('gatewayProxyHttp'),
    https: await getSetting('gatewayProxyHttps'),
    all: await getSetting('gatewayProxyAll'),
  };

  syncEnv(settings);

  const rules = buildProxyRules(settings);
  if (rules) {
    await session.defaultSession.setProxy({ proxyRules: rules });
  } else {
    await session.defaultSession.setProxy({ mode: 'direct' });
  }
}

