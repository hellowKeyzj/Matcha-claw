import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Hand, Minus, MousePointer2, Play, Plus, Scan, SquareDashed, Type } from 'lucide-react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CanvasIcon } from './CanvasIcon';
import { Annotation } from './Annotation';
import { CropEditor } from './CropEditor';
import { VideoDisplay } from './VideoDisplay';
import './canvas-media.css';
import type { LoadedAsset } from './useAssets';
import { errorMessage } from './api';
import { useTranslation } from './i18n';
import type { DesignDocument, Edit, GenerationRecord, ImageLayer, LayerPatch, TextLayer } from '../document';
import { createScene } from '../scene';

export interface CanvasView {
  center: { x: number; y: number };
  selection: { x: number; y: number; width: number; height: number } | null;
  width: number;
  height: number;
  clientToWorld?(clientX: number, clientY: number): { x: number; y: number };
  getPointer?(): { x: number; y: number } | undefined;
}

interface Props {
  document: DesignDocument;
  images: ReadonlyMap<string, HTMLImageElement>;
  loadAsset?(assetId: string): Promise<LoadedAsset>;
  generations?: readonly GenerationRecord[];
  focusLayerId?: string;
  focusLayerIds?: readonly string[];
  focusToken?: string | number;
  annotationConfirmLabel?: string;
  selected: string[];
  tool: 'select' | 'hand';
  busy: boolean;
  onSelect(ids: string[]): void;
  onTool(tool: 'select' | 'hand'): void;
  onUpload(): void;
  onAddText(): void;
  onRectangle(): void;
  annotationEditing?: { layerId: string; mode: 'brush' | 'rectangle' };
  onAnnotationConfirm(data: string): Promise<void>;
  onAnnotationCancel(): void;
  cropEditing?: { layerId: string };
  onCropConfirm(changes: LayerPatch): Promise<boolean>;
  onCropCancel(): void;
  onPreviewAsset?(assetId: string): void;
  onViewChange(view: CanvasView): void;
  selectionToolbar?: ReactNode;
  onEdit(edits: Edit[], expectedRevision?: number): Promise<boolean>;
}

