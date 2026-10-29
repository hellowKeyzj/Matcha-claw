import type { SessionRenderToolCard } from '@/types/session/tool-card';

export interface ToolRef {
  readonly itemKey: string;
  readonly segmentKey: string;
  readonly tool: SessionRenderToolCard;
}

export interface ToolGroup {
  readonly key: string;
  readonly tools: ReadonlyArray<SessionRenderToolCard>;
  readonly sources: ReadonlyArray<ToolRef>;
}

export type ToolSlot =
  | { readonly kind: 'head'; readonly group: ToolGroup }
  | { readonly kind: 'covered'; readonly groupKey: string };

export type ToolGroupPlan = ReadonlyMap<string, ReadonlyMap<string, ToolSlot>>;

export function getToolDisclosureKey(tool: SessionRenderToolCard): string {
  return `tool:${tool.runtimeAdapterId ?? ''}:${tool.runId ?? ''}:${tool.toolCallId || tool.id}`;
}

export function getToolGroupDisclosureKey(groupKey: string): string {
  return `group:${groupKey}`;
}

