import type { StandardEvent } from '../../core/contracts';

export interface OpenClawGatewayNotification {
  method?: string;
  params?: Record<string, unknown>;
}

export function mapGatewayNotificationToStandardEvent(
  notification: OpenClawGatewayNotification,
): StandardEvent {
  const method = notification.method ?? 'gateway.notification';
  const params = notification.params ?? {};
  const runId = typeof params.runId === 'string' ? params.runId : undefined;
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
  return {
    type: `gateway.${method}`,
    ts: Date.now(),
    runId,
    sessionId,
    payload: params,
  };
}
