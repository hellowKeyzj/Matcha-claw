export const REMOTE_FLEET_CUSTOM_TERMINAL_PROVIDER_KIND = 'custom' as const;
export const REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION = 'remote-fleet-terminal/v1' as const;
export const REMOTE_FLEET_CUSTOM_TERMINAL_ATTACH_OPERATION_ID = 'remoteFleet.terminal.attach' as const;

export interface RemoteFleetCustomTerminalConfig {
  readonly transport: 'websocket';
  readonly endpointUrl: string;
  readonly protocolVersion: typeof REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION;
  readonly credentialRefName?: string;
}

export type RemoteFleetCustomTerminalConfigReadResult =
  | { readonly resultType: 'valid'; readonly config: RemoteFleetCustomTerminalConfig }
  | { readonly resultType: 'invalid'; readonly message: string };

export function readRemoteFleetCustomTerminalConfig(
  publicConfig: Readonly<Record<string, unknown>>,
): RemoteFleetCustomTerminalConfigReadResult {
  const customConfig = readRecord(publicConfig.custom);
  const terminalConfig = customConfig ? readRecord(customConfig.terminal) : undefined;
  if (!terminalConfig) {
    return { resultType: 'invalid', message: 'Remote Fleet custom terminal requires publicConfig.custom.terminal.' };
  }

  if (terminalConfig.transport !== 'websocket') {
    return { resultType: 'invalid', message: 'Remote Fleet custom terminal transport must be websocket.' };
  }
  if (terminalConfig.protocolVersion !== REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION) {
    return { resultType: 'invalid', message: `Remote Fleet custom terminal protocolVersion must be ${REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION}.` };
  }

  const endpointUrlResult = readCustomTerminalEndpointUrl(terminalConfig.endpointUrl);
  if (endpointUrlResult.resultType === 'invalid') return endpointUrlResult;

  const credentialRefNameResult = readOptionalCredentialRefName(terminalConfig.credentialRefName);
  if (credentialRefNameResult.resultType === 'invalid') return credentialRefNameResult;

  return {
    resultType: 'valid',
    config: {
      transport: 'websocket',
      endpointUrl: endpointUrlResult.endpointUrl,
      protocolVersion: REMOTE_FLEET_CUSTOM_TERMINAL_PROTOCOL_VERSION,
      ...(credentialRefNameResult.credentialRefName ? { credentialRefName: credentialRefNameResult.credentialRefName } : {}),
    },
  };
}

function readCustomTerminalEndpointUrl(value: unknown):
  | { readonly resultType: 'valid'; readonly endpointUrl: string }
  | { readonly resultType: 'invalid'; readonly message: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { resultType: 'invalid', message: 'Remote Fleet custom terminal endpointUrl is required.' };
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
      return { resultType: 'invalid', message: 'Remote Fleet custom terminal endpointUrl must use ws or wss.' };
    }
    if (url.protocol === 'ws:' && !isLoopbackHost(url.hostname)) {
      return { resultType: 'invalid', message: 'Remote Fleet custom terminal endpointUrl must use wss unless it targets localhost.' };
    }
    if (url.username || url.password || url.search || url.hash) {
      return { resultType: 'invalid', message: 'Remote Fleet custom terminal endpointUrl must not include credentials, query, or fragment data.' };
    }
    return { resultType: 'valid', endpointUrl: url.toString() };
  } catch {
    return { resultType: 'invalid', message: 'Remote Fleet custom terminal endpointUrl must be a valid URL.' };
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function readOptionalCredentialRefName(value: unknown):
  | { readonly resultType: 'valid'; readonly credentialRefName?: string }
  | { readonly resultType: 'invalid'; readonly message: string } {
  if (value === undefined) return { resultType: 'valid' };
  if (typeof value !== 'string') {
    return { resultType: 'invalid', message: 'Remote Fleet custom terminal credentialRefName must be a string.' };
  }

  const credentialRefName = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(credentialRefName)) {
    return { resultType: 'invalid', message: 'Remote Fleet custom terminal credentialRefName must be 1-64 safe name characters.' };
  }
  return { resultType: 'valid', credentialRefName };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}
