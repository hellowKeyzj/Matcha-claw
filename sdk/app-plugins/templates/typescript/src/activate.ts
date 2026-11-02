import type { AppPluginContext } from '@matcha/app-plugins-sdk';

export function activate(context: AppPluginContext): () => void {
  return context.registerTool('echo', async (arguments_, call) => {
    call.signal.throwIfAborted();
    const text = arguments_.text;
    if (typeof text !== 'string' || text.length > 2000) throw new Error('text must be a string of at most 2000 characters.');
    return { content: [{ type: 'text', text }], structuredContent: { text } };
  });
}
