import type {
  SessionRenderToolCard,
  SessionRenderToolRuntimeAdapterId,
} from '../../../types/session/tool-card';
import type { ToolActivityViewModel } from '../tool-activity-view-model';

export const KNOWN_TOOL_NAMES = [
  'file',
  'shell',
  'search',
  'skill',
  'agent',
  'web',
  'progress_card',
  'generic',
] as const;

export type KnownToolName = (typeof KNOWN_TOOL_NAMES)[number];

export interface ToolRendererContext {
  readonly normalizedName: string;
  readonly knownName: KnownToolName | null;
  readonly runtimeAdapterId: SessionRenderToolRuntimeAdapterId | null;
}

export interface ToolActivityRenderer {
  readonly name: KnownToolName;
  readonly matches: (tool: SessionRenderToolCard, context: ToolRendererContext) => boolean;
  readonly buildViewModel: (tool: SessionRenderToolCard, context: ToolRendererContext) => ToolActivityViewModel;
}

export type GenericToolActivityRenderer = ToolActivityRenderer & {
  readonly name: 'generic';
};

const KNOWN_TOOL_NAME_MATCHERS: Readonly<Record<Exclude<KnownToolName, 'generic'>, readonly string[]>> = {
  file: ['write', 'edit', 'multiedit', 'notebookedit', 'filewrite', 'fileedit'],
  shell: ['bash', 'shell', 'terminal', 'powershell', 'pwsh', 'cmd', 'exec', 'runcommand'],
  search: ['read', 'grep', 'glob', 'rg', 'ripgrep', 'search', 'find', 'ls', 'list'],
  skill: ['skill', 'slashcommand', 'commandloader', 'loadskill'],
  agent: ['agent', 'task', 'subagent', 'delegate', 'taskoutput', 'taskstop', 'sendmessage'],
  web: ['webfetch', 'websearch', 'fetch', 'browser', 'searchweb', 'openurl'],
  progress_card: ['progresscard'],
};

export function normalizeToolName(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function matchKnownToolName(normalizedName: string): KnownToolName | null {
  for (const [knownName, candidates] of Object.entries(KNOWN_TOOL_NAME_MATCHERS) as Array<[
    Exclude<KnownToolName, 'generic'>,
    readonly string[],
  ]>) {
    if (candidates.some((candidate) => normalizedName.includes(candidate))) {
      return knownName;
    }
  }
  return null;
}

export function createToolRendererContext(tool: SessionRenderToolCard): ToolRendererContext {
  const normalizedName = normalizeToolName(tool.name);
  return {
    normalizedName,
    knownName: matchKnownToolName(normalizedName),
    runtimeAdapterId: tool.runtimeAdapterId ?? null,
  };
}

export function matchesKnownToolName(
  context: ToolRendererContext,
  knownName: Exclude<KnownToolName, 'generic'>,
): boolean {
  return context.knownName === knownName;
}
