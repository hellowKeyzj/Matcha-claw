export interface GatewayResponseError {
  code?: string | number;
  message?: string;
  details?: unknown;
}

export interface GatewayResponseFrame {
  type: 'res';
  id: string;
  ok?: boolean;
  payload?: unknown;
  error?: GatewayResponseError | string | number | null;
}

export interface GatewayEventFrame {
  type: 'event';
  event: string;
  payload?: unknown;
}

export interface GatewayNotification {
  method: string;
  params?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isGatewayResponseFrame(message: unknown): message is GatewayResponseFrame {
  if (!isRecord(message)) {
    return false;
  }
  return message.type === 'res' && typeof message.id === 'string';
}

export function isGatewayEventFrame(message: unknown): message is GatewayEventFrame {
  if (!isRecord(message)) {
    return false;
  }
  return message.type === 'event' && typeof message.event === 'string';
}
