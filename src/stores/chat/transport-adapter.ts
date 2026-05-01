import { subscribeHostEvent } from '@/lib/host-events';
import {
  normalizeGatewayConversationEvent,
  type ChatConversationDomainEvent,
} from './event-normalizer';

export function subscribeChatConversationEvents(
  handler: (event: ChatConversationDomainEvent) => void,
): () => void {
  return subscribeHostEvent('gateway:conversation-event', (payload) => {
    const event = normalizeGatewayConversationEvent(payload);
    if (!event) {
      return;
    }
    handler(event);
  });
}
