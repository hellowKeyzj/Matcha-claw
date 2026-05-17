import { normalizeOptionalString } from '../../shared/chat-message-normalization';
import type {
  SessionTimelineEntryStatus,
  SessionTurnBindingSource,
  SessionTurnIdentityConfidence,
  SessionTurnIdentityMode,
} from '../../shared/session-adapter-types';
import type { SessionTranscriptMessage } from './transcript-types';

export interface ResolvedTranscriptTurnBinding {
  key: string;
  source: SessionTurnBindingSource;
  mode: SessionTurnIdentityMode;
  confidence: SessionTurnIdentityConfidence;
}

export function resolveSessionLaneKey(agentId: string): string {
  return agentId ? `member:${agentId}` : 'main';
}

export function resolveTranscriptTurnBinding(
  message: SessionTranscriptMessage,
  options: {
    runId?: string;
    turnAnchorId?: string;
  } = {},
): ResolvedTranscriptTurnBinding | null {
  const runId = normalizeOptionalString(options.runId);
  if (runId) {
    return {
      key: runId,
      source: 'run',
      mode: 'run',
      confidence: 'strong',
    };
  }

  const turnAnchorId = normalizeOptionalString(options.turnAnchorId);
  if (turnAnchorId) {
    return {
      key: `anchor:${turnAnchorId}`,
      source: 'message',
      mode: 'message',
      confidence: 'strong',
    };
  }

  const messageId = normalizeOptionalString(message.messageId);
  if (messageId) {
    return {
      key: messageId,
      source: 'message',
      mode: 'message',
      confidence: 'strong',
    };
  }

  const originMessageId = normalizeOptionalString(message.originMessageId);
  if (originMessageId) {
    return {
      key: originMessageId,
      source: 'origin',
      mode: 'origin',
      confidence: 'fallback',
    };
  }

  const clientId = normalizeOptionalString(message.clientId);
  if (clientId) {
    return {
      key: clientId,
      source: 'client',
      mode: 'client',
      confidence: 'fallback',
    };
  }

  return null;
}

export function resolveTranscriptEntryId(
  message: SessionTranscriptMessage,
  index: number,
  options: {
    runId?: string;
    sequenceId?: number;
  } = {},
): string {
  return normalizeOptionalString(
    message.id
    ?? message.messageId
    ?? message.originMessageId
    ?? message.clientId,
  ) ?? (() => {
    const runId = normalizeOptionalString(options.runId);
    if (runId) {
      const agentId = normalizeOptionalString(message.agentId);
      return agentId
        ? `run:${runId}:agent:${agentId}:${message.role || 'message'}:${index}`
        : `run:${runId}:${message.role || 'message'}:${index}`;
    }
    return `entry-${index}`;
  })();
}

export function resolveTranscriptEntryStatus(message: SessionTranscriptMessage): SessionTimelineEntryStatus {
  if (message.streaming) {
    return 'streaming';
  }
  if (message.isError || message.status === 'error') {
    return 'error';
  }
  if (message.status === 'sending' || message.status === 'timeout') {
    return 'pending';
  }
  return 'final';
}