function imageTransform(node: Konva.Node, layer: ImageLayer, image: HTMLImageElement) {
  const crop = layer.crop ?? { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
  return `matrix(${node.getAbsoluteTransform().copy()
    .translate(layer.flipX ? layer.width : 0, layer.flipY ? layer.height : 0)
    .scale(layer.width / crop.width * (layer.flipX ? -1 : 1), layer.height / crop.height * (layer.flipY ? -1 : 1))
    .translate(-crop.x, -crop.y).getMatrix().join(',')})`;
}

function textSourceMatches(document: DesignDocument, source: TextLayer) {
  const layer = document.layers.find((entry) => entry.id === source.id);
  return layer?.type === 'text' && layer.visible && !layer.locked
    && (['text', 'fontFamily', 'fontSize', 'fontStyle', 'fill', 'align', 'lineHeight'] as const).every((key) => layer[key] === source[key]);
}

export function Canvas(props: Props) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const sceneRef = useRef<Konva.Layer | null>(null);
  const current = useRef(props);
  current.current = props;
  const [zoom, setZoom] = useState(1);
  const [editing, setEditing] = useState<{ source: TextLayer; text: string; revision: number } | null>(null);
  const [renderError, setRenderError] = useState('');
  const [videoError, setVideoError] = useState('');
  const [playing, setPlaying] = useState<{ layerId: string; assetId: string; entry: LoadedAsset; player: HTMLVideoElement } | null>(null);
  const currentPlaying = useRef(playing);
  currentPlaying.current = playing;
  const [videoButtons, setVideoButtons] = useState<{ id: string; x: number; y: number }[]>([]);
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const lastFocus = useRef<{ key: string; token: Props['focusToken'] } | null>(null);
  const [viewVersion, setViewVersion] = useState(0);
  const gesture = useRef(false);
  const [interacting, setInteracting] = useState(false);
  const gestureRevision = useRef(props.document.revision);
  const [sceneVersion, setSceneVersion] = useState(0);
  const [selectionBounds, setSelectionBounds] = useState<CanvasView['selection']>(null);
  const [imageLabels, setImageLabels] = useState<{ id: string; x: number; y: number; width: number; imageWidth: number; imageHeight: number }[]>([]);
  const [viewportWidth, setViewportWidth] = useState(800);
  const [toolbarSize, setToolbarSize] = useState({ width: 0, height: 41 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [annotationTransform, setAnnotationTransform] = useState('');
  const [cropTransform, setCropTransform] = useState('');
  const [videoTransform, setVideoTransform] = useState('');
  const videoRequest = useRef(0);
  const fitted = useRef(false);
  const syncView = useRef(() => {});
  const fitRef = useRef(() => {});
  const zoomRef = useRef((_: number) => {});
  const annotationLayer = props.document.layers.find((layer): layer is ImageLayer => layer.id === props.annotationEditing?.layerId && layer.type === 'image' && layer.visible);
  const annotationImage = annotationLayer ? props.images.get(annotationLayer.assetId) : undefined;
  const cropLayer = props.document.layers.find((layer): layer is ImageLayer => layer.id === props.cropEditing?.layerId && layer.type === 'image' && layer.visible && !layer.locked);
  const cropImage = cropLayer ? props.images.get(cropLayer.assetId) : undefined;
  const canDrawAnnotation = props.tool === 'select' && !spaceHeld && !props.busy && !interacting;
  const hasSelection = !!selectionBounds;
  const { annotationEditing, cropEditing, loadAsset, focusLayerId, focusLayerIds, focusToken, busy, onSelect } = props;
  const playingLayer = playing && props.document.layers.find((layer) => layer.id === playing.layerId && layer.type === 'video' && layer.assetId === playing.assetId && layer.visible);
  if (playing && (!playingLayer || annotationEditing || cropEditing)) setPlaying(null);
  if (editing && (annotationEditing || cropEditing || !textSourceMatches(props.document, editing.source))) setEditing(null);

  useEffect(() => () => { videoRequest.current++; }, []);
  useEffect(() => {
    if (!playing) return;
    return () => {
      playing.player.pause();
      playing.player.removeAttribute('src');
      playing.player.load();
      playing.entry.release();
    };
  }, [playing]);

  useLayoutEffect(() => {
    if (!playing) return;
    const node = sceneRef.current?.getChildren().find((entry) => entry.id() === playing.layerId);
    if (!(node instanceof Konva.Image)) return;
    const poster = node.image();
    const draw = () => {
      if (playing.player.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      if (node.image() !== playing.player) node.image(playing.player);
      node.getLayer()?.batchDraw();
    };
    const animation = new Konva.Animation(draw, node.getLayer());
    const start = () => animation.start();
    const stop = () => { animation.stop(); draw(); };
    playing.player.addEventListener('loadeddata', draw);
    playing.player.addEventListener('seeked', draw);
    playing.player.addEventListener('play', start);
    playing.player.addEventListener('pause', stop);
    draw();
    if (!playing.player.paused) start();
    return () => {
      animation.stop();
      playing.player.removeEventListener('loadeddata', draw);
      playing.player.removeEventListener('seeked', draw);
      playing.player.removeEventListener('play', start);
      playing.player.removeEventListener('pause', stop);
      node.image(poster);
      node.getLayer()?.batchDraw();
    };
  }, [playing, sceneVersion]);

  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setToolbarSize({ width: element.offsetWidth, height: element.offsetHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.selectionToolbar, hasSelection, annotationEditing, cropEditing]);

  useEffect(() => { syncView.current(); }, [annotationEditing?.layerId, annotationEditing?.mode, cropEditing?.layerId, playing?.layerId, props.generations]);
  useEffect(() => {
    if (cropEditing && (!cropLayer || annotationEditing)) current.current.onCropCancel();
  }, [cropEditing, cropLayer, annotationEditing]);
  useEffect(() => {
    const element = container.current!;
    const stage = new Konva.Stage({ container: element, width: element.clientWidth, height: element.clientHeight });
    stageRef.current = stage;
    const controls = new Konva.Layer();
    let resizeBox: { x: number; y: number; width: number; height: number; rotation: number } | null = null;
    let resizeAnchor: string | null = null;
    const transformer: Konva.Transformer = new Konva.Transformer({
      rotateEnabled: false, flipEnabled: false, shiftBehavior: 'none',
      enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
      padding: 0, borderStroke: '#2480ff', borderStrokeWidth: 1,
      anchorStroke: '#2480ff', anchorFill: '#ffffff', anchorSize: 7, anchorCornerRadius: 1,
      boundBoxFunc: (oldBox) => {
        const pointer = stage.getPointerPosition();
        // Konva swaps anchors before boundBoxFunc, even with flipEnabled:false.
        const anchor = resizeAnchor;
        if (!pointer || !anchor) return oldBox;
        const box = resizeBox ??= oldBox;
        const transform = new Konva.Transform().translate(box.x, box.y).rotate(box.rotation);
        const point = transform.copy().invert().point(pointer);
        const left = anchor.includes('left');
        const top = anchor.includes('top');
        const fixedX = left ? box.width : 0;
        const fixedY = top ? box.height : 0;
        const scale = stage.scaleX();
        const requestedWidth = left ? fixedX - point.x : point.x - fixedX;
        const requestedHeight = top ? fixedY - point.y : point.y - fixedY;
        let width: number;
        let height: number;
        if (transformer.keepRatio()) {
          // Signed distances keep every corner on its original side when flipping is disabled.
          const requested = Math.max(requestedWidth / box.width, requestedHeight / box.height);
          const factor = Math.min(20000 * scale / Math.max(box.width, box.height), Math.max(24 * scale / Math.min(box.width, box.height), requested));
          width = box.width * factor;
          height = box.height * factor;
        } else {
          width = Math.min(20000 * scale, Math.max(24 * scale, requestedWidth));
          height = Math.min(20000 * scale, Math.max(24 * scale, requestedHeight));
        }
        const position = transform.point({ x: left ? fixedX - width : fixedX, y: top ? fixedY - height : fixedY });
        return { ...position, width, height, rotation: box.rotation };
      },
    });
    transformerRef.current = transformer;
    const marquee = new Konva.Rect({ fill: '#0d74ce18', stroke: '#0d74ce', strokeWidth: 1, strokeScaleEnabled: false, visible: false, listening: false });
    controls.add(marquee, transformer);
    stage.add(controls);
    let pan: { x: number; y: number; stageX: number; stageY: number } | null = null;
    let start: { x: number; y: number; shift: boolean; selected: string[] } | null = null;
    let dragging: string[] = [];
    let space = false;
    const clientToWorld = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      return { x: (clientX - rect.left - stage.x()) / stage.scaleX(), y: (clientY - rect.top - stage.y()) / stage.scaleY() };
    };
    let pointerClient: { x: number; y: number } | undefined;
    const clearPointer = () => { pointerClient = undefined; };
    const getPointer = () => {
      if (!pointerClient) return;
      const props = current.current;
      const target = document.elementFromPoint(pointerClient.x, pointerClient.y);
      if (!(target instanceof HTMLCanvasElement) || !element.contains(target) || props.busy || props.annotationEditing || props.cropEditing || document.querySelector('[role="dialog"],:popover-open,.text-edit')) { clearPointer(); return; }
      return clientToWorld(pointerClient.x, pointerClient.y);
    };
    const trackPointer = (event: PointerEvent) => {
      pointerClient = event.target instanceof HTMLCanvasElement && element.contains(event.target) ? { x: event.clientX, y: event.clientY } : undefined;
    };
    const clearOverlayPointer = (event: Event) => {
      if ((event.target as HTMLElement).matches('[role="dialog"], [popover]')) clearPointer();
    };
    window.addEventListener('pointermove', trackPointer, true);
    window.addEventListener('pointerdown', trackPointer, true);
    window.addEventListener('focusin', clearPointer);
    element.addEventListener('pointerleave', clearPointer);
    document.addEventListener('toggle', clearOverlayPointer, true);
    const selectNode = (id: string, shift: boolean) => {
      const selected = current.current.selected;
      current.current.onSelect(shift ? selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id] : [id]);
    };

    syncView.current = () => {
      const nodes = sceneRef.current?.getChildren().filter((node) => current.current.selected.includes(node.id())) ?? [];
      const boxes = nodes.map((node) => node.getClientRect());
      const x = Math.min(...boxes.map((box) => box.x));
      const y = Math.min(...boxes.map((box) => box.y));
      const selection = boxes.length ? { x, y, width: Math.max(...boxes.map((box) => box.x + box.width)) - x, height: Math.max(...boxes.map((box) => box.y + box.height)) - y } : null;
      if (!gesture.current) {
        setSelectionBounds(selection);
        setImageLabels(nodes.flatMap((node) => {
          const layer = current.current.document.layers.find((entry) => entry.id === node.id());
          const box = node.getClientRect();
          return layer?.type === 'image' ? [{ id: layer.id, x: box.x, y: box.y, width: box.width, imageWidth: node.width() * node.scaleX(), imageHeight: node.height() * node.scaleY() }] : [];
        }));
      }
      const spacing = 24 * stage.scaleX() * 2 ** Math.max(0, Math.ceil(Math.log2(0.5 / stage.scaleX())));
      element.style.backgroundSize = `${spacing}px ${spacing}px`;
      element.style.backgroundPosition = `${stage.x() - spacing / 2}px ${stage.y() - spacing / 2}px`;
      const layers = current.current.document.layers;
      for (const [id, setTransform] of [[current.current.annotationEditing?.layerId, setAnnotationTransform], [current.current.cropEditing?.layerId, setCropTransform]] as const) {
        const node = sceneRef.current?.getChildren().find((entry) => entry.id() === id);
        const layer = layers.find((entry): entry is ImageLayer => entry.id === id && entry.type === 'image');
        const image = layer && current.current.images.get(layer.assetId);
        setTransform(node && layer && image ? imageTransform(node, layer, image) : '');
      }
      const player = currentPlaying.current;
      const videoNode = sceneRef.current?.getChildren().find((node) => node.id() === player?.layerId);
      setVideoTransform(videoNode ? `matrix(${videoNode.getAbsoluteTransform().getMatrix().join(',')})` : '');
      setViewportWidth(stage.width());
      setViewport({ x: stage.x(), y: stage.y(), scale: stage.scaleX() });
      setVideoButtons((sceneRef.current?.getChildren() ?? []).flatMap((node) => {
        const layer = current.current.document.layers.find((entry) => entry.id === node.id());
        if (layer?.type !== 'video' || !layer.visible) return [];
        const point = node.getAbsoluteTransform().point({ x: node.width() / 2, y: node.height() / 2 });
        return [{ id: layer.id, x: point.x, y: point.y }];
      }));
      current.current.onViewChange({ center: { x: (stage.width() / 2 - stage.x()) / stage.scaleX(), y: (stage.height() / 2 - stage.y()) / stage.scaleY() }, selection, width: stage.width(), height: stage.height(), clientToWorld, getPointer });
    };
    const setZoomAt = (next: number, point?: { x: number; y: number }) => {
      next = Math.min(8, Math.max(0.05, next));
      if (point) {
        const old = stage.scaleX();
        const local = { x: (point.x - stage.x()) / old, y: (point.y - stage.y()) / old };
        stage.position({ x: point.x - local.x * next, y: point.y - local.y * next });
      }
      stage.scale({ x: next, y: next });
      setZoom(next);
      syncView.current();
      stage.batchDraw();
    };
    zoomRef.current = (direction) => direction === 0
      ? setZoomAt(1, { x: stage.width() / 2, y: stage.height() / 2 })
      : setZoomAt((Math.round(Math.round(stage.scaleX() * 100) / 25) + direction) / 4);
    fitRef.current = () => {
      const nodes = sceneRef.current?.getChildren().filter((node) => node.id() && node.visible()) ?? [];
      if (!nodes.length || !stage.width() || !stage.height()) return;
      const boxes = nodes.map((node) => node.getClientRect({ relativeTo: stage }));
      const x = Math.min(...boxes.map((box) => box.x));
      const y = Math.min(...boxes.map((box) => box.y));
      const width = Math.max(...boxes.map((box) => box.x + box.width)) - x;
      const height = Math.max(...boxes.map((box) => box.y + box.height)) - y;
      const next = Math.min(8, Math.max(1, stage.width() - 120) / width, Math.max(1, stage.height() - 176) / height);
      stage.scale({ x: next, y: next });
      stage.position({ x: stage.width() / 2 - (x + width / 2) * next, y: stage.height() / 2 + 28 - (y + height / 2) * next });
      setZoom(next);
      syncView.current();
      stage.batchDraw();
    };
    fitRef.current();
    const observer = new ResizeObserver(() => {
      stage.size({ width: element.clientWidth, height: element.clientHeight });
      syncView.current();
      stage.batchDraw();
    });
    observer.observe(element);
    stage.on('wheel', (event) => {
      event.evt.preventDefault();
      const { ctrlKey, deltaX, deltaY, deltaMode } = event.evt;
      if (!ctrlKey && deltaMode === 0) {
        stage.position({ x: stage.x() - deltaX, y: stage.y() - deltaY });
        syncView.current();
        stage.batchDraw();
      } else {
        const pointer = stage.getPointerPosition();
        if (pointer) setZoomAt(stage.scaleX() * (deltaY > 0 ? 1 / 1.1 : 1.1), pointer);
      }
    });
    stage.on('mousedown touchstart', (event) => {
      if ((event.evt.target as Element | null)?.closest('.annotation-toolbar')) return;
      if ('button' in event.evt && event.evt.button === 2) return;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      if (space || current.current.tool === 'hand' || ('button' in event.evt && event.evt.button === 1)) {
        // Konva prepares node dragging and anchor transforms before this bubbles.
        transformer.stopTransform();
        event.target.stopDrag();
        pan = { ...pointer, stageX: stage.x(), stageY: stage.y() };
        gesture.current = true;
        setInteracting(true);
        element.style.cursor = 'grabbing';
        event.evt.preventDefault();
        return;
      }
      if (current.current.busy || current.current.annotationEditing || current.current.cropEditing) return;
      const node = event.target;
      if (node === stage) {
        start = { ...pointer, shift: 'shiftKey' in event.evt && event.evt.shiftKey, selected: [...current.current.selected] };
        marquee.hide();
        event.evt.preventDefault();
      } else if (node.id() && current.current.document.layers.some((layer) => layer.id === node.id())) {
        const shift = 'shiftKey' in event.evt && event.evt.shiftKey;
        if (shift || !current.current.selected.includes(node.id())) selectNode(node.id(), shift);
      }
    });
    stage.on('mousemove touchmove', () => {
      const pointer = stage.getPointerPosition();
      if (pan && pointer) {
        stage.position({ x: pan.stageX + pointer.x - pan.x, y: pan.stageY + pointer.y - pan.y });
        stage.batchDraw();
        syncView.current();
      } else if (start && pointer) {
        const width = Math.abs(start.x - pointer.x);
        const height = Math.abs(start.y - pointer.y);
        marquee.setAttrs({ x: (Math.min(start.x, pointer.x) - stage.x()) / stage.scaleX(), y: (Math.min(start.y, pointer.y) - stage.y()) / stage.scaleY(), width: width / stage.scaleX(), height: height / stage.scaleY(), visible: width >= 3 || height >= 3 });
        controls.batchDraw();
      }
    });
    const endPointer = () => {
      if (pan) {
        pan = null;
        gesture.current = false;
        setInteracting(false);
        syncView.current();
        setViewVersion((value) => value + 1);
      }
      element.style.cursor = space || current.current.tool === 'hand' ? 'grab' : 'default';
      if (start) {
        const rect = marquee.getClientRect();
        const pointer = stage.getPointerPosition();
        if (!pointer || (Math.abs(start.x - pointer.x) < 3 && Math.abs(start.y - pointer.y) < 3)) {
          const node = pointer ? stage.getIntersection(pointer) : null;
          if (node?.id() && current.current.document.layers.some((layer) => layer.id === node.id())) selectNode(node.id(), start.shift);
          else current.current.onSelect(start.shift ? start.selected : []);
        } else {
          const ids = sceneRef.current?.getChildren().filter((node) => {
            const box = node.getClientRect();
            return node.id() && node.listening() && box.x < rect.x + rect.width && box.x + box.width > rect.x && box.y < rect.y + rect.height && box.y + box.height > rect.y;
          }).map((node) => node.id()) ?? [];
          current.current.onSelect(start.shift ? [...new Set([...start.selected, ...ids])] : ids);
        }
        start = null;
        marquee.hide();
        controls.batchDraw();
      }
    };
    stage.on('mouseup touchend', endPointer);
    window.addEventListener('mouseup', endPointer);
    stage.on('dragstart', (event) => {
      if (!event.target.id() || dragging.length) return;
      gesture.current = true;
      setInteracting(true);
      gestureRevision.current = current.current.document.revision;
      const node = event.target;
      const ids = current.current.selected.includes(node.id()) ? current.current.selected : [node.id()];
      dragging = ids.filter((id) => sceneRef.current?.getChildren().some((child) => child.id() === id && child.draggable()));
      transformer.hide();
    });
    stage.on('dragend', (event) => {
      if (!event.target.id() || !dragging.length) return;
      const edits: Edit[] = dragging.flatMap((id) => {
        const node = sceneRef.current?.getChildren().find((child) => child.id() === id);
        return node ? [{ type: 'patch' as const, id, changes: { x: node.x(), y: node.y() } }] : [];
      });
      dragging = [];
      gesture.current = false;
      transformer.show();
      syncView.current();
      setInteracting(false);
      if (edits.length) void current.current.onEdit(edits, gestureRevision.current).then(() => setViewVersion((value) => value + 1));
    });
    stage.on('dragmove', (event) => { if (event.target.id()) syncView.current(); });
    transformer.on('transform', () => syncView.current());
    transformer.on('transformstart', () => { resizeBox = null; resizeAnchor = transformer.getActiveAnchor(); gesture.current = true; setInteracting(true); gestureRevision.current = current.current.document.revision; });
    transformer.on('transformend', () => {
      const edits: Edit[] = resizeBox ? transformer.nodes().map((node) => ({
        type: 'patch', id: node.id(), changes: {
          x: node.x(), y: node.y(), rotation: node.rotation(),
          width: Math.max(1, node.width() * node.scaleX()), height: Math.max(1, node.height() * node.scaleY()),
          ...(node instanceof Konva.Text ? { fontSize: node.fontSize() * node.scaleY() } : {}),
        },
      })) : [];
      resizeBox = null;
      resizeAnchor = null;
      gesture.current = false;
      syncView.current();
      setInteracting(false);
      if (edits.length) void current.current.onEdit(edits, gestureRevision.current).then(() => setViewVersion((value) => value + 1));
    });
    stage.on('dblclick dbltap', (event) => {
      const layer = current.current.document.layers.find((entry) => entry.id === event.target.id());
      if (current.current.busy || current.current.annotationEditing || current.current.cropEditing || space || current.current.tool !== 'select') return;
      if (layer?.type === 'text' && !layer.locked) {
        setEditing({ source: layer, text: layer.text, revision: current.current.document.revision });
      } else if (layer?.type === 'image') current.current.onPreviewAsset?.(layer.assetId);
    });
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || (event.target as HTMLElement).closest('[role="dialog"],[popover]')) clearPointer();
      if (event.code !== 'Space' || (event.target as HTMLElement).closest('input,textarea,select,button,summary,video,[contenteditable="true"],[role="dialog"]')) return;
      event.preventDefault();
      if (space) return;
      space = true;
      setSpaceHeld(true);
      element.style.cursor = 'grab';
      for (const node of sceneRef.current?.getChildren() ?? []) node.draggable(false);
      transformer.listening(false);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || !space) return;
      space = false;
      setSpaceHeld(false);
      element.style.cursor = current.current.tool === 'hand' ? 'grab' : 'default';
      setViewVersion((value) => value + 1);
    };
    const finishInteraction = () => {
      // Public stop APIs emit the existing end events before nodes are detached.
      transformer.stopTransform();
      for (const node of sceneRef.current?.getChildren() ?? []) node.stopDrag();
      transformer.stopDrag();
      endPointer();
    };
    const blur = () => { clearPointer(); space = false; setSpaceHeld(false); finishInteraction(); setViewVersion((value) => value + 1); };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    window.addEventListener('touchend', endPointer);
    window.addEventListener('touchcancel', finishInteraction);
    return () => {
      observer.disconnect();
      window.removeEventListener('pointermove', trackPointer, true);
      window.removeEventListener('pointerdown', trackPointer, true);
      window.removeEventListener('focusin', clearPointer);
      element.removeEventListener('pointerleave', clearPointer);
      document.removeEventListener('toggle', clearOverlayPointer, true);
      window.removeEventListener('mouseup', endPointer);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
      window.removeEventListener('touchend', endPointer);
      window.removeEventListener('touchcancel', finishInteraction);
      stage.destroy();
      stageRef.current = null;
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || gesture.current) return;
    // Missing assets have no scene/interaction node; loaded siblings and text remain usable.
    const drawable = props.document.layers.filter((layer) => layer.visible && (layer.type === 'text' || props.images.has(layer.assetId))).map((layer) => layer.id);
    transformerRef.current?.nodes([]);
    sceneRef.current?.destroy();
    sceneRef.current = null;
    try {
      const scene = createScene({ ...props.document, background: null }, props.images, drawable);
      sceneRef.current = scene;
      stage.add(scene);
      scene.zIndex(0);
      if (!fitted.current && drawable.length) { fitRef.current(); fitted.current = true; }
      setRenderError('');
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : String(error));
    }
    syncView.current();
    setSceneVersion((value) => value + 1);
    stage.batchDraw();
  }, [props.document, props.images, viewVersion]);

  useEffect(() => {
    const scene = sceneRef.current;
    const transformer = transformerRef.current;
    if (!scene || !transformer || gesture.current) return;
    const interactive = props.tool === 'select' && !spaceHeld && !props.busy && !props.annotationEditing && !props.cropEditing;
    for (const node of scene.getChildren()) {
      const layer = props.document.layers.find((entry) => entry.id === node.id());
      if (layer) {
        node.draggable(interactive && !layer.locked);
        node.listening(interactive && !layer.locked);
        node.visible(layer.visible && layer.id !== props.cropEditing?.layerId);
      }
    }
    const nodes = interactive ? scene.getChildren().filter((node) => props.selected.includes(node.id()) && node.draggable()) : [];
    const layer = nodes.length === 1 ? props.document.layers.find((entry) => entry.id === nodes[0].id()) : undefined;
    transformer.keepRatio(layer?.type === 'image' ? !!layer.lockAspectRatio : true);
    transformer.resizeEnabled(nodes.length === 1);
    transformer.listening(interactive);
    // Keep all selected nodes attached: Konva propagates multi-selection dragging.
    transformer.nodes(nodes);
    container.current!.style.cursor = spaceHeld || props.tool === 'hand' ? 'grab' : 'default';
    syncView.current();
    stageRef.current?.batchDraw();
  }, [props.selected, props.tool, props.busy, props.document, props.annotationEditing, props.cropEditing, sceneVersion, spaceHeld, viewVersion]);

  useEffect(() => {
    const ids = focusLayerIds?.length ? focusLayerIds : focusLayerId ? [focusLayerId] : [];
    const focusKey = JSON.stringify(ids);
    if (!ids.length) { lastFocus.current = null; return; }
    if (lastFocus.current?.key === focusKey && lastFocus.current.token === focusToken) return;
    const stage = stageRef.current;
    const layers = props.document.layers.filter((layer) => ids.includes(layer.id));
    const nodes = sceneRef.current?.getChildren() ?? [];
    if (!stage || !stage.width() || !stage.height() || layers.length !== ids.length || layers.some((layer) => !layer.visible || !nodes.some((node) => node.id() === layer.id)) || gesture.current || busy || annotationEditing || cropEditing) return;
    const boxes = layers.map((layer) => {
      const node = new Konva.Rect({ x: layer.x, y: layer.y, width: layer.width, height: layer.height, rotation: layer.rotation });
      const box = node.getClientRect();
      node.destroy();
      return box;
    });
    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y));
    const width = Math.max(...boxes.map((box) => box.x + box.width)) - x;
    const height = Math.max(...boxes.map((box) => box.y + box.height)) - y;
    const next = Math.min(8, Math.max(1, stage.width() - 120) / width, Math.max(1, stage.height() - 176) / height);
    stage.scale({ x: next, y: next });
    stage.position({ x: stage.width() / 2 - (x + width / 2) * next, y: stage.height() / 2 + 28 - (y + height / 2) * next });
    lastFocus.current = { key: focusKey, token: focusToken };
    fitted.current = true;
    if (!focusLayerIds?.length && focusLayerId) onSelect([focusLayerId]);
    setZoom(next);
    syncView.current();
    stage.batchDraw();
  }, [focusLayerId, focusLayerIds, focusToken, props.document.layers, busy, annotationEditing, cropEditing, onSelect, interacting, viewport, sceneVersion]);

  async function playVideo(layerId: string) {
    if (!loadAsset || props.busy || props.annotationEditing || props.cropEditing) return;
    const layer = current.current.document.layers.find((entry) => entry.id === layerId);
    if (layer?.type !== 'video' || !layer.visible) return;
    const request = ++videoRequest.current;
    setVideoError('');
    try {
      const entry = await loadAsset(layer.assetId);
      if (request !== videoRequest.current || !stageRef.current || current.current.busy || current.current.cropEditing || current.current.annotationEditing || !current.current.document.layers.some((entry) => entry.id === layerId && entry.type === 'video' && entry.assetId === layer.assetId && entry.visible) || !sceneRef.current?.getChildren().some((node) => node.id() === layerId)) { entry.release(); return; }
      const player = window.document.createElement('video');
      player.playsInline = true;
      player.preload = 'auto';
      setPlaying({ layerId, assetId: layer.assetId, entry, player });
    } catch (cause) { if (request === videoRequest.current && stageRef.current) setVideoError(t('视频读取失败：{error}', { error: errorMessage(cause) })); }
  }

  const toolbarLeft = selectionBounds ? Math.max(72 + toolbarSize.width / 2, Math.min(selectionBounds.x + selectionBounds.width / 2, viewportWidth - toolbarSize.width / 2 - 16)) : 0;
  return <div className="canvas-workspace">
    <div ref={container} className="canvas-surface" role="application" aria-label={t('设计画布，Shift 多选，空格拖动平移，触控板平移，Ctrl 加滚轮缩放，双击编辑文字')} />
    {(renderError || videoError) && <div className="canvas-notice" role="alert">{renderError || videoError}</div>}
    {props.generations?.filter((record) => record.documentId === props.document.id && record.state === 'running').flatMap((record) => record.placements?.map((placement, index) => <div key={`${record.id}:${index}`} className="ic-generation-placeholder" role="status" style={{ left: viewport.x + placement.x * viewport.scale, top: viewport.y + placement.y * viewport.scale, width: placement.width * viewport.scale, height: placement.height * viewport.scale }}><span>{t(record.action === 'video' || record.action === 'storyboard' ? '视频生成中…' : 'AI 生成中…')}</span></div>) ?? [])}
    {!interacting && props.tool === 'select' && !spaceHeld && !props.busy && !props.annotationEditing && !props.cropEditing && loadAsset && videoButtons.filter((button) => button.id !== playing?.layerId).map((button) => <button key={button.id} type="button" className="ic-canvas-video-play" style={{ left: button.x, top: button.y }} aria-label={t('播放视频')} title={t('播放视频')} onClick={() => void playVideo(button.id)}><Play size={20} /></button>)}
    {playing && playingLayer && videoTransform && <VideoDisplay key={`${playing.layerId}:${playing.assetId}`} entry={playing.entry} player={playing.player} loadAsset={loadAsset!} name={playingLayer.name} width={playingLayer.width} height={playingLayer.height} transform={videoTransform} interactive={!interacting && props.tool === 'select' && !spaceHeld && !props.busy && !props.annotationEditing && !props.cropEditing} onWheel={(event) => {
      const stage = stageRef.current;
      if (!stage) return;
      event.preventDefault();
      event.stopPropagation();
      stage.setPointersPositions(event);
      stage.fire('wheel', { evt: event, target: stage });
    }} onClose={() => { videoRequest.current++; setPlaying(null); }} />}
    <div className="ic-canvas-tools ic-pill" role="toolbar" aria-label={t('画布工具')}>
      <button className={`ic-pill-btn${props.tool === 'select' ? ' ic-pill-btn-active' : ''}`} title={t('选择工具 V')} aria-label={t('选择工具')} aria-pressed={props.tool === 'select'} onClick={() => props.onTool('select')}><MousePointer2 size={19} /></button>
      <button className={`ic-pill-btn${props.tool === 'hand' ? ' ic-pill-btn-active' : ''}`} title={t('手形工具 H / 空格平移')} aria-label={t('手形工具')} aria-pressed={props.tool === 'hand'} onClick={() => props.onTool('hand')}><Hand size={19} /></button>
      <span className="ic-toolbar-divider" />
      <button className="ic-pill-btn" title={t('上传图片')} aria-label={t('上传图片')} disabled={props.busy || !!props.annotationEditing || !!props.cropEditing} onClick={props.onUpload}><CanvasIcon name="upload_image" size={20} /></button>
      <button className={`ic-pill-btn${props.annotationEditing?.mode === 'rectangle' ? ' ic-pill-btn-active' : ''}`} title={t('框选局部修改')} aria-label={t('框选局部修改')} disabled={props.busy || !!props.annotationEditing || !!props.cropEditing} onClick={props.onRectangle}><SquareDashed size={19} /></button>
      <button className="ic-pill-btn" title={t('添加文字 T')} aria-label={t('添加文字')} disabled={props.busy || !!props.annotationEditing || !!props.cropEditing} onClick={props.onAddText}><Type size={20} /></button>
    </div>
    <div className="ic-canvas-zoom ic-pill" role="toolbar" aria-label={t('画布缩放')}>
      <button className="ic-pill-btn" title={t('缩小')} aria-label={t('缩小')} onClick={() => zoomRef.current(-1)}><Minus size={15} /></button>
      <button className="ic-zoom-label" title={t('重置为 100%')} onClick={() => zoomRef.current(0)}>{Math.round(zoom * 100)}%</button>
      <button className="ic-pill-btn" title={t('放大')} aria-label={t('放大')} onClick={() => zoomRef.current(1)}><Plus size={15} /></button>
      <span className="ic-toolbar-divider" />
      <button className="ic-pill-btn" title={t('适应内容')} aria-label={t('适应内容')} onClick={() => fitRef.current()}><Scan size={16} /></button>
    </div>
    {!interacting && imageLabels.map((label) => {
      const layer = props.document.layers.find((entry) => entry.id === label.id);
      if (layer?.type !== 'image') return null;
      const image = props.images.get(layer.assetId);
      return <div className="ic-image-label" key={label.id} style={{ left: label.x, top: label.y - 28, width: label.width }}>
        <span className="ic-image-name" title={layer.name}>{layer.name}</span>
        <span className="ic-image-dimensions" title={image ? t('原图 {width}×{height} 像素', { width: image.naturalWidth, height: image.naturalHeight }) : undefined}>{Math.round(label.imageWidth)}×{Math.round(label.imageHeight)}</span>
      </div>;
    })}
    {selectionBounds && props.selectionToolbar && !props.annotationEditing && !props.cropEditing && <div className="ic-selection-toolbar-anchor" inert={interacting} style={{ top: Math.max(toolbarSize.height + 16, selectionBounds.y - 44), left: toolbarLeft, visibility: interacting ? 'hidden' : undefined }}><div ref={toolbar} className="ic-selection-toolbar-content">{props.selectionToolbar}</div></div>}
    {container.current && annotationLayer && annotationImage && props.annotationEditing && !props.cropEditing && annotationTransform && createPortal(<div className="canvas-annotation" style={{ '--annotation-clip': annotationLayer.crop ? `inset(${annotationLayer.crop.y}px ${annotationImage.naturalWidth - annotationLayer.crop.x - annotationLayer.crop.width}px ${annotationImage.naturalHeight - annotationLayer.crop.y - annotationLayer.crop.height}px ${annotationLayer.crop.x}px)` : 'none' } as React.CSSProperties}><Annotation key={`${annotationLayer.id}:${annotationLayer.assetId}:${props.annotationEditing.mode}:${JSON.stringify(annotationLayer.crop ?? null)}`} image={annotationImage} sourceRect={annotationLayer.crop} mode={props.annotationEditing.mode} transform={annotationTransform} width={annotationImage.naturalWidth} height={annotationImage.naturalHeight} canDraw={canDrawAnnotation} disabled={props.busy} confirmLabel={props.annotationConfirmLabel} onConfirm={props.onAnnotationConfirm} onCancel={props.onAnnotationCancel} /></div>, stageRef.current!.getContent())}
    {container.current && cropLayer && cropImage && props.cropEditing && cropTransform && createPortal(<CropEditor key={`${cropLayer.id}:${cropLayer.assetId}`} image={cropImage} layer={cropLayer} revision={props.document.revision} transform={cropTransform} canInteract={canDrawAnnotation} disabled={props.busy} onConfirm={props.onCropConfirm} onCancel={props.onCropCancel} />, stageRef.current!.getContent())}
    {editing && <form className="text-edit" onSubmit={(event) => {
      event.preventDefault();
      if (current.current.busy || current.current.annotationEditing || current.current.cropEditing) return;
      if (!textSourceMatches(current.current.document, editing.source)) { setEditing(null); return; }
      const session = editing;
      void current.current.onEdit([{ type: 'patch', id: session.source.id, changes: { text: session.text } }], session.revision).then((saved) => { if (saved) setEditing((active) => active === session ? null : active); });
    }}>
      <label htmlFor="canvas-text">{t('编辑文字')}</label>
      <textarea id="canvas-text" autoFocus value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} onKeyDown={(event) => { if (event.key === 'Escape') setEditing(null); }} />
      <div className="button-row"><button type="button" onClick={() => setEditing(null)}>{t('取消')}</button><button className="primary" disabled={props.busy}>{t('应用文字')}</button></div>
    </form>}
  </div>;
}
