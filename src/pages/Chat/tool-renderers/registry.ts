import type { TFunction } from 'i18next';
import type {
  SessionRenderToolCard,
  SessionRenderToolRuntimeAdapterId,
} from '../../../types/session/tool-card';
import type { ToolActivityViewModel } from '../tool-activity-view-model';
import { agentToolActivityRenderer, isAgentToolActivityTool } from './agent';
import { buildFileToolActivityContent, isFileToolActivityName } from './file';
import { genericToolActivityRenderer } from './generic';
import { canRenderSearchToolActivity, renderSearchToolActivity } from './search';
import { isShellToolCard, shellToolActivityRenderer } from './shell';
import { isSkillToolActivity, skillToolActivityRenderer } from './skill';
import type { GenericToolActivityRenderer, ToolActivityRenderer, ToolRendererContext } from './types';
import { createToolRendererContext, matchesKnownToolName } from './types';
import { canRenderWebToolActivity, renderWebToolActivity } from './web';

const FILE_TOOL_ACTIVITY_RENDERER: ToolActivityRenderer = {
  name: 'file',
  matches: (tool, context) => matchesKnownToolName(context, 'file')
    || isFileToolActivityName(tool.name)
    || isFileToolActivityName(tool.displayTitle),
  buildContent: buildFileToolActivityContent,
};

const SHELL_TOOL_ACTIVITY_RENDERER: ToolActivityRenderer = {
  name: 'shell',
  matches: (tool, context) => matchesKnownToolName(context, 'shell') || isShellToolCard(tool),
  buildContent: shellToolActivityRenderer,
};

const SEARCH_TOOL_ACTIVITY_RENDERER: ToolActivityRenderer = {
  name: 'search',
  matches: (tool, context) => matchesKnownToolName(context, 'search') || canRenderSearchToolActivity(tool),
  buildContent: renderSearchToolActivity,
};

const SKILL_TOOL_ACTIVITY_RENDERER: ToolActivityRenderer = {
  name: 'skill',
  matches: (tool, context) => matchesKnownToolName(context, 'skill') || isSkillToolActivity(tool),
  buildContent: skillToolActivityRenderer,
};

const AGENT_TOOL_ACTIVITY_RENDERER: ToolActivityRenderer = {
  name: 'agent',
  matches: (tool, context) => matchesKnownToolName(context, 'agent') || isAgentToolActivityTool(tool),
  buildContent: agentToolActivityRenderer,
};

const WEB_TOOL_ACTIVITY_RENDERER: ToolActivityRenderer = {
  name: 'web',
  matches: (tool, context) => matchesKnownToolName(context, 'web') || canRenderWebToolActivity(tool),
  buildContent: renderWebToolActivity,
};

const PROGRESS_CARD_TOOL_ACTIVITY_RENDERER: ToolActivityRenderer = {
  name: 'progress_card',
  matches: (_tool, context) => context.runtimeAdapterId === 'openclaw' && matchesKnownToolName(context, 'progress_card'),
  buildContent: genericToolActivityRenderer,
};

const OPENCLAW_TOOL_ACTIVITY_RENDERERS = [
  FILE_TOOL_ACTIVITY_RENDERER,
  SHELL_TOOL_ACTIVITY_RENDERER,
  WEB_TOOL_ACTIVITY_RENDERER,
  SEARCH_TOOL_ACTIVITY_RENDERER,
  PROGRESS_CARD_TOOL_ACTIVITY_RENDERER,
  SKILL_TOOL_ACTIVITY_RENDERER,
  AGENT_TOOL_ACTIVITY_RENDERER,
] as const satisfies readonly ToolActivityRenderer[];

const MATCHA_AGENT_TOOL_ACTIVITY_RENDERERS = [
  FILE_TOOL_ACTIVITY_RENDERER,
  SHELL_TOOL_ACTIVITY_RENDERER,
  WEB_TOOL_ACTIVITY_RENDERER,
  SEARCH_TOOL_ACTIVITY_RENDERER,
  SKILL_TOOL_ACTIVITY_RENDERER,
  AGENT_TOOL_ACTIVITY_RENDERER,
] as const satisfies readonly ToolActivityRenderer[];

const TOOL_ACTIVITY_RENDERERS_BY_RUNTIME: Readonly<Record<SessionRenderToolRuntimeAdapterId, readonly ToolActivityRenderer[]>> = {
  openclaw: OPENCLAW_TOOL_ACTIVITY_RENDERERS,
  'matcha-agent': MATCHA_AGENT_TOOL_ACTIVITY_RENDERERS,
};

const GENERIC_TOOL_ACTIVITY_RENDERER: GenericToolActivityRenderer = {
  name: 'generic',
  matches: () => true,
  buildContent: genericToolActivityRenderer,
};

function toolActivityRenderersForContext(context: ToolRendererContext): readonly ToolActivityRenderer[] {
  return context.runtimeAdapterId
    ? TOOL_ACTIVITY_RENDERERS_BY_RUNTIME[context.runtimeAdapterId]
    : MATCHA_AGENT_TOOL_ACTIVITY_RENDERERS;
}

function resolveToolActivityRendererForContext(
  tool: SessionRenderToolCard,
  context: ToolRendererContext,
): ToolActivityRenderer {
  return toolActivityRenderersForContext(context).find((renderer) => renderer.matches(tool, context))
    ?? GENERIC_TOOL_ACTIVITY_RENDERER;
}

export function resolveToolActivityRenderer(tool: SessionRenderToolCard): ToolActivityRenderer {
  return resolveToolActivityRendererForContext(tool, createToolRendererContext(tool));
}

export function buildToolActivityViewModelFromRegistry(tool: SessionRenderToolCard, t: TFunction<'chat'>): ToolActivityViewModel {
  const context = createToolRendererContext(tool);
  const { hasOutputError, ...content } = resolveToolActivityRendererForContext(tool, context).buildContent(tool, t);
  const isRunning = tool.status === 'running';
  const isError = tool.status === 'error' || (tool.status === 'completed' && hasOutputError === true);
  const status = isError ? 'error' : tool.status;
  const statusLabel = status === 'completed' ? '' : t(`toolStatus.${status}`);
  return {
    ...content,
    tone: isError ? 'danger' : isRunning ? 'running' : tool.status === 'missing_result' || tool.status === 'unknown' ? 'muted' : 'neutral',
    isRunning,
    isError,
    trailingLabels: statusLabel
      ? [{ text: statusLabel, tone: 'muted' }, ...content.trailingLabels]
      : content.trailingLabels,
  };
}
