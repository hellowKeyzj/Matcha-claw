import type { ContentBlock, RawMessage } from './types';

const LIVE_THREAD_RENDER_LIMIT = 30;
const ESTIMATED_ROW_HEIGHT_PX = 96;
const MIN_VISIBLE_ROWS = 6;
const FIRST_PAINT_BUDGET_PER_ROW = 2;

interface MessageCostStats {
  textLength: number;
  lineCount: number;
  codeBlockCount: number;
  imageCount: number;
  attachmentCount: number;
}

function isToolResultRole(role: RawMessage['role'] | string | undefined): boolean {
  return role === 'toolresult' || role === 'tool_result';
}

export function isRenderableLiveMessage(message: RawMessage): boolean {
  return !isToolResultRole(message.role);
}

function extractMessageStats(message: RawMessage): MessageCostStats {
  let textLength = 0;
  let lineCount = 0;
  let codeBlockCount = 0;
  let imageCount = 0;

  const pushText = (value: string) => {
    if (!value) {
      return;
    }
    textLength += value.length;
    lineCount += value.split(/\r?\n/).length;
    codeBlockCount += Math.floor((value.match(/```/g) ?? []).length / 2);
  };

  if (typeof message.content === 'string') {
    pushText(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content as ContentBlock[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        pushText(block.text);
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        pushText(block.thinking);
      }
      if (block.type === 'image') {
        imageCount += 1;
      }
    }
  }

  return {
    textLength,
    lineCount,
    codeBlockCount,
    imageCount,
    attachmentCount: Array.isArray(message._attachedFiles) ? message._attachedFiles.length : 0,
  };
}

export function getMessageWeight(message: RawMessage): 1 | 2 | 4 | 8 {
  const stats = extractMessageStats(message);
  if (
    stats.imageCount > 0
    || stats.codeBlockCount >= 2
    || stats.textLength > 2400
    || stats.lineCount > 45
  ) {
    return 8;
  }
  if (
    stats.attachmentCount > 0
    || stats.codeBlockCount === 1
    || stats.textLength > 900
    || stats.lineCount > 18
  ) {
    return 4;
  }
  if (stats.textLength > 240 || stats.lineCount > 6) {
    return 2;
  }
  return 1;
}

function collectRenderableIndexes(messages: RawMessage[]): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (isRenderableLiveMessage(messages[index])) {
      indexes.push(index);
    }
  }
  return indexes;
}

function sliceTailFromRenderableIndex(
  messages: RawMessage[],
  renderableIndexes: number[],
  renderableStart: number,
): RawMessage[] {
  if (renderableIndexes.length === 0) {
    return [];
  }
  const startIndex = renderableIndexes[Math.max(0, renderableStart)];
  return startIndex > 0 ? messages.slice(startIndex) : messages;
}

function resolveViewportHeight(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override;
  }
  if (typeof window !== 'undefined' && typeof window.innerHeight === 'number' && window.innerHeight > 0) {
    return window.innerHeight;
  }
  return 900;
}

export function pickTailMessagesForFirstPaint(
  messages: RawMessage[],
  viewportHeight?: number,
): RawMessage[] {
  const renderableIndexes = collectRenderableIndexes(messages);
  if (renderableIndexes.length <= 2) {
    return messages;
  }

  const baseRows = Math.max(
    MIN_VISIBLE_ROWS,
    Math.floor(resolveViewportHeight(viewportHeight) / ESTIMATED_ROW_HEIGHT_PX),
  );
  const budget = baseRows * FIRST_PAINT_BUDGET_PER_ROW;
  let spent = 0;
  let includedRenderableCount = 0;
  let renderableStart = renderableIndexes.length - 1;

  for (let cursor = renderableIndexes.length - 1; cursor >= 0; cursor -= 1) {
    const message = messages[renderableIndexes[cursor]];
    const weight = getMessageWeight(message);
    if (includedRenderableCount >= 2 && spent + weight > budget) {
      break;
    }
    spent += weight;
    includedRenderableCount += 1;
    renderableStart = cursor;
  }

  const lastRenderableMessage = messages[renderableIndexes[renderableIndexes.length - 1]];
  if (
    includedRenderableCount < 2
    || (lastRenderableMessage?.role === 'assistant' && renderableStart > 0)
  ) {
    renderableStart = Math.max(0, renderableStart - 1);
  }

  return sliceTailFromRenderableIndex(messages, renderableIndexes, renderableStart);
}

export function pickRenderableTailMessages(messages: RawMessage[], limit: number): RawMessage[] {
  const renderableIndexes = collectRenderableIndexes(messages);
  if (renderableIndexes.length <= limit) {
    return messages;
  }
  return sliceTailFromRenderableIndex(messages, renderableIndexes, renderableIndexes.length - limit);
}

export function pickExpandedLiveMessages(messages: RawMessage[]): RawMessage[] {
  return pickRenderableTailMessages(messages, LIVE_THREAD_RENDER_LIMIT);
}

export function countRenderableLiveMessages(messages: RawMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (isRenderableLiveMessage(message)) {
      count += 1;
    }
  }
  return count;
}

export function resolveTailWindowStart(
  fullMessages: RawMessage[],
  windowMessages: RawMessage[],
): number | null {
  if (windowMessages.length > fullMessages.length) {
    return null;
  }
  const start = fullMessages.length - windowMessages.length;
  for (let index = 0; index < windowMessages.length; index += 1) {
    if (fullMessages[start + index] !== windowMessages[index]) {
      return null;
    }
  }
  return start;
}

export function remapTailWindowMessages(
  fullMessages: RawMessage[],
  currentWindow: RawMessage[],
  nextFullMessages: RawMessage[],
): RawMessage[] | null {
  const start = resolveTailWindowStart(fullMessages, currentWindow);
  if (start == null) {
    return null;
  }
  return start > 0 ? nextFullMessages.slice(start) : nextFullMessages;
}
