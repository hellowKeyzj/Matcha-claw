import type { Editor } from '@tiptap/core';
import type { MindMapTreeNode } from '../../genoffice/packages/agent-core/src/types';
import { executeTool } from '../../genoffice/apps/markdown/src/renderer/ai/tools';
import { navigateToBlock } from '../../genoffice/apps/markdown/src/renderer/ai/doc-nav';
import { resolveQueueItem, selectionForAnchor } from '../../genoffice/apps/markdown/src/renderer/ai/edit-queue';
import { addQueueAnchor, removeQueueAnchors } from '../../genoffice/apps/markdown/src/renderer/editor/aiQueueAnchors';
import type { FrontmatterAccess } from '../../genoffice/apps/markdown/src/renderer/editor/ops';

let current: ((action: string, input: Record<string, unknown>) => Promise<unknown>) | undefined;
export function executeMarkdownAction(action: string, input: Record<string, unknown>) {
  if (!current) throw new Error('The Markdown document editor is not ready.');
  return current(action, input);
}
export function installMarkdownEditorActions(editor: Editor, fm: FrontmatterAccess, showMindMap: (tree: MindMapTreeNode) => void, flush: () => void) {
  const handler = async (action: string, input: Record<string, unknown>) => {
    flush();
    if (action === 'anchor_selection') {
      const { from, to, empty } = editor.state.selection;
      if (empty) throw new Error('Select a document passage first.');
      const qid = crypto.randomUUID();
      addQueueAnchor(editor, qid, from, to);
      return { qid, target: resolveQueueItem(editor, { qid, instruction: '', capturedText: '' }).target };
    }
    if (action === 'resolve_anchor') return resolveQueueItem(editor, { qid: String(input.qid), instruction: '', capturedText: '' }).target;
    if (action === 'remove_anchor') { removeQueueAnchors(editor, [String(input.qid)]); return { removed: true }; }
    if (action === 'focus_anchor') {
      const selection = selectionForAnchor(editor, String(input.qid));
      if (!selection) throw new Error('The anchored passage no longer exists.');
      editor.view.dispatch(editor.state.tr.setSelection(selection).scrollIntoView());
      editor.view.focus();
      return { focused: true };
    }
    if (action === 'navigate') { navigateToBlock(editor, Number(input.index)); return { focused: true }; }
    const result = await executeTool(editor, { id: crypto.randomUUID(), name: action, input }, undefined, fm);
    if (result.display?.kind === 'mindmap') {
      if (!result.display.tree) throw new Error('The mind map did not contain a tree.');
      showMindMap(result.display.tree);
    }
    return result;
  };
  current = handler;
  return () => { if (current === handler) current = undefined; };
}
