import type { GatewayNotification } from './protocol';

export type GatewayProtocolEventDispatcher = {
  emitNotification: (notification: GatewayNotification) => void;
  emitChatMessage: (payload: { message: unknown }) => void;
  emitChannelStatus: (payload: { channelId: string; status: string }) => void;
};

export function dispatchGatewayProtocolEvent(
  dispatcher: GatewayProtocolEventDispatcher,
  event: string,
  payload: unknown,
): void {
  switch (event) {
    case 'tick':
      break;
    case 'chat':
      dispatcher.emitChatMessage({ message: payload });
      break;
    case 'agent': {
      const input = payload as Record<string, unknown>;
      const data = (input?.data && typeof input.data === 'object')
        ? input.data as Record<string, unknown>
        : {};
      const chatEvent: Record<string, unknown> = {
        ...data,
        runId: input?.runId ?? data.runId,
        sessionKey: input?.sessionKey ?? data.sessionKey,
        state: input?.state ?? data.state,
        message: input?.message ?? data.message,
      };
      if (chatEvent.state || chatEvent.message) {
        dispatcher.emitChatMessage({ message: chatEvent });
      }
      dispatcher.emitNotification({
        method: event,
        params: payload,
      } satisfies GatewayNotification);
      break;
    }
    case 'channel.status':
      dispatcher.emitChannelStatus(payload as { channelId: string; status: string });
      break;
    default:
      dispatcher.emitNotification({
        method: event,
        params: payload,
      } satisfies GatewayNotification);
  }
}
