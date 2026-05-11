import type {
  SessionRenderToolStatus,
  SessionRenderToolCard,
} from '../../../shared/session-adapter-types';
import {
  isRecord,
  normalizeOptionalString,
  normalizeToolIdentity,
} from './tool-card-utils';
import {
  coerceToolArgs,
  extractToolResultOutput,
  extractToolResultOutputText,
  normalizeContentBlocks,
} from './tool-card-content';
import { serializeToolPayload } from './tool-card-preview';
import {
  resolveToolCardRenderState,
} from './tool-card-render-state';
import {
  findToolCardIndexByCallId,
  mergeToolCards,
  resolveToolCardId,
} from './tool-card-merge';

function findLatestUnresolvedToolCardIndex(
  tools: ReadonlyArray<SessionRenderToolCard>,
  preferredToolCallId: string,
  name: string,
): number {
  if (preferredToolCallId) {
    const exactIndex = findToolCardIndexByCallId(tools, preferredToolCallId);
    if (exactIndex >= 0) {
      return exactIndex;
    }
  }
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (!tool || tool.name !== name || tool.result.kind !== 'none') {
      continue;
    }
    return index;
  }
  return -1;
}

export function buildToolCardsFromMessage(input: {
  content: unknown;
  role?: string;
  toolName?: string;
  toolCallId?: string;
  toolStatuses?: ReadonlyArray<SessionRenderToolStatus>;
  toolCalls?: ReadonlyArray<Record<string, unknown>>;
}): SessionRenderToolCard[] {
  const cards: SessionRenderToolCard[] = [];
  const contentBlocks = normalizeContentBlocks(input.content);

  for (const [index, block] of contentBlocks.entries()) {
    const type = normalizeToolIdentity(block.type).toLowerCase();
    const toolCallId = normalizeToolIdentity(
      block.id
      ?? block.toolCallId
      ?? block.tool_call_id
      ?? block.callId,
    );
    const fallbackName = normalizeOptionalString(input.toolName) ?? 'tool';
    const name = normalizeOptionalString(block.name) ?? fallbackName;
    const isToolCall = (
      type === 'toolcall'
      || type === 'tool_call'
      || type === 'tooluse'
      || type === 'tool_use'
      || (Boolean(name) && (
        Object.prototype.hasOwnProperty.call(block, 'input')
        || Object.prototype.hasOwnProperty.call(block, 'arguments')
        || Object.prototype.hasOwnProperty.call(block, 'args')
      ))
    );

    if (isToolCall && name) {
      const toolInput = coerceToolArgs(block.input ?? block.arguments ?? block.args);
      cards.push({
        id: resolveToolCardId(cards, toolCallId, name || `tool:${index}`),
        ...(toolCallId ? { toolCallId } : {}),
        name,
        input: toolInput,
        status: 'running',
        ...resolveToolCardRenderState({
          name,
          input: toolInput,
        }),
      });
      continue;
    }

    if ((type === 'toolresult' || type === 'tool_result') && name) {
      const output = extractToolResultOutput(block);
      const outputText = extractToolResultOutputText(output) ?? serializeToolPayload(output);
      const isError = block.isError === true || block.is_error === true;
      const existingIndex = findLatestUnresolvedToolCardIndex(cards, toolCallId, name);
      if (existingIndex < 0) {
        cards.push({
          id: resolveToolCardId(cards, toolCallId, name || `tool:${index}`),
          ...(toolCallId ? { toolCallId } : {}),
          name,
          input: null,
          status: isError ? 'error' : 'completed',
          ...resolveToolCardRenderState({
            name,
            input: null,
            output,
            outputText,
          }),
          ...(output !== undefined ? { output } : {}),
        });
        continue;
      }
      const existing = cards[existingIndex]!;
      cards[existingIndex] = {
        ...existing,
        id: toolCallId || existing.id,
        toolCallId: toolCallId || existing.toolCallId,
        name,
        status: isError ? 'error' : 'completed',
        ...resolveToolCardRenderState({
          name,
          input: existing.input,
          output,
          outputText,
        }),
        ...(output !== undefined ? { output } : {}),
      };
    }
  }

  const fallbackToolStatuses = input.toolStatuses ?? [];
  if (cards.length > 0) {
    if (fallbackToolStatuses.length === 0) {
      return cards;
    }
    const safeFallbackToolStatuses = fallbackToolStatuses.filter((toolStatus) => {
      if (normalizeToolIdentity(toolStatus.toolCallId || toolStatus.id)) {
        return true;
      }
      let sameNameCount = 0;
      for (const card of cards) {
        if (card.name === toolStatus.name) {
          sameNameCount += 1;
          if (sameNameCount > 1) {
            return false;
          }
        }
      }
      return true;
    });
    return mergeToolCards({
      existingTools: cards,
      toolUses: [],
      toolStatuses: safeFallbackToolStatuses,
    });
  }

  const toolUses = Array.isArray(input.toolCalls)
    ? input.toolCalls.flatMap((item) => {
        const toolCallId = normalizeToolIdentity(item.id);
        const fn = isRecord(item.function) ? item.function : item;
        const name = normalizeOptionalString(fn.name) ?? '';
        if (!name) {
          return [];
        }
        return [{
          id: toolCallId || name,
          ...(toolCallId ? { toolCallId } : {}),
          name,
          input: coerceToolArgs(fn.input ?? fn.arguments),
        }];
      })
    : [];

  if (toolUses.length > 0 || fallbackToolStatuses.length > 0) {
    return mergeToolCards({
      existingTools: [],
      toolUses,
      toolStatuses: fallbackToolStatuses,
    });
  }

  const standaloneToolName = normalizeOptionalString(input.toolName);
  const standaloneToolCallId = normalizeOptionalString(input.toolCallId);
  const standaloneOutputText = extractToolResultOutputText(input.content) ?? serializeToolPayload(input.content);
  if (
    standaloneToolName
    && standaloneOutputText
    && (normalizeToolIdentity(input.role).toLowerCase() === 'toolresult'
      || normalizeToolIdentity(input.role).toLowerCase() === 'tool_result')
  ) {
    return [{
      id: standaloneToolCallId || standaloneToolName,
      ...(standaloneToolCallId ? { toolCallId: standaloneToolCallId } : {}),
      name: standaloneToolName,
      input: null,
      status: 'completed',
      ...resolveToolCardRenderState({
        name: standaloneToolName,
        input: null,
        output: input.content,
        outputText: standaloneOutputText,
      }),
      output: input.content,
    }];
  }

  return [];
}

export { mergeToolCards } from './tool-card-merge';
