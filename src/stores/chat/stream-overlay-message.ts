import type { AssistantMessageOverlay, ChatSessionRuntimeState, ContentBlock, RawMessage } from './types';

const renderMessageCache = new WeakMap<
  AssistantMessageOverlay,
  {
    streamingToolsRef: ChatSessionRuntimeState['streamingTools'];
    lastUserMessageAt: number | null;
    result: RawMessage | null;
  }
>();

function isToolBlock(block: ContentBlock): boolean {
  return (
    block.type === 'tool_use'
    || block.type === 'tool_result'
    || block.type === 'toolCall'
    || block.type === 'toolResult'
  );
}

function replaceMessageTextContent(
  content: unknown,
  text: string,
  options?: { stripToolBlocks?: boolean },
): unknown {
  if (!Array.isArray(content)) {
    return text;
  }

  const nextBlocks: ContentBlock[] = [];
  let insertedText = false;
  for (const block of content as ContentBlock[]) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (isToolBlock(block)) {
      if (!options?.stripToolBlocks) {
        nextBlocks.push(block);
      }
      continue;
    }
    if (block.type === 'text') {
      if (!insertedText && text.length > 0) {
        nextBlocks.push({ ...block, text });
        insertedText = true;
      }
      continue;
    }
    nextBlocks.push(block);
  }

  if (!insertedText && text.length > 0) {
    nextBlocks.unshift({ type: 'text', text });
  }

  if (nextBlocks.length === 0) {
    return text;
  }
  return nextBlocks;
}

function createFallbackSourceMessage(
  overlay: Pick<AssistantMessageOverlay, 'messageId' | 'targetText'>,
  lastUserMessageAt: number | null,
): RawMessage {
  return {
    id: overlay.messageId,
    role: 'assistant',
    content: overlay.targetText,
    timestamp: lastUserMessageAt != null ? (lastUserMessageAt / 1000) : (Date.now() / 1000),
  };
}

function shouldPreferIncomingContent(message: RawMessage): boolean {
  return Array.isArray(message.content);
}

function mergeOverlayBaseMessage(
  previousMessage: RawMessage | null,
  incomingMessage: RawMessage | null,
): RawMessage | null {
  if (!previousMessage) {
    return incomingMessage;
  }
  if (!incomingMessage) {
    return previousMessage;
  }

  return {
    ...previousMessage,
    ...incomingMessage,
    content: shouldPreferIncomingContent(incomingMessage)
      ? incomingMessage.content
      : previousMessage.content,
    _attachedFiles: incomingMessage._attachedFiles ?? previousMessage._attachedFiles,
  };
}

export function createAssistantOverlay(input: {
  runId: string;
  messageId: string;
  sourceMessage?: RawMessage | null;
  committedText?: string;
  targetText?: string;
  status?: AssistantMessageOverlay['status'];
  rafId?: number | null;
}): AssistantMessageOverlay {
  return {
    runId: input.runId,
    messageId: input.messageId,
    sourceMessage: input.sourceMessage ?? null,
    committedText: input.committedText ?? '',
    targetText: input.targetText ?? '',
    status: input.status ?? 'streaming',
    rafId: input.rafId ?? null,
  };
}

export function resolveOverlaySourceMessage(input: {
  previousMessage: RawMessage | null;
  incomingMessage?: RawMessage | null;
  messageId: string;
  targetText: string;
  lastUserMessageAt: number | null;
}): RawMessage {
  const base = mergeOverlayBaseMessage(
    input.previousMessage,
    input.incomingMessage ?? null,
  )
    ?? createFallbackSourceMessage(
      { messageId: input.messageId, targetText: input.targetText },
      input.lastUserMessageAt,
    );
  return {
    ...base,
    id: input.messageId,
    role: 'assistant',
    content: replaceMessageTextContent(base.content, input.targetText),
    timestamp: base.timestamp ?? (input.lastUserMessageAt != null ? (input.lastUserMessageAt / 1000) : (Date.now() / 1000)),
  };
}

export function selectStreamingRenderMessage(
  runtimeState: Pick<ChatSessionRuntimeState, 'assistantOverlay' | 'lastUserMessageAt' | 'streamingTools'>,
): RawMessage | null {
  const overlay = runtimeState.assistantOverlay;
  if (!overlay) {
    return null;
  }

  const cached = renderMessageCache.get(overlay);
  if (
    cached
    && cached.streamingToolsRef === runtimeState.streamingTools
    && cached.lastUserMessageAt === runtimeState.lastUserMessageAt
  ) {
    return cached.result;
  }

  const sourceMessage = overlay.sourceMessage
    ?? createFallbackSourceMessage(overlay, runtimeState.lastUserMessageAt);
  const content = replaceMessageTextContent(sourceMessage.content, overlay.committedText, {
    stripToolBlocks: true,
  });
  const hasRenderableText = overlay.committedText.trim().length > 0;
  const hasRenderableContentBlocks = Array.isArray(content) && content.length > 0;
  const hasToolStatus = runtimeState.streamingTools.length > 0;
  if (!hasRenderableText && !hasRenderableContentBlocks && !hasToolStatus) {
    renderMessageCache.set(overlay, {
      streamingToolsRef: runtimeState.streamingTools,
      lastUserMessageAt: runtimeState.lastUserMessageAt,
      result: null,
    });
    return null;
  }

  const result: RawMessage = {
    ...sourceMessage,
    id: overlay.messageId,
    role: 'assistant',
    content,
    timestamp: sourceMessage.timestamp ?? (runtimeState.lastUserMessageAt != null ? (runtimeState.lastUserMessageAt / 1000) : (Date.now() / 1000)),
  };
  renderMessageCache.set(overlay, {
    streamingToolsRef: runtimeState.streamingTools,
    lastUserMessageAt: runtimeState.lastUserMessageAt,
    result,
  });
  return result;
}
