import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, Paintbrush, Redo2, SquareDashed, Trash2, Undo2, X } from 'lucide-react';
import type { ImageLayer } from '../document';
import { errorMessage, fileData, isExternalApp } from './api';
import { useTranslation } from './i18n';

interface Props {
  image: HTMLImageElement;
  mode: 'brush' | 'rectangle';
  transform: string;
  width: number;
  height: number;
  sourceRect?: ImageLayer['crop'];
  canDraw: boolean;
  disabled: boolean;
  confirmLabel?: string;
  onConfirm(data: string): Promise<void>;
  onCancel(): void;
}

type Point = { x: number; y: number };
type BrushStroke = { points: Point[]; sizeX: number; sizeY: number };
type BrushAction = { type: 'stroke'; stroke: BrushStroke } | { type: 'clear' };

function clipSource(context: CanvasRenderingContext2D, sourceRect: ImageLayer['crop']) {
  if (!sourceRect) return;
  context.beginPath();
  context.rect(sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height);
  context.clip();
}

function paintBrush(context: CanvasRenderingContext2D, points: Point[], { sizeX, sizeY }: BrushStroke, sourceRect: ImageLayer['crop']) {
  context.save();
  clipSource(context, sourceRect);
  // Normalize the natural-pixel ellipse to a circle; the layer transform restores viewport CSS px.
  context.scale(sizeX, sizeY);
  context.fillStyle = context.strokeStyle = 'rgb(124,58,237)';
  context.lineWidth = 1;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.setLineDash([]);
  context.beginPath();
  const first = points[0];
  if (points.length === 1) { context.arc(first.x / sizeX, first.y / sizeY, .5, 0, Math.PI * 2); context.fill(); }
  else {
    context.moveTo(first.x / sizeX, first.y / sizeY);
    for (let index = 1; index < points.length; index++) context.lineTo(points[index].x / sizeX, points[index].y / sizeY);
    context.stroke();
  }
  context.restore();
}

