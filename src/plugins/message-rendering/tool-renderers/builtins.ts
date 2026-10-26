import type { ToolActivityRenderer } from './types';
import { MATCHA_AGENT_TOOL_ACTIVITY_RENDERERS } from './matcha-agent';
import { buildOpenClawToolActivityContent, describeOpenClawToolActivity } from './openclaw';
import { mergeOpenClawDetails } from './openclaw-projection';

export const OPENCLAW_TOOL_ACTIVITY_RENDERER: ToolActivityRenderer = {
  name: 'generic',
  priority: -1,
  matches: (tool) => tool.runtimeAdapterId === 'openclaw',
  describe: describeOpenClawToolActivity,
  buildContent: (tool, t) => mergeOpenClawDetails(tool, buildOpenClawToolActivityContent(tool, t), t),
};

export const BUILTIN_TOOL_RENDERERS: readonly ToolActivityRenderer[] = Object.freeze([
  OPENCLAW_TOOL_ACTIVITY_RENDERER,
  ...MATCHA_AGENT_TOOL_ACTIVITY_RENDERERS,
]);
