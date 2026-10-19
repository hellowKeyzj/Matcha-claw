import type { SessionRenderToolCard } from '../../../types/session/tool-card';
import { agentToolActivityRenderer, describeAgentToolActivity, isAgentToolActivityTool } from './agent';
import { buildFileToolActivityContent, describeFileToolActivity, isFileToolActivityName } from './file';
import { canRenderSearchToolActivity, describeSearchToolActivity, renderSearchToolActivity } from './search';
import { describeShellToolActivity, isShellToolCard, shellToolActivityRenderer } from './shell';
import { describeSkillToolActivity, isSkillToolActivity, skillToolActivityRenderer } from './skill';
import type { ToolActivityRenderer, ToolRendererContext } from './types';
import { matchesKnownToolName } from './types';
import { canRenderWebToolActivity, describeWebToolActivity, renderWebToolActivity } from './web';

const MATCHA_AGENT_TOOL_ACTIVITY_RENDERERS = [
  {
    name: 'file',
    matches: (tool, context) => matchesKnownToolName(context, 'file')
      || isFileToolActivityName(tool.name) || isFileToolActivityName(tool.displayTitle),
    describe: describeFileToolActivity,
    buildContent: buildFileToolActivityContent,
  },
  {
    name: 'shell',
    matches: (tool, context) => matchesKnownToolName(context, 'shell') || isShellToolCard(tool),
    describe: describeShellToolActivity,
    buildContent: shellToolActivityRenderer,
  },
  {
    name: 'web',
    matches: (tool, context) => matchesKnownToolName(context, 'web') || canRenderWebToolActivity(tool),
    describe: describeWebToolActivity,
    buildContent: renderWebToolActivity,
  },
  {
    name: 'search',
    matches: (tool, context) => matchesKnownToolName(context, 'search') || canRenderSearchToolActivity(tool),
    describe: describeSearchToolActivity,
    buildContent: renderSearchToolActivity,
  },
  {
    name: 'skill',
    matches: (tool, context) => matchesKnownToolName(context, 'skill') || isSkillToolActivity(tool),
    describe: describeSkillToolActivity,
    buildContent: skillToolActivityRenderer,
  },
  {
    name: 'agent',
    matches: (tool, context) => matchesKnownToolName(context, 'agent') || isAgentToolActivityTool(tool),
    describe: describeAgentToolActivity,
    buildContent: agentToolActivityRenderer,
  },
] as const satisfies readonly ToolActivityRenderer[];

export function resolveMatchaAgentToolActivityRenderer(
  tool: SessionRenderToolCard,
  context: ToolRendererContext,
): ToolActivityRenderer | undefined {
  // Qualified MCP names retain their server identity even when their display title is native-looking.
  if (tool.name.includes('__')) return undefined;
  return MATCHA_AGENT_TOOL_ACTIVITY_RENDERERS.find((renderer) => renderer.matches(tool, context));
}
