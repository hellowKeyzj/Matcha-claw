import { contribute, definePlugin, lazyWithPreload } from '@/plugin-host/core';
import { markdownExtensions, messageParts, toolRenderers, type MessagePartProps } from './extensions';

const ThinkingPart = lazyWithPreload<MessagePartProps>(() => import('./message-part-renderers').then((module) => ({ default: module.ThinkingPart })));
const ToolPart = lazyWithPreload<MessagePartProps>(() => import('./message-part-renderers').then((module) => ({ default: module.ToolPart })));
const TextPart = lazyWithPreload<MessagePartProps>(() => import('./message-part-renderers').then((module) => ({ default: module.TextPart })));
const MediaPart = lazyWithPreload<MessagePartProps>(() => import('./message-part-renderers').then((module) => ({ default: module.MediaPart })));

export const messageRenderingPlugin = definePlugin({
  id: 'message-rendering',
  requires: ['app-shell'],
  extensionPoints: [toolRenderers, messageParts, markdownExtensions],
  contributes: [
    contribute(toolRenderers, { id: 'openclaw', priority: -1, load: () => import('./tool-renderers/builtins').then((module) => module.OPENCLAW_TOOL_ACTIVITY_RENDERER) }),
    ...['file', 'shell', 'web', 'search', 'skill', 'agent'].map((name) => contribute(toolRenderers, {
      id: `matcha-agent.${name}`,
      priority: -1,
      load: () => import('./tool-renderers/matcha-agent').then((module) => module.MATCHA_AGENT_TOOL_ACTIVITY_RENDERERS.find((renderer) => renderer.name === name)!),
    })),
    contribute(messageParts, { kind: 'thinking', priority: -1, component: ThinkingPart }),
    contribute(messageParts, { kind: 'tool', priority: -1, component: ToolPart }),
    contribute(messageParts, { kind: 'message', priority: -1, component: TextPart }),
    contribute(messageParts, { kind: 'media', priority: -1, component: MediaPart }),
    ...['details', 'math', 'code'].map((id) => contribute(markdownExtensions, {
      id,
      load: () => import('./md-rules').then((module) => module.BUILTIN_MARKDOWN_EXTENSIONS.find((extension) => extension.id === id)!),
    })),
  ],
});
