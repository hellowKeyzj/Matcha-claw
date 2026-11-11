import { appApi, base64ToBytes } from '../documents/client';
import { docsDialogLabels } from './labels';
import { showToast } from '../../genoffice/apps/docs/src/renderer/components/toast-bus';
import type { ClipboardPayload } from '../../genoffice/apps/docs/src/renderer/editor/paste-actions';

export function reportDocsClipboardError(error: unknown): void {
  console.error('[office:docs:clipboard]', error);
  showToast(docsDialogLabels().clipboardError, 'error');
}

export async function readDocsClipboard(): Promise<ClipboardPayload> {
  try {
    const content = await appApi().readClipboard();
    const image = content.image ? new Blob([base64ToBytes(content.image.data).slice().buffer], { type: content.image.mimeType }) : null;
    return { text: content.text ?? '', html: content.html ?? '', image };
  } catch (error) {
    reportDocsClipboardError(error);
    throw error;
  }
}

export async function copyDocsLink(text: string): Promise<void> {
  try { await appApi().writeClipboard({ text }); }
  catch (error) { reportDocsClipboardError(error); }
}
