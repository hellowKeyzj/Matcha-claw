import { useEffect, useId, useRef, useState } from 'react';
import { Check, Crop, Redo2, RotateCcw, Undo2, X } from 'lucide-react';
import type { ImageLayer, LayerPatch } from '../document';
import { errorMessage } from './api';
import { useTranslation } from './i18n';

type Rect = NonNullable<ImageLayer['crop']>;
type Draft = { rect: Rect; ratio: 'free' | 'original' };
type Handle = 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
interface Props {
  image: HTMLImageElement;
  layer: ImageLayer;
  revision: number;
  /** Original asset pixels → canvas viewport CSS pixels, including crop, flip and stage. */
  transform: string;
  canInteract: boolean;
  disabled: boolean;
  onConfirm(changes: LayerPatch): Promise<boolean>;
  onCancel(): void;
}

const handles = { nw: '左上角', n: '上边', ne: '右上角', e: '右边', se: '右下角', s: '下边', sw: '左下角', w: '左边' } as const;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function CropEditor({ image, layer, revision, transform, canInteract, disabled, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const clipId = useId();
  const initial = useRef({ layer, revision });
  const full = { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
  const [draft, setDraft] = useState<Draft>(() => ({ rect: layer.crop ?? full, ratio: 'free' }));
  const history = useRef({ entries: [draft], cursor: 0 });
  const [historyPosition, setHistoryPosition] = useState({ cursor: 0, length: 1 });
  const pointer = useRef<{ id: number; element: SVGSVGElement; handle: Handle; point: { x: number; y: number }; draft: Draft } | null>(null);
  const [dragging, setDragging] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const latestRevision = useRef(revision);
  latestRevision.current = revision;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const invalid = initial.current.revision !== revision;
  const blocked = disabled || saving || invalid;
  const matrix = new DOMMatrix(transform);
  const scaleX = Math.hypot(matrix.a, matrix.b);
  const scaleY = Math.hypot(matrix.c, matrix.d);
  const rect = draft.rect;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => { if (invalid && !submitting.current) onCancel(); }, [invalid, onCancel]);

  function remember(next: Draft) {
    const current = history.current;
    if (JSON.stringify(current.entries[current.cursor]) === JSON.stringify(next)) return;
    current.entries.splice(current.cursor + 1);
    current.entries.push(next);
    current.cursor++;
    setHistoryPosition({ cursor: current.cursor, length: current.entries.length });
    setDraft(next);
    setError('');
  }

  function travel(direction: -1 | 1) {
    if (blocked || submitting.current || pointer.current) return;
    const current = history.current;
    const cursor = current.cursor + direction;
    if (cursor < 0 || cursor >= current.entries.length) return;
    current.cursor = cursor;
    setDraft(current.entries[cursor]);
    setHistoryPosition({ cursor, length: current.entries.length });
    setError('');
  }

  function position(event: React.PointerEvent<SVGSVGElement>) {
    const box = event.currentTarget.closest('.canvas-surface')!.getBoundingClientRect();
    return new DOMPoint(event.clientX - box.left, event.clientY - box.top).matrixTransform(new DOMMatrix(transform).inverse());
  }

  function resized(start: Rect, handle: Handle, dx: number, dy: number, ratio: Draft['ratio']): Rect {
    if (handle === 'move') return { ...start, x: clamp(start.x + dx, 0, full.width - start.width), y: clamp(start.y + dy, 0, full.height - start.height) };
    let left = start.x;
    let right = start.x + start.width;
    let top = start.y;
    let bottom = start.y + start.height;
    if (handle.includes('w')) left = clamp(left + dx, 0, right - 1);
    if (handle.includes('e')) right = clamp(right + dx, left + 1, full.width);
    if (handle.includes('n')) top = clamp(top + dy, 0, bottom - 1);
    if (handle.includes('s')) bottom = clamp(bottom + dy, top + 1, full.height);
    if (ratio === 'original') {
      const aspect = full.width / full.height;
      const horizontal = handle.includes('w') || handle.includes('e');
      const vertical = handle.includes('n') || handle.includes('s');
      const fixedX = handle.includes('w') ? start.x + start.width : horizontal ? start.x : start.x + start.width / 2;
      const fixedY = handle.includes('n') ? start.y + start.height : vertical ? start.y : start.y + start.height / 2;
      const maxWidth = horizontal ? handle.includes('w') ? fixedX : full.width - fixedX : Math.min(fixedX, full.width - fixedX) * 2;
      const maxHeight = vertical ? handle.includes('n') ? fixedY : full.height - fixedY : Math.min(fixedY, full.height - fixedY) * 2;
      const requested = horizontal && vertical ? Math.max(right - left, (bottom - top) * aspect) : horizontal ? right - left : (bottom - top) * aspect;
      const width = Math.min(maxWidth, maxHeight * aspect, Math.max(Math.max(1, aspect), requested));
      const height = width / aspect;
      left = handle.includes('w') ? fixedX - width : horizontal ? fixedX : fixedX - width / 2;
      top = handle.includes('n') ? fixedY - height : vertical ? fixedY : fixedY - height / 2;
      right = left + width;
      bottom = top + height;
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function finish(event?: React.PointerEvent<SVGSVGElement>, cancel = false) {
    const active = pointer.current;
    if (!active || (event && active.id !== event.pointerId)) return;
    pointer.current = null;
    if (cancel) setDraft(active.draft);
    else if (event) {
      const point = position(event);
      remember({ ...active.draft, rect: resized(active.draft.rect, active.handle, point.x - active.point.x, point.y - active.point.y, active.draft.ratio) });
    }
    setDragging(false);
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
  }

  useEffect(() => { if (!canInteract || blocked) finish(undefined, true); });
  useEffect(() => {
    const blur = () => finish(undefined, true);
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  });

  async function confirm() {
    if (blocked || submitting.current || pointer.current) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    const before = initial.current.layer;
    const source = before.crop ?? full;
    const sx = before.width / source.width;
    const sy = before.height / source.height;
    // Keep every retained source pixel at the same world position, even after a center flip.
    const dx = (before.flipX ? source.x + source.width - rect.x - rect.width : rect.x - source.x) * sx;
    const dy = (before.flipY ? source.y + source.height - rect.y - rect.height : rect.y - source.y) * sy;
    const angle = before.rotation * Math.PI / 180;
    try {
      await onConfirm({ crop: rect, lockAspectRatio: true, width: rect.width * sx, height: rect.height * sy,
        x: before.x + Math.cos(angle) * dx - Math.sin(angle) * dy,
        y: before.y + Math.sin(angle) * dx + Math.cos(angle) * dy });
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally {
      submitting.current = false;
      if (mounted.current) {
        setSaving(false);
        if (latestRevision.current !== initial.current.revision) onCancel();
      }
    }
  }

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!blocked && !submitting.current) { finish(undefined, true); onCancel(); }
      } else if (command && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopImmediatePropagation();
        travel(event.key.toLowerCase() === 'y' || event.shiftKey ? 1 : -1);
      } else if (event.key === 'Enter' && !target.closest('button,input,select,textarea')) {
        event.preventDefault(); event.stopImmediatePropagation(); void confirm();
      } else if (target.closest('.ic-crop-image') && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (blocked || !canInteract || pointer.current) return;
        const handle = (target.dataset.cropHandle ?? 'move') as Handle;
        const distance = event.shiftKey ? 10 : 1;
        const inverse = new DOMMatrix(transform).inverse();
        const delta = new DOMPoint(event.key === 'ArrowLeft' ? -distance : event.key === 'ArrowRight' ? distance : 0, event.key === 'ArrowUp' ? -distance : event.key === 'ArrowDown' ? distance : 0).matrixTransform(inverse);
        remember({ ...draft, rect: resized(rect, handle, delta.x - inverse.e, delta.y - inverse.f, draft.ratio) });
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  return <div className="ic-crop-editor">
    <div className="ic-crop-toolbar" role="toolbar" aria-label={t('裁剪图片')} aria-busy={saving} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}>
      <span className="annotation-hint"><Crop size={15} /><span>{t('裁剪图片')}</span></span>
      <select aria-label={t('裁剪比例')} value={draft.ratio} disabled={blocked || dragging} onChange={(event) => {
        const ratio = event.target.value as Draft['ratio'];
        const aspect = full.width / full.height;
        const width = Math.min(rect.width, rect.height * aspect);
        const height = width / aspect;
        remember({ ratio, rect: ratio === 'free' ? rect : { x: rect.x + (rect.width - width) / 2, y: rect.y + (rect.height - height) / 2, width, height } });
      }}><option value="free">{t('自由裁剪')}</option><option value="original">{t('原图比例')}</option></select>
      <span className="ic-crop-size" aria-live="polite">{t('{width}×{height} 像素', { width: Math.round(rect.width), height: Math.round(rect.height) })}</span>
      <div className="annotation-actions">
        <button type="button" className="icon small" aria-label={t('撤销裁剪')} title={t('撤销裁剪 Ctrl/⌘ Z')} disabled={blocked || dragging || historyPosition.cursor === 0} onClick={() => travel(-1)}><Undo2 size={15} /></button>
        <button type="button" className="icon small" aria-label={t('重做裁剪')} title={t('重做裁剪 Ctrl/⌘ Shift Z')} disabled={blocked || dragging || historyPosition.cursor === historyPosition.length - 1} onClick={() => travel(1)}><Redo2 size={15} /></button>
        <button type="button" className="icon small" aria-label={t('恢复原图')} title={t('恢复原图')} disabled={blocked || dragging} onClick={() => remember({ rect: full, ratio: draft.ratio })}><RotateCcw size={15} /></button>
        <button type="button" className="ic-tool-btn" disabled={blocked} onClick={onCancel}><X size={15} />{t('取消')}</button>
        <button type="button" className="primary" disabled={blocked || dragging} onClick={() => void confirm()}><Check size={15} />{t(saving ? '保存中…' : '确认裁剪')}</button>
      </div>
      {error && <p className="annotation-error inline-error" role="alert">{error}</p>}
    </div>
    <svg className="ic-crop-image" width={full.width} height={full.height} viewBox={`0 0 ${full.width} ${full.height}`} style={{ transform, opacity: layer.opacity, pointerEvents: canInteract && !blocked ? 'auto' : 'none' }} aria-label={t('裁剪选区，方向键移动，Enter 确认，Escape 取消')} onPointerDown={(event) => {
      if (event.button !== 0 || !canInteract || blocked || pointer.current) return;
      const handle = (event.target as SVGElement).dataset.cropHandle as Handle | undefined;
      if (!handle) return;
      event.preventDefault(); event.stopPropagation();
      (event.target as SVGElement).focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      pointer.current = { id: event.pointerId, element: event.currentTarget, handle, point: position(event), draft };
      setDragging(true); setError('');
    }} tabIndex={0} onPointerMove={(event) => {
      const active = pointer.current;
      if (!active || active.id !== event.pointerId || !canInteract || blocked) return;
      const point = position(event);
      setDraft({ ...active.draft, rect: resized(active.draft.rect, active.handle, point.x - active.point.x, point.y - active.point.y, active.draft.ratio) });
    }} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => finish(event, true)}>
      <defs><clipPath id={clipId}><rect {...rect} /></clipPath></defs>
      <image href={image.src} width={full.width} height={full.height} opacity={0.3} pointerEvents="none" />
      <image href={image.src} width={full.width} height={full.height} clipPath={`url(#${clipId})`} pointerEvents="none" />
      <rect {...rect} data-crop-handle="move" className="ic-crop-window" vectorEffect="non-scaling-stroke" tabIndex={0} role="button" aria-label={t('移动裁剪选区')} />
      {[1 / 3, 2 / 3].map((fraction) => <g key={fraction} className="ic-crop-grid" pointerEvents="none"><line x1={rect.x + rect.width * fraction} y1={rect.y} x2={rect.x + rect.width * fraction} y2={rect.y + rect.height} vectorEffect="non-scaling-stroke" /><line x1={rect.x} y1={rect.y + rect.height * fraction} x2={rect.x + rect.width} y2={rect.y + rect.height * fraction} vectorEffect="non-scaling-stroke" /></g>)}
      {(Object.keys(handles) as (keyof typeof handles)[]).map((handle) => <rect key={handle} data-crop-handle={handle} x={rect.x + (handle.includes('w') ? 0 : handle.includes('e') ? rect.width : rect.width / 2) - 5 / scaleX} y={rect.y + (handle.includes('n') ? 0 : handle.includes('s') ? rect.height : rect.height / 2) - 5 / scaleY} width={10 / scaleX} height={10 / scaleY} className={`ic-crop-handle ic-crop-handle-${handle}`} vectorEffect="non-scaling-stroke" tabIndex={0} role="button" aria-label={t('调整裁剪选区 {handle}', { handle: t(handles[handle]) })} />)}
    </svg>
  </div>;
}
