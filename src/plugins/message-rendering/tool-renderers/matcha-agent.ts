import { agentToolActivityRenderer, describeAgentToolActivity, isAgentToolActivityTool } from '@/plugins/message-rendering/tool-renderers/agent';
import { buildFileToolActivityContent, describeFileToolActivity, isFileToolActivityName } from '@/plugins/message-rendering/tool-renderers/file';
import { canRenderSearchToolActivity, describeSearchToolActivity, renderSearchToolActivity } from '@/plugins/message-rendering/tool-renderers/search';
import { describeShellToolActivity, isShellToolCard, shellToolActivityRenderer } from '@/plugins/message-rendering/tool-renderers/shell';
import { describeSkillToolActivity, isSkillToolActivity, skillToolActivityRenderer } from '@/plugins/message-rendering/tool-renderers/skill';
import type { ToolActivityRenderer } from '@/plugins/message-rendering/tool-renderers/types';
import { matchesKnownToolName } from '@/plugins/message-rendering/tool-renderers/types';
import { canRenderWebToolActivity, describeWebToolActivity, renderWebToolActivity } from '@/plugins/message-rendering/tool-renderers/web';

const renderers = [
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

// Qualified MCP names keep their server identity, including native-looking display titles.
export const MATCHA_AGENT_TOOL_ACTIVITY_RENDERERS: readonly ToolActivityRenderer[] = Object.freeze(renderers.map((renderer): ToolActivityRenderer => ({
  ...renderer,
  priority: -1,
  matches: (tool, context) => tool.runtimeAdapterId === 'matcha-agent'
    && !tool.name.includes('__') && renderer.matches(tool, context),
})));
