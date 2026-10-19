// Adapted from OpenClaw ui/src/pages/chat/components/widget-export.ts.
// Copyright (c) 2026 OpenClaw Foundation. SPDX-License-Identifier: MIT.
// See tool-renderers/openclaw/LICENSE and tool-renderers/openclaw/NOTICE.
import { WidgetImageError, type RuntimeContentHandle } from '@/components/runtime-surfaces/content-snapshot';
export { WidgetImageError } from '@/components/runtime-surfaces/content-snapshot';

export async function exportWidgetImage(
  action: 'copy' | 'download',
  content: RuntimeContentHandle,
  title: string,
  signal: AbortSignal,
): Promise<void> {
  if (action === 'copy' && (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')) {
    throw new WidgetImageError('clipboardUnavailable');
  }
  const snapshot = content.snapshot(signal);
  if (action === 'copy') {
    // Supply the promise during the click, before awaiting the snapshot loses transient activation.
    void snapshot.catch(() => {});
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': snapshot })]);
    return;
  }
  const blob = await snapshot;
  signal.throwIfAborted();
  const stem = Array.from(title.trim(), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 || '<>:"/\\|?*'.includes(character) ? '-' : character;
  }).slice(0, 120).join('').replace(/\s+/gu, '-').replace(/^[. -]+|[. -]+$/gu, '') || 'widget';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  try {
    anchor.href = url;
    anchor.download = `${stem}.png`;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
