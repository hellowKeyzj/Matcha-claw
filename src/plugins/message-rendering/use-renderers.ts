import { use } from 'react';
import { useContributions } from '@/plugin-host/react';
import { markdownExtensions, toolRenderers, type MarkdownContribution, type MarkdownExtension, type ToolRendererContribution } from './extensions';
import { BUILTIN_MARKDOWN_EXTENSIONS } from './md-rules';
import type { ToolActivityRenderer } from './tool-renderers/types';

const markdownLoads = new WeakMap<readonly MarkdownContribution[], Promise<readonly MarkdownExtension[]>>();
const toolLoads = new WeakMap<readonly ToolRendererContribution[], Promise<readonly ToolActivityRenderer[]>>();

export function useMarkdownExtensions(): readonly MarkdownExtension[] {
  const contributions = useContributions(markdownExtensions);
  let loaded = markdownLoads.get(contributions);
  if (!loaded) {
    loaded = Promise.all(contributions.map((entry) => entry.load())).then((extensions) => (
      extensions.length === BUILTIN_MARKDOWN_EXTENSIONS.length
      && extensions.every((extension, index) => extension === BUILTIN_MARKDOWN_EXTENSIONS[index])
        ? BUILTIN_MARKDOWN_EXTENSIONS : Object.freeze(extensions)
    ));
    markdownLoads.set(contributions, loaded);
  }
  return use(loaded);
}

export function useToolRenderers(): readonly ToolActivityRenderer[] {
  const contributions = useContributions(toolRenderers);
  let loaded = toolLoads.get(contributions);
  if (!loaded) {
    loaded = Promise.all(contributions.map(async (entry) => {
      const renderer = await entry.load();
      return { ...renderer, priority: entry.priority ?? 0 };
    })).then((renderers) => Object.freeze(renderers));
    toolLoads.set(contributions, loaded);
  }
  return use(loaded);
}
