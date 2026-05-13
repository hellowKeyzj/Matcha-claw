import type {
  SessionRenderToolCard,
  SessionRenderToolStatus,
  SessionRenderToolUse,
} from '../../../shared/session-adapter-types';
import { normalizeToolIdentity } from './tool-card-utils';
import {
  resolveToolCardRenderState,
  serializeToolResultBodyText,
} from './tool-card-render-state';
import {
  isStateOnlyToolName,
} from '../state-only-tools';

export function findToolCardIndexByCallId(
  tools: ReadonlyArray<SessionRenderToolCard>,
  toolCallId: string,
): number {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (normalizeToolIdentity(tools[index]?.toolCallId) === toolCallId) {
      return index;
    }
  }
  return -1;
}

function findToolCardIndexById(
  tools: ReadonlyArray<SessionRenderToolCard>,
  id: string,
): number {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (normalizeToolIdentity(tools[index]?.id) === id) {
      return index;
    }
  }
  return -1;
}

export function findPendingToolCardIndexByName(
  tools: ReadonlyArray<SessionRenderToolCard>,
  name: string,
): number {
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    const tool = tools[index];
    if (!tool || normalizeToolIdentity(tool.toolCallId)) {
      continue;
    }
    if (tool.name === name) {
      return index;
    }
  }
  return -1;
}

export function resolveToolCardId(
  tools: ReadonlyArray<SessionRenderToolCard>,
  preferredId: string,
  fallbackName: string,
): string {
  const baseId = preferredId || fallbackName || 'tool';
  if (!tools.some((tool) => tool.id === baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (tools.some((tool) => tool.id === `${baseId}:${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}:${suffix}`;
}

export function mergeToolCards(input: {
  existingTools: ReadonlyArray<SessionRenderToolCard>;
  toolUses: ReadonlyArray<SessionRenderToolUse>;
  toolStatuses: ReadonlyArray<SessionRenderToolStatus>;
}): SessionRenderToolCard[] {
  const merged = input.existingTools
    .filter((tool) => !isStateOnlyToolName(tool.name))
    .map((tool) => ({ ...tool }));

  for (const toolUse of input.toolUses) {
    if (isStateOnlyToolName(toolUse.name)) {
      continue;
    }
    const toolCallId = normalizeToolIdentity(toolUse.toolCallId);
    const existingIndex = toolCallId
      ? Math.max(
          findToolCardIndexByCallId(merged, toolCallId),
          findPendingToolCardIndexByName(merged, toolUse.name),
        )
      : findToolCardIndexById(merged, normalizeToolIdentity(toolUse.id));
    if (existingIndex < 0) {
      merged.push({
        id: resolveToolCardId(merged, toolCallId || normalizeToolIdentity(toolUse.id), toolUse.name),
        ...(toolCallId ? { toolCallId } : {}),
        name: toolUse.name,
        input: structuredClone(toolUse.input),
        status: toolUse.status ?? 'running',
        ...resolveToolCardRenderState({
          name: toolUse.name,
          input: toolUse.input,
        }),
        ...(toolUse.summary ? { summary: toolUse.summary } : {}),
        ...(toolUse.durationMs != null ? { durationMs: toolUse.durationMs } : {}),
      });
      continue;
    }
    const existing = merged[existingIndex]!;
    merged[existingIndex] = {
      ...existing,
      id: toolCallId || existing.id,
      toolCallId: toolCallId || existing.toolCallId,
      name: toolUse.name || existing.name,
      input: structuredClone(toolUse.input),
      status: toolUse.status ?? existing.status,
      ...resolveToolCardRenderState({
        name: toolUse.name || existing.name,
        input: toolUse.input,
        output: existing.output,
        outputText: existing.result.kind === 'canvas'
          ? existing.result.rawText
          : existing.result.kind === 'text' || existing.result.kind === 'json'
            ? serializeToolResultBodyText(existing.result)
            : undefined,
      }),
      summary: toolUse.summary ?? existing.summary,
      durationMs: toolUse.durationMs ?? existing.durationMs,
      updatedAt: existing.updatedAt,
      output: existing.output,
    };
  }

  for (const toolStatus of input.toolStatuses) {
    if (isStateOnlyToolName(toolStatus.name)) {
      continue;
    }
    const toolCallId = normalizeToolIdentity(toolStatus.toolCallId || toolStatus.id);
    const existingIndex = toolCallId
      ? Math.max(
          findToolCardIndexByCallId(merged, toolCallId),
          findPendingToolCardIndexByName(merged, toolStatus.name),
        )
      : Math.max(
          findToolCardIndexById(merged, normalizeToolIdentity(toolStatus.id ?? '')),
          findPendingToolCardIndexByName(merged, toolStatus.name),
        );
    if (existingIndex < 0) {
      merged.push({
        id: resolveToolCardId(merged, toolCallId || normalizeToolIdentity(toolStatus.id), toolStatus.name),
        ...(toolCallId ? { toolCallId } : {}),
        name: toolStatus.name,
        input: null,
        status: toolStatus.status,
        ...resolveToolCardRenderState({
          name: toolStatus.name,
          input: null,
          output: toolStatus.output,
          outputText: toolStatus.outputText,
        }),
        ...(toolStatus.summary ? { summary: toolStatus.summary } : {}),
        ...(toolStatus.durationMs != null ? { durationMs: toolStatus.durationMs } : {}),
        ...(toolStatus.updatedAt != null ? { updatedAt: toolStatus.updatedAt } : {}),
        ...(toolStatus.output !== undefined ? { output: structuredClone(toolStatus.output) } : {}),
      });
      continue;
    }
    const existing = merged[existingIndex]!;
    const nextName = (
      (toolStatus.name === toolStatus.toolCallId || toolStatus.name === toolStatus.id)
      && existing.name
    ) ? existing.name : (toolStatus.name || existing.name);
    const nextOutput = toolStatus.output !== undefined ? structuredClone(toolStatus.output) : existing.output;
    const nextRawOutputText = toolStatus.outputText
      ?? (existing.result.kind === 'canvas'
        ? existing.result.rawText
        : existing.result.kind === 'text' || existing.result.kind === 'json'
          ? serializeToolResultBodyText(existing.result)
          : undefined);
    merged[existingIndex] = {
      ...existing,
      id: toolCallId || existing.id,
      toolCallId: toolCallId || existing.toolCallId,
      name: nextName,
      status: toolStatus.status,
      ...resolveToolCardRenderState({
        name: nextName,
        input: existing.input,
        output: nextOutput,
        outputText: nextRawOutputText,
      }),
      summary: toolStatus.summary ?? existing.summary,
      durationMs: toolStatus.durationMs ?? existing.durationMs,
      updatedAt: toolStatus.updatedAt ?? existing.updatedAt,
      output: nextOutput,
    };
  }

  return merged;
}
