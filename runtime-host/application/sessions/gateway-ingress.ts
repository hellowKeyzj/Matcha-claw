import type { SessionTimelineEntry } from '../../shared/session-adapter-types';
import {
  buildLifecycleIngressEvent,
} from './gateway-ingress-lifecycle';
import {
  buildMessageIngressEvents,
} from './gateway-ingress-message';
import {
  buildToolLifecycleIngressEvents,
} from './gateway-ingress-tool-lifecycle';
import type {
  GatewayConversationLifecyclePayload,
  GatewayConversationMessagePayload,
  GatewayConversationToolLifecyclePayload,
  GatewaySessionIngressEvent,
} from './gateway-ingress-types';
import {
  isRecord,
} from './session-value-normalization';
import type { RuntimeClockPort } from '../common/runtime-ports';

export type {
  GatewaySessionIngressEvent,
  SessionInfoIngressEvent,
  SessionTimelineIngressEvent,
  SessionToolStatusUpdateIngressEvent,
} from './gateway-ingress-types';

export function buildSessionUpdateEventsFromGatewayConversationEvent(
  payload: unknown,
  options: {
    clock: RuntimeClockPort;
    existingEntries?: SessionTimelineEntry[];
  },
): GatewaySessionIngressEvent[] {
  const input = isRecord(payload) ? payload : null;
  if (!input) {
    return [];
  }

  if (input.type === 'run.phase') {
    return [buildLifecycleIngressEvent(input as GatewayConversationLifecyclePayload, options.clock)];
  }

  if (input.type === 'tool.lifecycle') {
    return buildToolLifecycleIngressEvents(input.event as GatewayConversationToolLifecyclePayload);
  }

  if (input.type === 'chat.message') {
    return buildMessageIngressEvents(input.event as GatewayConversationMessagePayload, {
      existingEntries: options.existingEntries,
    });
  }

  return [];
}
