import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Edit, ImageLayer, LayerPatch } from '../document';

type Preview = { source: ImageLayer; control: string; changes: LayerPatch; committed: boolean };

export function useImagePreview(layer: ImageLayer, busy: boolean, onEdit: (edits: Edit[]) => Promise<boolean>, onPreview?: (id: string, changes: LayerPatch | null) => void) {
  const current = useRef({ layer, busy, onEdit, onPreview });
  useLayoutEffect(() => { current.current = { layer, busy, onEdit, onPreview }; });
  const pending = useRef<Preview | null>(null);
  const frame = useRef<number | null>(null);
  const [draft, setDraft] = useState<Preview | null>(null);
  if (draft && (draft.source !== layer || ((busy || layer.locked) && !draft.committed))) setDraft(null);

  const cancelFrame = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const clear = useCallback((control?: string) => {
    if (control && (pending.current?.control !== control || pending.current.committed)) return;
    cancelFrame();
    pending.current = null;
    setDraft(null);
    current.current.onPreview?.(current.current.layer.id, null);
  }, [cancelFrame]);

  // Canonical replacement, not a preview-rendered layer, invalidates the gesture.
  useLayoutEffect(() => () => {
    cancelFrame();
    pending.current = null;
    current.current.onPreview?.(layer.id, null);
  }, [layer, cancelFrame]);
  useLayoutEffect(() => {
    if ((busy || layer.locked) && !pending.current?.committed) {
      cancelFrame();
      pending.current = null;
      current.current.onPreview?.(layer.id, null);
    }
  }, [busy, layer, cancelFrame]);

  function preview(control: string, changes: LayerPatch) {
    if (current.current.busy || layer.locked || pending.current?.committed || current.current.layer !== layer) return;
    const previous = pending.current;
    const next: Preview = { source: layer, control, changes: { ...(previous?.control === control ? previous.changes : {}), ...changes }, committed: false };
    pending.current = next;
    setDraft(next);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const next = pending.current;
      if (next && !next.committed && next.source === current.current.layer) current.current.onPreview?.(next.source.id, next.changes);
    });
  }

  function commit(control: string) {
    const preview = pending.current;
    if (!preview || preview.control !== control || preview.committed || preview.source !== current.current.layer || current.current.busy || layer.locked) return;
    const next = { ...preview, committed: true };
    pending.current = next;
    setDraft(next);
    cancelFrame();
    current.current.onPreview?.(layer.id, next.changes);
    void current.current.onEdit([{ type: 'patch', id: layer.id, changes: next.changes }]).finally(() => {
      if (pending.current === next) clear();
    });
  }

  function edit(control: string, changes: LayerPatch) { preview(control, changes); commit(control); }
  return { value: draft?.source === layer ? { ...layer, ...draft.changes } as ImageLayer : layer, preview, commit, clear, edit };
}

const confirmKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Enter', ' ']);
export function isImageControlConfirmKey(key: string): boolean { return confirmKeys.has(key); }
