import { subscribeHostEvent } from '@/lib/host-events';
import {
  normalizeGatewayConversationEvent,
  type ChatRuntimeDomainEvent,
} from './event-normalizer';

export function subscribeChatConversationEvents(
  handler: (event: ChatRuntimeDomainEvent) => void,
): () => void {
  return subscribeHostEvent('gateway:conversation-event', (payload) => {
    const event = normalizeGatewayConversationEvent(payload);
    if (!event) {
      return;
    }
    handler(event);
  });
}
