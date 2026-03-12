import { describe, expect, it } from 'vitest';
import {
  buildElectronProxyConfig,
  buildProxyEnv,
  normalizeProxyServer,
  resolveProxySettings,
} from '@electron/utils/proxy';

describe('proxy helpers', () => {
  it('normalizes bare host:port values to http URLs', () => {
    expect(normalizeProxyServer('127.0.0.1:7890')).toBe('http://127.0.0.1:7890');
  });

  it('preserves explicit proxy schemes', () => {
    expect(normalizeProxyServer('socks5://127.0.0.1:7891')).toBe('socks5://127.0.0.1:7891');
  });

  it('resolves a single proxy server to all protocols', () => {
    expect(resolveProxySettings({
      proxyEnabled: true,
      proxyServer: '127.0.0.1:7890',
      proxyBypassRules: '<local>',
    })).toEqual({
      httpProxy: 'http://127.0.0.1:7890',
      httpsProxy: 'http://127.0.0.1:7890',
      allProxy: 'http://127.0.0.1:7890',
      bypassRules: '<local>',
    });
  });

  it('keeps a SOCKS proxy scheme as-is', () => {
    expect(resolveProxySettings({
      proxyEnabled: true,
      proxyServer: 'socks5://127.0.0.1:7891',
      proxyBypassRules: '',
    })).toEqual({
      httpProxy: 'socks5://127.0.0.1:7891',
      httpsProxy: 'socks5://127.0.0.1:7891',
      allProxy: 'socks5://127.0.0.1:7891',
      bypassRules: '',
    });
  });

  it('builds a direct Electron config when proxy is disabled', () => {
    expect(buildElectronProxyConfig({
      proxyEnabled: false,
      proxyServer: '127.0.0.1:7890',
      proxyBypassRules: '<local>',
    })).toEqual({ mode: 'direct' });
  });

  it('builds Electron proxy rules when proxy is enabled', () => {
    expect(buildElectronProxyConfig({
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>;localhost',
    })).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'http=http://127.0.0.1:7890;https=http://127.0.0.1:7890;http://127.0.0.1:7890',
      proxyBypassRules: '<local>;localhost',
    });
  });

  it('builds upper and lower-case proxy env vars for the Gateway', () => {
    expect(buildProxyEnv({
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>;localhost\n127.0.0.1',
    })).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      ALL_PROXY: 'http://127.0.0.1:7890',
      http_proxy: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
      all_proxy: 'http://127.0.0.1:7890',
      NO_PROXY: '<local>,localhost,127.0.0.1',
      no_proxy: '<local>,localhost,127.0.0.1',
    });
  });
});
