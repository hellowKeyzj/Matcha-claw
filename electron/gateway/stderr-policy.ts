export type GatewayStderrLevel = 'drop' | 'debug' | 'warn';

export interface GatewayStderrClassification {
  level: GatewayStderrLevel;
  normalized: string;
}

export function classifyGatewayStderrMessage(message: string): GatewayStderrClassification {
  const msg = message.trim();
  if (!msg) return { level: 'drop', normalized: msg };

  // Known noisy lines that are not actionable for Gateway lifecycle debugging.
  if (msg.includes('openclaw-control-ui') && msg.includes('token_mismatch')) {
    return { level: 'drop', normalized: msg };
  }
  if (msg.includes('closed before connect') && msg.includes('token mismatch')) {
    return { level: 'drop', normalized: msg };
  }

  // Downgrade frequent non-fatal noise.
  if (msg.includes('ExperimentalWarning')) return { level: 'debug', normalized: msg };
  if (msg.includes('DeprecationWarning')) return { level: 'debug', normalized: msg };
  if (msg.includes('Debugger attached')) return { level: 'debug', normalized: msg };
  // Electron restricts NODE_OPTIONS in packaged apps; this is expected and harmless.
  if (msg.includes('NODE_OPTIONs are not supported in packaged apps')) return { level: 'debug', normalized: msg };
  // A brief pre-connect close with code 1005 can happen during concurrent reconnect/startup churn.
  if (msg.includes('[ws] closed before connect') && msg.includes('code=1005')) {
    return { level: 'debug', normalized: msg };
  }

  return { level: 'warn', normalized: msg };
}
