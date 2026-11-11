import type { DocumentResource } from '../documents/model';
import { posix } from 'node:path';
import { readRemoteImage } from './remote-image';

export async function withMarkdownEditor<T>(markdown: string, operation: (editor: import('@tiptap/core').Editor) => Promise<T>): Promise<T> {
  const { ensureDom } = await import('../platform/replacements/dom');
  await ensureDom();
  const [{ Editor }, { buildExtensions }, { parseMarkdownToNodes }, { parseDocText }] = await Promise.all([
    import('@tiptap/core'),
    import('../../genoffice/apps/markdown/src/renderer/editor/extensions'),
    import('../../genoffice/apps/markdown/src/renderer/editor/ops'),
    import('../../genoffice/apps/markdown/src/renderer/markdown/docText')
  ]);
  const editor = new Editor({
    // Conversion needs the original schema/parser, not a mounted view with browser IPC plugins.
    element: null,
    extensions: buildExtensions({ slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} }, slashItems: () => [] }),
    content: ''
  });
  try {
    const nodes = parseMarkdownToNodes(editor, parseDocText(markdown).body);
    editor.commands.setContent({ type: 'doc', content: nodes.map((node) => node.toJSON()) });
    return await operation(editor);
  } finally { editor.destroy(); }
}

export async function imageResource(source: string, resources: readonly DocumentResource[]) {
  if (/^https?:\/\//i.test(source)) {
    const image = await readRemoteImage(source);
    return { path: `image.${image.mime.split('/')[1]!.replace('svg+xml', 'svg')}`, bytes: new Uint8Array(Buffer.from(image.base64, 'base64')) };
  }
  let path: string;
  try { path = decodeURIComponent(source); } catch { path = source; }
  const data = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(path);
  if (data) return { path: `image.${data[1]!.split('/')[1]!.replace('svg+xml', 'svg')}`, bytes: new Uint8Array(Buffer.from(data[2]!, 'base64')) };
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('/')) return undefined;
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  if (normalized.startsWith('../')) return undefined;
  return resources.find((resource) => resource.path === normalized);
}
