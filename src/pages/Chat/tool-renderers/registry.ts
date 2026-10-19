import type { TFunction } from 'i18next';
import type { SessionRenderToolCard } from '../../../types/session/tool-card';
import type { ToolActivityContent, ToolActivityViewModel } from '../tool-activity-view-model';
import { describeGenericToolActivity, genericToolActivityRenderer } from './generic';
import { resolveMatchaAgentToolActivityRenderer } from './matcha-agent';
import { buildOpenClawToolActivityContent, describeOpenClawToolActivity } from './openclaw';
import { resolveOpenClawToolStatus } from './openclaw/outcome';
import { buildOpenClawToolActivityPreviewContent, mergeOpenClawDetails } from './openclaw-projection';
import type { GenericToolActivityRenderer, ToolActivityDescriptor, ToolActivityRenderer } from './types';
import { createToolRendererContext } from './types';

const GENERIC_TOOL_ACTIVITY_RENDERER: GenericToolActivityRenderer = {
  name: 'generic',
  matches: () => true,
  describe: describeGenericToolActivity,
  buildContent: genericToolActivityRenderer,
};

const OPENCLAW_TOOL_ACTIVITY_RENDERER: ToolActivityRenderer = {
  name: 'generic',
  matches: () => true,
  describe: describeOpenClawToolActivity,
  buildContent: (tool, t) => mergeOpenClawDetails(tool, buildOpenClawToolActivityContent(tool, t), t),
};

export function resolveToolActivityRenderer(tool: SessionRenderToolCard): ToolActivityRenderer {
  switch (tool.runtimeAdapterId) {
    case 'openclaw': return OPENCLAW_TOOL_ACTIVITY_RENDERER;
    case 'matcha-agent': return resolveMatchaAgentToolActivityRenderer(tool, createToolRendererContext(tool)) ?? GENERIC_TOOL_ACTIVITY_RENDERER;
    default: return GENERIC_TOOL_ACTIVITY_RENDERER;
  }
}

export function describeToolActivity(tool: SessionRenderToolCard, t: TFunction<'chat'>): ToolActivityDescriptor {
  return resolveToolActivityRenderer(tool).describe(tool, t);
}

export function summarizeToolActivities(tools: readonly SessionRenderToolCard[], t: TFunction<'chat'>): string {
  const files = {
    read: { calls: 0, paths: new Set<string>() },
    edit: { calls: 0, paths: new Set<string>() },
    write: { calls: 0, paths: new Set<string>() },
    delete: { calls: 0, paths: new Set<string>() },
  };
  let commands = 0;
  let searches = 0;
  let fetches = 0;
  let otherCalls = 0;
  const labels = new Set<string>();
  for (const tool of tools) {
    const descriptor = describeToolActivity(tool, t);
    if (descriptor.fileOperations?.length) {
      const operations = new Set<keyof typeof files>();
      for (const { kind, path } of descriptor.fileOperations) {
        operations.add(kind);
        if (path.trim()) files[kind].paths.add(path.trim());
      }
      for (const kind of operations) files[kind].calls += 1;
    } else if (descriptor.kind === 'read' || descriptor.kind === 'edit' || descriptor.kind === 'write') {
      const operation = files[descriptor.kind];
      operation.calls += 1;
      if (descriptor.target?.trim()) operation.paths.add(descriptor.target.trim());
    } else if (descriptor.kind === 'command') {
      commands += 1;
    } else if (descriptor.kind === 'search') {
      searches += 1;
    } else if (descriptor.kind === 'fetch') {
      fetches += 1;
    } else {
      otherCalls += 1;
      labels.add(descriptor.label);
    }
  }
  const parts: string[] = [];
  if (commands > 0) parts.push(t('toolActivity.group.commands', { count: commands }));
  const fileKeys = { read: 'read', edit: 'edited', write: 'wrote', delete: 'deleted' } as const;
  for (const kind of ['read', 'edit', 'write', 'delete'] as const) {
    const count = files[kind].paths.size || files[kind].calls;
    if (count > 0) parts.push(t(`toolActivity.group.${fileKeys[kind]}`, { count }));
  }
  if (searches > 0) parts.push(t('toolActivity.group.searches', { count: searches }));
  if (fetches > 0) parts.push(t('toolActivity.group.fetches', { count: fetches }));
  if (labels.size > 2) {
    parts.push(t('toolActivity.group.tools', { count: otherCalls }));
  } else if (labels.size > 0) {
    const name = [...labels].join(t('toolActivity.listSeparator'));
    parts.push(otherCalls > labels.size
      ? t('toolActivity.group.usedRepeated', { name, count: otherCalls })
      : t('toolActivity.group.used', { name }));
  }
  return parts.join(t('toolActivity.listSeparator'));
}

export function getToolActivityStatus(tool: SessionRenderToolCard): SessionRenderToolCard['status'] {
  return tool.runtimeAdapterId === 'openclaw' ? resolveOpenClawToolStatus(tool) : tool.status;
}

function withToolStatus(tool: SessionRenderToolCard, activity: ToolActivityContent, t: TFunction<'chat'>): ToolActivityViewModel {
  const { hasOutputError, ...content } = activity;
  const status = tool.runtimeAdapterId !== 'openclaw' && tool.status === 'completed' && hasOutputError === true
    ? 'error'
    : getToolActivityStatus(tool);
  const isRunning = status === 'running';
  const isError = status === 'error';
  const statusLabel = status === 'completed' ? '' : t(`toolStatus.${status}`);
  return {
    ...content,
    tone: isError ? 'danger' : isRunning ? 'running' : status === 'missing_result' || status === 'unknown' ? 'muted' : 'neutral',
    isRunning,
    isError,
    trailingLabels: statusLabel
      ? [{ text: statusLabel, tone: 'muted' }, ...content.trailingLabels]
      : content.trailingLabels,
  };
}

export function buildToolActivityViewModelFromRegistry(tool: SessionRenderToolCard, t: TFunction<'chat'>): ToolActivityViewModel {
  return withToolStatus(tool, resolveToolActivityRenderer(tool).buildContent(tool, t), t);
}

export function buildToolActivityPreview(tool: SessionRenderToolCard, t: TFunction<'chat'>): ToolActivityViewModel | null {
  if (tool.runtimeAdapterId !== 'openclaw') return null;
  const content = buildOpenClawToolActivityPreviewContent(tool, tool.displayTitle || tool.name, t);
  if (!content) return null;
  return withToolStatus(tool, { ...content, title: content.progressReceipt ? content.title : describeToolActivity(tool, t).title }, t);
}