export function Annotation({ image, mode, transform, width, height, sourceRect, canDraw, disabled, confirmLabel, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const overlay = useRef<HTMLCanvasElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const marked = useRef(false);
  const point = useRef({ x: 0, y: 0 });
  const history = useRef<{ actions: BrushAction[]; cursor: number }>({ actions: [], cursor: 0 });
  const draft = useRef<BrushStroke | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const [brush, setBrush] = useState(24);
  const [hasSelection, setHasSelection] = useState(false);
  const [historyPosition, setHistoryPosition] = useState({ cursor: 0, length: 0 });
  const [drawing, setDrawing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const blocked = disabled || adding;
  const external = isExternalApp();
  const instruction = t(mode === 'rectangle' ? '框选需要修改的区域' : '涂抹需要修改的区域');
  const label = adding ? t(confirmLabel === undefined ? '添加中…' : '处理中…') : confirmLabel ?? t(external ? '添加到客户端对话' : '添加到对话');
  const confirmTitle = external && confirmLabel === undefined ? t('由客户端处理添加到对话的请求，宿主可能立即开始模型响应。') : t('确认选区');

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (submitting.current && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if ((event.target as HTMLElement).closest('input:not([type="range"]),textarea,select,[contenteditable="true"]')) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (mode === 'brush') travel(key === 'y' || event.shiftKey ? 1 : -1);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  useLayoutEffect(() => {
    const canvas = overlay.current!;
    const id = pointer.current;
    pointer.current = null;
    if (id !== null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    if (cursor.current) cursor.current.style.visibility = 'hidden';
    marked.current = false;
    draft.current = null;
    history.current = { actions: [], cursor: 0 };
    setHistoryPosition({ cursor: 0, length: 0 });
    setDrawing(false);
    setHasSelection(false);
    setError('');
  }, [image, mode]);

  const remember = useCallback((action: BrushAction) => {
    const current = history.current;
    current.actions.splice(current.cursor);
    current.actions.push(action);
    current.cursor++;
    setHistoryPosition({ cursor: current.cursor, length: current.actions.length });
  }, []);

  const finish = useCallback((event?: React.PointerEvent<HTMLCanvasElement>) => {
    const id = pointer.current;
    if (id === null || (event && event.pointerId !== id)) return;
    pointer.current = null;
    if (draft.current?.points.length) remember({ type: 'stroke', stroke: draft.current });
    draft.current = null;
    setDrawing(false);
    setHasSelection(marked.current);
    if (overlay.current?.hasPointerCapture(id)) overlay.current.releasePointerCapture(id);
  }, [remember]);

  useLayoutEffect(() => { finish(); }, [transform, width, height, finish]);
  useLayoutEffect(() => {
    if (!canDraw || blocked) {
      finish();
      if (cursor.current) cursor.current.style.visibility = 'hidden';
    }
  }, [canDraw, blocked, finish]);
  useEffect(() => {
    const blur = () => { finish(); if (cursor.current) cursor.current.style.visibility = 'hidden'; };
    window.addEventListener('blur', blur);
    return () => window.removeEventListener('blur', blur);
  }, [finish]);

  function travel(direction: -1 | 1) {
    if (mode !== 'brush' || blocked || submitting.current || pointer.current !== null) return;
    const current = history.current;
    const cursor = current.cursor + direction;
    if (cursor < 0 || cursor > current.actions.length) return;
    const canvas = overlay.current!;
    const context = canvas.getContext('2d');
    if (!context) { setError(t('无法生成参考预览，请重试。')); return; }
    // ponytail: history jumps repaint since the last clear; narrow dirty bounds only if measured canvas cost requires it.
    let start = cursor;
    while (start > 0 && current.actions[start - 1].type !== 'clear') start--;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (let index = start; index < cursor; index++) {
      const action = current.actions[index];
      if (action.type === 'stroke') paintBrush(context, action.stroke.points, action.stroke, sourceRect);
    }
    current.cursor = cursor;
    marked.current = cursor > start;
    setHistoryPosition({ cursor, length: current.actions.length });
    setHasSelection(marked.current);
    setError('');
  }

  function clear() {
    if (blocked || submitting.current || !marked.current || pointer.current !== null) return;
    const canvas = overlay.current!;
    const context = canvas.getContext('2d');
    if (!context) { setError(t('无法生成参考预览，请重试。')); return; }
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (mode === 'brush') remember({ type: 'clear' });
    marked.current = false;
    setHasSelection(false);
    setError('');
  }

  function position(event: React.PointerEvent<HTMLCanvasElement>) {
    const box = event.currentTarget.closest('.canvas-surface')!.getBoundingClientRect();
    // Client CSS px → viewport CSS px → layer-local units → natural image px.
    const local = new DOMPoint(event.clientX - box.left, event.clientY - box.top).matrixTransform(new DOMMatrix(transform).inverse());
    const source = sourceRect ?? { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
    return { x: Math.max(source.x, Math.min(source.x + source.width, local.x * image.naturalWidth / width)), y: Math.max(source.y, Math.min(source.y + source.height, local.y * image.naturalHeight / height)) };
  }

  function moveCursor(event: React.PointerEvent<HTMLCanvasElement>) {
    const element = cursor.current;
    if (!element) return;
    if (!canDraw || blocked || event.pointerType === 'touch') { element.style.visibility = 'hidden'; return; }
    const box = event.currentTarget.closest('.canvas-surface')!.getBoundingClientRect();
    // Cursor lives in viewport CSS px, outside the transformed natural-pixel overlay.
    element.style.transform = `translate(${event.clientX - box.left - brush / 2}px, ${event.clientY - box.top - brush / 2}px)`;
    element.style.visibility = 'visible';
  }

  function stroke(next: Point, dot = false) {
    const context = overlay.current!.getContext('2d');
    if (!context) { setError(t('无法生成参考预览，请重试。')); return; }
    context.fillStyle = context.strokeStyle = 'rgb(124,58,237)';
    if (mode === 'rectangle') {
      context.clearRect(0, 0, context.canvas.width, context.canvas.height);
      const x = Math.min(point.current.x, next.x);
      const y = Math.min(point.current.y, next.y);
      const w = Math.abs(next.x - point.current.x);
      const h = Math.abs(next.y - point.current.y);
      marked.current = w >= 1 && h >= 1;
      if (!marked.current) return;
      context.save();
      clipSource(context, sourceRect);
      context.fillStyle = 'rgba(124,58,237,.18)';
      context.fillRect(x, y, w, h);
      context.lineWidth = Math.max(2, Math.min(image.naturalWidth, image.naturalHeight) / 300);
      context.setLineDash([context.lineWidth * 4, context.lineWidth * 3]);
      context.strokeRect(x, y, w, h);
      context.restore();
      return;
    }
    const current = draft.current;
    if (!current) return;
    if (!dot && next.x === point.current.x && next.y === point.current.y) return;
    paintBrush(context, dot ? [next] : [point.current, next], current, sourceRect);
    current.points.push(next);
    marked.current = true;
    point.current = next;
  }

  async function confirm() {
    if (blocked || submitting.current || !marked.current || pointer.current !== null) return;
    submitting.current = true;
    setAdding(true);
    setError('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(t('无法生成参考预览，请重试。'));
      context.drawImage(image, 0, 0);
      clipSource(context, sourceRect);
      context.globalAlpha = mode === 'brush' ? .38 : 1;
      context.drawImage(overlay.current!, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(t('无法生成参考预览，请重试。'))), 'image/png'));
      const data = await fileData(blob);
      if (mounted.current) await onConfirm(data);
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { submitting.current = false; if (mounted.current) setAdding(false); }
  }

  return <div className="annotation-editor">
    <div className="annotation-toolbar" role="toolbar" aria-label={t('局部修改选区')} aria-busy={adding} title={instruction} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()} onTouchStart={(event) => event.stopPropagation()}>
      <span className="annotation-hint">{mode === 'rectangle' ? <SquareDashed size={15} /> : <Paintbrush size={15} />}<span>{instruction}</span></span>
      {mode === 'brush' && <label className="brush-field"><span>{t('画笔 {size}px（视口）', { size: brush })}</span><input aria-label={t('画笔大小')} title={t('画笔 {size}px（视口）', { size: brush })} type="range" min={1} max={100} step={1} value={brush} disabled={blocked || drawing} onChange={(event) => setBrush(Number(event.target.value))} /></label>}
      <div className="annotation-actions">
        {mode === 'brush' && <>
          <button type="button" className="icon small" aria-label={t('撤销标注')} title={t('撤销标注 Ctrl/⌘ Z')} disabled={blocked || drawing || historyPosition.cursor === 0} onClick={() => travel(-1)}><Undo2 size={15} /></button>
          <button type="button" className="icon small" aria-label={t('重做标注')} title={t('重做标注 Ctrl/⌘ Shift Z')} disabled={blocked || drawing || historyPosition.cursor === historyPosition.length} onClick={() => travel(1)}><Redo2 size={15} /></button>
        </>}
        <button type="button" className="icon small" aria-label={t('清空选区')} title={t('清空选区')} disabled={blocked || drawing || !hasSelection} onClick={clear}><Trash2 size={15} /></button>
        <button type="button" className="ic-tool-btn annotation-cancel" aria-label={t('取消选区')} title={t('取消选区')} disabled={blocked} onClick={onCancel}><X size={15} /><span>{t('取消选区')}</span></button>
        <button type="button" className="primary" aria-label={`${t('确认选区')} · ${label}`} title={confirmTitle} disabled={blocked || drawing || !hasSelection} onClick={() => void confirm()}><Check size={15} />{label}</button>
      </div>
      {error && <p className="annotation-error inline-error" role="alert">{error}</p>}
    </div>
    <div className={`annotation-image${mode === 'brush' ? ' annotation-brush' : ''}`} style={{ width, height, transform, pointerEvents: canDraw && !blocked ? 'auto' : 'none' }}>
      <canvas ref={overlay} aria-label={t('选区标注区域')} style={{ cursor: mode === 'brush' ? 'none' : undefined }} onPointerDown={(event) => {
        if (!canDraw || blocked || submitting.current || event.button !== 0 || pointer.current !== null) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        pointer.current = event.pointerId;
        // The slider is viewport CSS px; history and rasterization stay in natural image px.
        const matrix = new DOMMatrix(transform);
        const scaleX = width / image.naturalWidth * Math.hypot(matrix.a, matrix.b);
        const scaleY = height / image.naturalHeight * Math.hypot(matrix.c, matrix.d);
        draft.current = mode === 'brush' ? { points: [], sizeX: brush / scaleX, sizeY: brush / scaleY } : null;
        moveCursor(event);
        setDrawing(true);
        setHasSelection(false);
        setError('');
        point.current = position(event);
        stroke(point.current, true);
      }} onPointerMove={(event) => { moveCursor(event); if (pointer.current === event.pointerId && canDraw && !blocked) stroke(position(event)); }} onPointerUp={(event) => { if (pointer.current !== event.pointerId) return; if (canDraw && !blocked) stroke(position(event)); finish(event); }} onPointerCancel={(event) => { finish(event); if (cursor.current) cursor.current.style.visibility = 'hidden'; }} onLostPointerCapture={finish} onPointerEnter={moveCursor} onPointerLeave={() => { if (cursor.current) cursor.current.style.visibility = 'hidden'; }} />
    </div>
    {mode === 'brush' && <div ref={cursor} aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, width: brush, height: brush, border: '2px solid rgba(124,58,237,.7)', borderRadius: '50%', pointerEvents: 'none', visibility: 'hidden' }} />}
  </div>;
}
