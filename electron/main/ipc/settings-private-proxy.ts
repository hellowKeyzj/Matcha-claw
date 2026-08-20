import { ipcMain } from 'electron';

const MAX_INPUT_BYTES = 2048;
const MAX_BYPASS_BYTES = 4096;

type ProxyIntent = Readonly<{
  enabled: boolean;
  server: string;
  bypassRules: string;
}>;

export type SanitizedProxyIntent = Readonly<{
  enabled: boolean;
  server: string;
  bypassRules: string;
  credentialReference: null;
}>;

export function registerSettingsPrivateProxyHandlers(): void {
  ipcMain.handle('settings:splitProxyIntent', async (_, input: ProxyIntent) => {
    return await splitSettingsProxyIntent(input);
  });
}

export async function splitSettingsProxyIntent(input: ProxyIntent): Promise<SanitizedProxyIntent> {
  if (!isText(input.server, MAX_INPUT_BYTES) || !isText(input.bypassRules, MAX_BYPASS_BYTES)) {
    throw new Error('Settings proxy request is invalid');
  }
  if (!input.enabled) {
    return { enabled: false, server: '', bypassRules: input.bypassRules, credentialReference: null };
  }
  const raw = input.server.trim();
  if (!raw) throw new Error('Settings proxy request is invalid');
  const url = parseProxyEndpoint(raw);
  if (url.username || url.password) {
    throw new Error('Settings proxy credentials are not supported');
  }
  return {
    enabled: true,
    server: url.toString().replace(/\/$/, ''),
    bypassRules: input.bypassRules,
    credentialReference: null,
  };
}

function parseProxyEndpoint(value: string): URL {
  try {
    const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    const url = new URL(normalized);
    if (!url.hostname || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url;
  } catch {
    throw new Error('Settings proxy request is invalid');
  }
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && !value.includes('\0') && !/[\r\n]/.test(value);
}

