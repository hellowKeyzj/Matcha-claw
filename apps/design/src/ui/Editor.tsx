import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Crop, History, Layers as LayersIcon, Plus, Redo2, RefreshCw, Settings2, SlidersHorizontal, Type, Undo2, X } from 'lucide-react';
import type { Asset, DesignDocument, Edit, GenerationRecord, GenerationRequest, ImageLayer, Layer, LayerPatch } from '../document';
import type { DesignComposeOperation } from '../compose-operation';
import { appToolName, type AppComposeRequest, type AppMediaModelList } from '@matcha/app-plugins-sdk';
import { sessionIdentitiesEqual } from '@matcha/app-plugins-sdk';
import { app, call, download, errorMessage, fileData, isExternalApp, subscribeToolResults, ToolError } from './api';
import { useAssets, type LoadedAsset } from './useAssets';
import { useCanvasTransfers } from './useCanvasTransfers';
import { useSessionMedia } from './useSessionMedia';
import { useGenerationClose } from './useGenerationClose';
import { GenerationCloseDialog } from './GenerationCloseDialog';
import { Export } from './Export';
import { TextEditor } from './TextEditor';
import { Canvas, type CanvasView } from './Canvas';
import { CanvasIcon } from './CanvasIcon';
import { AbilityToolbar, type Ability } from './AbilityToolbar';
import { Layers } from './Layers';
import { Properties } from './Properties';
import { Generation } from './Generation';
import { GenerationHistory } from './GenerationHistory';
import { ImageAdjustments } from './ImageAdjustments';
import { MediaPreview } from './MediaPreview';
import { toolTitles, type CreativeTool } from './tools';
import { useTranslation } from './i18n';

export function Editor() {
  const { t } = useTranslation();
  const [active, setActive] = useState<DesignDocument | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [focus, setFocus] = useState<{ documentId: string; layerId: string; token: number }>();
  const externalDocumentId = useRef<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let read = 0;
    const report = (cause: unknown) => { if (live) setError(errorMessage(cause)); };
    const focusLayer = (documentId: string, layerId: string) => setFocus((previous) => ({ documentId, layerId, token: (previous?.token ?? 0) + 1 }));
    const open = (documentId: string, layerId?: string) => {
      const request = ++read;
      externalDocumentId.current = documentId;
      void call<{ document: DesignDocument; focusLayerId?: string }>('document_get', { documentId }).then(({ document, focusLayerId }) => {
        if (!live || request !== read) return;
        const identity = app().context.sessionIdentity;
        if (identity && (!document.sessionIdentity || !sessionIdentitiesEqual(identity, document.sessionIdentity))) return;
        setActive((previous) => previous?.id === document.id && previous.revision > document.revision ? previous : document);
        if (layerId ?? focusLayerId) focusLayer(document.id, (layerId ?? focusLayerId)!);
      }).catch((cause) => { if (request === read) report(cause); });
    };
    if (isExternalApp()) {
      if (externalDocumentId.current) open(externalDocumentId.current);
      const unsubscribe = subscribeToolResults((update) => {
        if (update.kind === 'document') { setError(''); open(update.documentId, update.layerId); }
        else if (update.kind === 'failed') report(update.error);
      });
      return () => { live = false; unsubscribe(); };
    }
    const unsubscribe = app().subscribe((event) => {
      if (event.topic !== 'document.focus') return;
      const data = event.data;
      if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.documentId === 'string' && data.documentId === externalDocumentId.current && typeof data.layerId === 'string') open(data.documentId, data.layerId);
    });
    const request = ++read;
    void call<{ document: DesignDocument; focusLayerId?: string }>('document_create', { sessionIdentity: app().context.sessionIdentity, name: t('画板') }).then(({ document, focusLayerId }) => {
      if (!live || request !== read) return;
      externalDocumentId.current = document.id;
      setActive(document);
      if (focusLayerId) focusLayer(document.id, focusLayerId);
    }).catch(report);
    return () => { live = false; unsubscribe(); };
  }, [attempt, t]);
  const accept = useCallback((document: DesignDocument) => {
    setActive((previous) => previous?.id === document.id && previous.revision <= document.revision ? document : previous);
  }, []);
  return <div className="design-app">{active ? <Workbench key={active.id} document={active} focus={focus?.documentId === active.id ? focus : undefined} onDocument={accept} hostError={error} onHostRetry={() => { setError(''); setAttempt((value) => value + 1); }} onHostErrorDismiss={() => setError('')} /> : <div className="canvas-start" role="status">{error ? <><h2>{t('暂时无法打开画板')}</h2><p className="inline-error" role="alert">{error}</p><button onClick={() => { setError(''); setAttempt((value) => value + 1); }}><RefreshCw size={14} />{t('重试')}</button></> : t('设计模式正在启动…')}</div>}</div>;
}

function Workbench({ document: design, focus, onDocument, hostError, onHostRetry, onHostErrorDismiss }: { document: DesignDocument; focus?: { layerId: string; token: number }; onDocument(document: DesignDocument): void; hostError: string; onHostRetry(): void; onHostErrorDismiss(): void }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [tool, setTool] = useState<'select' | 'hand'>('select');
  const [creativeTool, setCreativeTool] = useState<CreativeTool | null>(null);
  const [panel, setPanel] = useState<'layers' | 'properties' | 'adjustments' | 'history' | 'export' | null>(null);
  const [cropLayerId, setCropLayerId] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<{ layerId: string; revision: number; changes: LayerPatch } | null>(null);
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  const [storyboardRecord, setStoryboardRecord] = useState<GenerationRecord | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [generations, setGenerations] = useState<GenerationRecord[]>([]);
  const pendingGenerations = useRef(new Set<Promise<unknown>>());
  const generationRead = useRef(0);
  const [assetAttempt, setAssetAttempt] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [importFocus, setImportFocus] = useState<{ ids: string[]; token: number; externalToken?: number }>();
  const input = useRef<HTMLInputElement>(null);
  const current = useRef(design);
  current.current = design;
  const [viewportWidth, setViewportWidth] = useState(800);
  const view = useRef<CanvasView>({ center: { x: 0, y: 0 }, selection: null, width: 800, height: 600 });
  const lock = useRef(false);
  const mounted = useRef(true);
  const assets = useAssets();
  const load = assets.load;
  const canvasAssets = useRef(new Map<string, LoadedAsset>());

  useEffect(() => {
    mounted.current = true;
    const leases = canvasAssets.current;
    return () => {
      mounted.current = false;
      for (const entry of leases.values()) entry.release();
      leases.clear();
    };
  }, []);
  useEffect(() => {
    const ids = new Set(design.layers.map((layer) => layer.id));
    setSelected((previous) => previous.every((id) => ids.has(id)) ? previous : previous.filter((id) => ids.has(id)));
  }, [design.layers]);

  const refresh = useCallback(async () => {
    const { document } = await call<{ document: DesignDocument }>('document_get', { documentId: design.id });
    if (mounted.current) {
      if (document.revision >= current.current.revision) current.current = document;
      onDocument(document);
    }
  }, [design.id, onDocument]);
  const refreshGenerations = useCallback(async () => {
    const request = ++generationRead.current;
    const { generations } = await call<{ generations: GenerationRecord[] }>('generations_list', { documentId: design.id });
    if (mounted.current && request === generationRead.current) setGenerations(generations);
    return generations;
  }, [design.id]);
  const generationClose = useGenerationClose(design.id, pendingGenerations.current, refreshGenerations, setError);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = (cause: unknown) => { if (mounted.current) setError(errorMessage(cause)); };
    const unsubscribe = app().subscribe((event) => {
      if (!['document.changed', 'generation.changed'].includes(event.topic)) return;
      const data = event.data;
      if (data && typeof data === 'object' && !Array.isArray(data) && typeof data.documentId === 'string' && data.documentId !== design.id) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void refresh().catch(report); void refreshGenerations().catch(report); }, 60);
    });
    const unsubscribeTools = isExternalApp() ? subscribeToolResults((update) => {
      if (update.kind !== 'document' || update.documentId === design.id) void refreshGenerations().catch(report);
    }) : () => {};
    void refresh().catch(report);
    void refreshGenerations().catch(report);
    return () => { unsubscribe(); unsubscribeTools(); if (timer) clearTimeout(timer); };
  }, [design.id, refresh, refreshGenerations]);
  const imageIds = [...new Set(design.layers.flatMap((layer) => layer.type !== 'text' && layer.visible ? [layer.assetId] : []))].join('|');
  useEffect(() => {
    let live = true;
    const required = new Set(imageIds ? imageIds.split('|') : []);
    const leases = canvasAssets.current;
    for (const [id, entry] of leases) {
      if (!required.has(id)) { leases.delete(id); entry.release(); }
    }
    for (const id of required) {
      if (leases.has(id)) continue;
      void load(id).then((entry) => {
        if (live) leases.set(id, entry);
        else entry.release();
      }).catch((cause) => { if (live) setError(t('图片读取失败：{error}', { error: errorMessage(cause) })); });
    }
    return () => { live = false; };
  }, [imageIds, assetAttempt, load, t]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function mutation(name: string, args: object, expectedRevision?: number): Promise<boolean> {
    if (lock.current || annotationEditing || generationClose.isClosing()) return false;
    lock.current = true;
    setBusy(true);
    setError('');
    const before = current.current;
    try {
      const { document } = await call<{ document: DesignDocument }>(name, { ...args, documentId: before.id, expectedRevision: expectedRevision ?? before.revision });
      if (mounted.current) { setImagePreview(null); current.current = document; onDocument(document); }
      return true;
    } catch (cause) {
      if (!mounted.current) return false;
      if (cause instanceof ToolError && cause.code === 'revision_conflict') {
        try { await refresh(); setError(t('画板已更新，已重新读取。本次修改未覆盖，请检查后重试。')); }
        catch (readError) { setError(t('版本冲突，重新读取失败：{error}。本次修改未保存。', { error: errorMessage(readError) })); onDocument({ ...current.current }); }
      } else { setError(errorMessage(cause)); onDocument({ ...current.current }); }
      return false;
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const edit = (edits: Edit[], expectedRevision?: number) => mutation('document_edit', { edits }, expectedRevision);
  const selectedLayers = design.layers.filter((layer) => selected.includes(layer.id));
  const selectedImages = selectedLayers.filter((layer) => layer.type === 'image');
  const annotationTool = creativeTool === 'rectangle' || creativeTool === 'brush' || creativeTool === 'erase' ? creativeTool : null;
  const annotationLayer = selectedLayers.length === 1 && selectedImages.length === 1 ? selectedImages[0] : undefined;
  const annotationEditing = annotationTool && annotationLayer
    ? { layerId: annotationLayer.id, mode: annotationTool === 'rectangle' ? 'rectangle' as const : 'brush' as const } : undefined;
  useEffect(() => { if (annotationTool && !annotationLayer) setCreativeTool(null); }, [annotationTool, annotationLayer]);
  function remove() {
    const ids = selectedLayers.filter((layer) => !layer.locked).map((layer) => layer.id);
    if (ids.length >= design.layers.length) { setNotice(t('无法删除画板中的最后一项。')); return; }
    if (ids.length) void edit([{ type: 'remove', ids }]);
  }
  function select(ids: string[]) {
    if (ids.length > 9) setNotice(t('最多选择 {count} 项。', { count: 9 }));
    setImagePreview(null);
    setSelected(ids.slice(0, 9));
  }
  const transfers = useCanvasTransfers({ document: design, current, selected, load: assets.load, edit,
    getCenter: () => view.current.center, isBlocked: () => lock.current || !!annotationEditing || !!cropLayerId || generationClose.isClosing(),
    onSelect: select, onFocus: (ids) => setImportFocus((previous) => ({ ids, token: (previous?.token ?? 0) + 1, externalToken: focus?.token })), onError: setError, onNotice: setNotice });
  const { importFiles, importBusy } = transfers;
  useSessionMedia({ document: design, current, blocked: busy || importBusy || !!cropLayerId || !!annotationEditing || !!generationClose.state, edit, onError: setError });
  const duplicate = () => { void transfers.duplicate(); };
  async function insertAsset(asset: Asset) {
    const before = current.current;
    const loaded = await assets.load(asset.id);
    try {
      if (!mounted.current || current.current.id !== before.id) return;
      const video = asset.mimeType.startsWith('video/');
      const width = video ? loaded.asset.width : loaded.image?.naturalWidth;
      const height = video ? loaded.asset.height : loaded.image?.naturalHeight;
      if (!width || !height) throw new Error(t('图片解码失败'));
      const center = view.current.center;
      const layer: Layer = { id: crypto.randomUUID(), type: video ? 'video' : 'image', assetId: asset.id, name: asset.name, x: center.x - width / 2, y: center.y - height / 2, width, height, rotation: 0, opacity: 1, visible: true, locked: false, ...(!video ? { lockAspectRatio: true } : {}) };
      if (await edit([{ type: 'insert', layer }], before.revision)) setSelected([layer.id]);
    } finally { loaded.release(); }
  }
  async function generate(request: GenerationRequest): Promise<void> {
    if (generationClose.isClosing()) throw new Error(t('正在处理关闭请求，请稍后重试。'));
    const documentId = current.current.id;
    const operation = call<{ generation: GenerationRecord; document: DesignDocument }>('generate', request);
    pendingGenerations.current.add(operation);
    try {
      const result = await operation;
      if (!mounted.current || current.current.id !== documentId) return;
      if (result.document.revision >= current.current.revision) { current.current = result.document; onDocument(result.document); }
    } finally {
      pendingGenerations.current.delete(operation);
      if (mounted.current && current.current.id === documentId) await refreshGenerations().catch((cause) => { if (mounted.current) setError(errorMessage(cause)); });
    }
  }
  async function cancelGeneration(generationId: string): Promise<void> {
    await call('generation_cancel', { documentId: design.id, generationId });
    if (mounted.current) await refreshGenerations();
  }
  function addText() {
    const center = view.current.center;
    const layer: Layer = { id: crypto.randomUUID(), type: 'text', name: t('文字'), text: t('双击编辑文字'), x: center.x - 180, y: center.y - 24, width: 360, height: 60, fontFamily: 'sans-serif', fontSize: 36, fontStyle: 'normal', fill: '#222222', align: 'left', lineHeight: 1.2, rotation: 0, opacity: 1, visible: true, locked: false };
    void edit([{ type: 'insert', layer }]).then((saved) => { if (saved) { setSelected([layer.id]); setPanel('properties'); } });
  }
  async function compose(request: GenerationRequest, operationName: string, annotation?: string): Promise<void> {
    const document = current.current;
    const attachments: NonNullable<AppComposeRequest['attachments']>[number][] = [];
    let totalBytes = 0;
    let hasPreview = false;
    async function attachImage(assetId: string, name?: string, crop?: ImageLayer['crop']) {
      const loaded = await assets.load(assetId);
      try {
        name ??= loaded.asset.name;
        const response = await fetch(loaded.url);
        if (!response.ok) throw new Error(t('无法读取参考图片，请重试。'));
        let blob = await response.blob();
        let image: CanvasImageSource | undefined = loaded.image;
        let width = loaded.image?.naturalWidth ?? 0;
        let height = loaded.image?.naturalHeight ?? 0;
        if (crop) {
          if (!loaded.image) throw new Error(t('图片解码失败'));
          const canvas = window.document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(crop.width));
          canvas.height = Math.max(1, Math.round(crop.height));
          const drawing = canvas.getContext('2d');
          if (!drawing) throw new Error(t('无法生成参考预览，请重试。'));
          drawing.drawImage(loaded.image, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
          blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(t('无法生成参考预览，请重试。'))), 'image/png'));
          image = canvas;
          width = canvas.width;
          height = canvas.height;
        }
        const projectPng = !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(blob.type || loaded.asset.mimeType);
        const isPreview = projectPng || blob.size > 5 * 1024 * 1024;
        if (isPreview) {
          if (!image) throw new Error(t('图片解码失败'));
          const canvas = window.document.createElement('canvas');
          const drawing = canvas.getContext('2d');
          if (!drawing) throw new Error(t('无法生成参考预览，请重试。'));
          if (projectPng) {
            canvas.width = width;
            canvas.height = height;
            drawing.drawImage(image, 0, 0);
            blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(t('无法生成参考预览，请重试。'))), 'image/png'));
          }
          if (blob.size > 5 * 1024 * 1024) {
            const scale = Math.min(1, 2048 / Math.max(width, height));
            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            drawing.fillStyle = '#ffffff';
            drawing.fillRect(0, 0, canvas.width, canvas.height);
            drawing.drawImage(image, 0, 0, canvas.width, canvas.height);
            blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error(t('无法生成参考预览，请重试。'))), 'image/jpeg', 0.85));
          }
          name = t(blob.type === 'image/png' ? '{name} · 参考预览.png' : '{name} · 参考预览.jpg', { name: name.slice(0, 140) });
          hasPreview = true;
        }
        if (blob.size > 5 * 1024 * 1024) throw new Error(t('参考图片仍超过 5 MiB，请减少图片尺寸后重试。'));
        totalBytes += blob.size;
        if (totalBytes > 20 * 1024 * 1024) throw new Error(t('参考附件总量超过 20 MiB，请减少选中的图片后重试。'));
        name = Array.from(name, (character) => character.charCodeAt(0) < 32 || character === '/' || character === '\\' ? '_' : character).join('').slice(0, 200);
        const attachmentIndex = attachments.length;
        attachments.push({ name, mimeType: blob.type || loaded.asset.mimeType, data: await fileData(blob) });
        return { assetId, attachmentIndex, attachmentName: name, isPreview, originalMimeType: loaded.asset.mimeType };
      } finally { loaded.release(); }
    }
    const sources = [];
    for (const [index, layerId] of (request.sourceLayerIds ?? []).entries()) {
      const layer = document.layers.find((entry) => entry.id === layerId);
      if (!layer || layer.type !== 'image') throw new Error(t('源图片已变更，请重新选择后重试。'));
      sources.push({ layerId, name: layer.name, ...(layer.crop ? { crop: layer.crop } : {}), ...await attachImage(layer.assetId, `${index + 1}-${layer.name}`, layer.crop) });
    }
    const references = [];
    for (const assetId of request.referenceAssetIds ?? []) references.push(await attachImage(assetId));
    const model = request.modelAssetId ? await attachImage(request.modelAssetId) : undefined;
    const logo = request.logoAssetId ? await attachImage(request.logoAssetId) : undefined;
    let annotationReference;
    if (annotation) {
      const name = t('选区标注图.png');
      const { asset } = await call<{ asset: Asset }>('asset_import', { name, mimeType: 'image/png', data: annotation });
      annotationReference = await attachImage(asset.id, `2-${name}`, sources[0]?.crop);
    }
    if (!mounted.current || current.current.id !== document.id || current.current.revision !== document.revision) throw new Error(t('源图片已变更，请重新选择后重试。'));
    const args = { ...request, ...(annotationReference ? { annotationAssetId: annotationReference.assetId,
      expectedSourceAssetId: sources[0].assetId, expectedSourceCrop: sources[0].crop ?? null } : {}) };
    const requests = request.action === 'upscale' && (request.sourceLayerIds?.length ?? 0) > 1 ? request.sourceLayerIds!.map((id) => ({ ...args, sourceLayerIds: [id] })) : [args];
    const operation: DesignComposeOperation = {
      summary: { name: operationName, imageCountNames: Array.from({ length: attachments.length + 1 }, (_, count) => count ? t('{name} · {count} 张图片', { name: operationName, count }) : operationName) },
      toolName: appToolName(app().pluginId, 'generate'),
      instructions: t('逐项调用 toolName，保留 requests 中所有结构化参数、文档、图层和资产 ID。本项操作的当前可编辑要求作为 request.prompt，用户独立正文仅作补充；要求清空时保持空值，不回填 requests 中的旧 prompt，也不借用另一项操作的要求。若该操作必须填写要求，先请用户补充，不执行。执行使用 sourceLayerIds 的当前有效裁剪画面、有序 referenceAssetIds 独立参考、modelAssetId 人物图、logoAssetId Logo 和 annotationAssetId 标注图，不改用预览或外部 URL。人物图和 Logo 是独立参考，不是商品。局部修改按原图、紫色标注图的顺序提交，标注只定位区域，不是蒙版。'),
      document: { id: document.id, revision: document.revision, ...(document.sessionIdentity ? { sessionIdentity: document.sessionIdentity } : {}) },
      sources, ...(references.length ? { references } : {}), ...(model ? { model } : {}), ...(logo ? { logo } : {}), ...(annotationReference ? { annotation: annotationReference } : {}), requests,
    };
    const context = { groupKey: `${document.id}:${request.action}`, attachmentRemoval: { tool: 'compose_edit' }, name: attachments.length ? t('{name} · {count} 张图片', { name: operationName, count: attachments.length }) : operationName, text: JSON.stringify(operation, null, 2), attachmentIndices: attachments.map((_, index) => index) };
    if (new TextEncoder().encode(context.text).byteLength > 32 * 1024) throw new Error(t('设计操作上下文超过 32 KiB，请减少分镜或创作要求后重试。'));
    if (attachments.length > 16) throw new Error(t('附件超过对话限制，请减少参考图片后重试。'));
    if (generationClose.isClosing()) throw new Error(t('正在处理关闭请求，请稍后重试。'));
    await app().compose({ text: [request.prompt || t('请按设计操作上下文中的要求处理画板图片。'), hasPreview ? t('已附图片参考预览；执行时请使用插件中保存的原图，保持原图不变。') : ''].filter(Boolean).join('\n\n'), attachments, context });
    setNotice(t(isExternalApp() ? '已添加到客户端对话' : '已添加到对话，请在对话中确认并发送'));
  }
  async function defaultImageModel() {
    const directory = await call<AppMediaModelList>('media_models', { kind: 'image' });
    const model = directory.models.find((entry) => entry.selectionId === directory.defaultSelectionId);
    if (!model) throw new Error(t('请选择可用的媒体模型。'));
    return model;
  }
  async function confirmAnnotation(data: string): Promise<void> {
    if (lock.current || !annotationLayer || !annotationTool) return;
    lock.current = true;
    setBusy(true);
    try {
      if (annotationTool === 'erase') {
        const before = current.current;
        const model = await defaultImageModel();
        if (model.capabilities.maxImages < 2) throw new Error(t('当前模型最多接收 {count} 张参考图（含人物或 Logo），请移除多余图片。', { count: model.capabilities.maxImages }));
        const { asset } = await call<{ asset: Asset }>('asset_import', { name: t('选区标注图.png'), mimeType: 'image/png', data });
        if (!mounted.current || current.current.id !== before.id || current.current.revision !== before.revision) throw new Error(t('源图片已变更，请重新选择后重试。'));
        await generate({ documentId: before.id, action: 'erase', prompt: '', selectionId: model.selectionId, sourceLayerIds: [annotationLayer.id], annotationAssetId: asset.id,
          expectedSourceAssetId: annotationLayer.assetId, expectedSourceCrop: annotationLayer.crop ?? null });
      } else {
        await compose({
          documentId: design.id, action: 'edit',
          prompt: t('图1为原图，图2为选区标注图。请根据图2的紫色框选或涂抹定位修改区域，以图1为基础编辑，结果中不要保留标记，并保持其他画面内容不变。请在发送前补充具体修改要求。'),
          sourceLayerIds: [annotationLayer.id],
        }, t(toolTitles[annotationTool]), data);
      }
      if (mounted.current) { setCreativeTool(null); setTool('select'); }
    } finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]') || window.document.querySelector('[role="dialog"]')) return;
      const command = event.metaKey || event.ctrlKey;
      if (cropLayerId) return;
      if (annotationEditing) {
        if (event.key === 'Escape') { event.preventDefault(); if (!lock.current) { setCreativeTool(null); setTool('select'); } }
        else if (!command && event.key.toLowerCase() === 'v') setTool('select');
        else if (!command && event.key.toLowerCase() === 'h') setTool('hand');
        else if (command || ['Delete', 'Backspace', 't'].includes(event.key)) event.preventDefault();
        return;
      }
      if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); if (!busy) void mutation(event.shiftKey ? 'document_redo' : 'document_undo', {}); }
      else if (command && event.key.toLowerCase() === 'y') { event.preventDefault(); if (!busy) void mutation('document_redo', {}); }
      else if (command && event.key.toLowerCase() === 'd') { event.preventDefault(); if (!busy) duplicate(); }
      else if (command && event.key.toLowerCase() === 'a') { event.preventDefault(); select(design.layers.filter((layer) => layer.visible && !layer.locked).map((layer) => layer.id)); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); if (!busy) remove(); }
      else if (event.key === 'Escape') { setSelected([]); setTool('select'); }
      else if (!command && event.key.toLowerCase() === 'v') setTool('select');
      else if (!command && event.key.toLowerCase() === 'h') setTool('hand');
      else if (!command && event.key.toLowerCase() === 't' && !busy) addText();
    };
    const transfer = (event: ClipboardEvent) => {
      if ((event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]') || window.document.querySelector('[role="dialog"]') || annotationEditing || cropLayerId) return;
      if (event.type === 'copy') transfers.handleCopy(event);
      else transfers.handlePaste(event, view.current.getPointer?.());
    };
    window.addEventListener('keydown', key);
    window.addEventListener('copy', transfer);
    window.addEventListener('paste', transfer);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('copy', transfer); window.removeEventListener('paste', transfer); };
  });

  const disabled = busy || importBusy || !!generationClose.state;
  const singleImage = selectedLayers.length === 1 && selectedImages.length === 1;
  const openTool = (next: CreativeTool) => {
    if (lock.current || importBusy || generationClose.isClosing()) return;
    setCropLayerId(null);
    setImagePreview(null);
    setStoryboardRecord(undefined);
    if (next === 'white' || next === 'upscale' || next === 'watermark' || next === 'erase-text' || next === 'remove-background') {
      setCreativeTool(null);
      setPanel(null);
      if (!selectedImages.length) return;
      const sources = [...selectedImages];
      lock.current = true;
      setBusy(true);
      setError('');
      void (async () => {
        const model = await defaultImageModel();
        if (model.capabilities.maxImages < 1) throw new Error(t('当前模型不支持参考图片，请选择其他模型。'));
        for (const layer of sources) {
          if (!mounted.current) break;
          await generate({ documentId: design.id, action: next, prompt: '', sourceLayerIds: [layer.id], selectionId: model.selectionId });
        }
      })().catch((cause) => { if (mounted.current) setError(errorMessage(cause)); }).finally(() => { lock.current = false; if (mounted.current) setBusy(false); });
      return;
    }
    if (['rectangle', 'brush', 'erase'].includes(next) && !singleImage) { setError(t('请先在画布中选择图片。')); return; }
    setPanel(null);
    setTool('select');
    setCreativeTool(next);
  };
  function previewImage(layerId: string, changes: LayerPatch | null) {
    setImagePreview((previous) => changes ? { layerId, revision: current.current.revision, changes } : previous?.layerId === layerId ? null : previous);
  }
  const canvasDocument = imagePreview?.revision === design.revision
    ? { ...design, layers: design.layers.map((layer) => layer.id === imagePreview.layerId ? { ...layer, ...imagePreview.changes } as Layer : layer) }
    : design;
  function editStoryboard(record?: GenerationRecord) {
    setCreativeTool('storyboard');
    setStoryboardRecord(record);
    setPanel(null);
    setCropLayerId(null);
    setImagePreview(null);
  }
  function showPanel(next: typeof panel) {
    setCreativeTool(null);
    setCropLayerId(null);
    setImagePreview(null);
    setPanel(next);
  }
  function startCrop() {
    if (!singleImage || disabled || selectedImages[0].locked) return;
    setCreativeTool(null);
    setPanel(null);
    setImagePreview(null);
    setCropLayerId(selectedImages[0].id);
  }
  function downloadOriginal() {
    const media = selectedLayers.filter((layer) => layer.type !== 'text');
    void (async () => {
      const seen = new Set<string>();
      for (const layer of media) {
        if (seen.has(layer.assetId)) continue;
        seen.add(layer.assetId);
        const loaded = await assets.load(layer.assetId);
        if (!mounted.current) { loaded.release(); return; }
        download(loaded.url, loaded.asset.name, loaded.release);
      }
    })().catch((cause) => { if (mounted.current) setError(errorMessage(cause)); });
  }
  const displayedError = hostError || error || transfers.copyOriginal.error;
  const focusImported = importFocus && importFocus.externalToken === focus?.token;
  const selectedVideo = selectedLayers.length === 1 && selectedLayers[0].type === 'video' ? selectedLayers[0] : undefined;
  const videoRecord = selectedVideo ? generations.find((record) => record.action === 'storyboard' && record.assets.some((asset) => asset.id === selectedVideo.assetId)) : undefined;
  const selectionAbilities: Ability[] = selectedImages.length ? [
    ...(singleImage ? [{ id: 'rectangle', label: t('局部修改'), icon: <CanvasIcon name="rect_repaint" />, disabled, onClick: () => openTool('rectangle') }] : []),
    { id: 'cutout', label: t('抠图'), icon: <CanvasIcon name="white_bg" />, disabled, children: [
      { id: 'transparent', label: t('透明背景'), disabled, onClick: () => openTool('remove-background') },
      { id: 'white', label: t('白底图'), disabled, onClick: () => openTool('white') },
    ] },
    { id: 'upscale', label: t('高清'), icon: <CanvasIcon name="hd" />, disabled, onClick: () => openTool('upscale') },
    ...(singleImage ? [
      { id: 'text', label: t('文字'), icon: <Type size={16} />, disabled, children: [
        { id: 'modify-text', label: t('编辑文字'), disabled, onClick: () => openTool('text') },
        { id: 'erase-text', label: t('擦除文字'), disabled, onClick: () => openTool('erase-text') },
      ] },
      { id: 'erase', label: t('消除'), icon: <CanvasIcon name="eraser" />, disabled, onClick: () => openTool('erase') },
    ] : []),
  ] : selectedVideo ? [{ id: 'storyboard', label: t(videoRecord?.editing?.scenes?.length ? '编辑分镜脚本' : '新建分镜脚本'), icon: <CanvasIcon name="prompt_video" />, disabled, onClick: () => editStoryboard(videoRecord) }]
    : [{ id: 'text-properties', label: t('编辑文字'), icon: <Type size={16} />, disabled, onClick: () => showPanel('properties') }];
  const selectionExtras: Ability[] = selectedImages.length ? [
    ...(singleImage ? [
      { id: 'angle', label: t('变换视角'), disabled, onClick: () => openTool('angle') },
      { id: 'translate', label: t('翻译'), icon: <CanvasIcon name="translate" />, disabled, onClick: () => openTool('translate') },
    ] : []),
    { id: 'watermark', label: t('水印擦除'), icon: <CanvasIcon name="watermark_removal" />, disabled, onClick: () => openTool('watermark') },
    ...(singleImage ? [
      { id: 'crop', label: t('裁剪'), icon: <Crop size={16} />, disabled: disabled || selectedImages[0].locked, onClick: startCrop },
      { id: 'adjustments', label: t('调整'), icon: <SlidersHorizontal size={16} />, disabled, onClick: () => showPanel('adjustments') },
      { id: 'brush', label: t('涂抹重绘'), icon: <CanvasIcon name="brush_repaint" />, disabled, onClick: () => openTool('brush') },
    ] : []),
    { id: 'resize', label: t('改尺寸'), icon: <CanvasIcon name="resize" />, disabled, onClick: () => openTool('resize') },
    { id: 'properties', label: t('编辑'), icon: <Settings2 size={16} />, disabled, onClick: () => showPanel('properties') },
    { id: 'export', label: t('导出'), icon: <CanvasIcon name="download" />, disabled, onClick: () => showPanel('export') },
    { id: 'layers', label: t('图层'), icon: <LayersIcon size={16} />, onClick: () => showPanel('layers') },
  ] : [{ id: 'properties', label: t('图层属性'), icon: <Settings2 size={16} />, disabled, onClick: () => showPanel('properties') }];
  const bottomTools = [
    { mode: 'product-scene' as const, icon: 'scene' as const, label: '商品场景图' },
    { mode: 'recolor' as const, icon: 'recolor' as const, label: '商品换色' },
    { mode: 'model-display' as const, icon: 'model' as const, label: '模特展示图' },
    { mode: 'logo' as const, icon: 'logo' as const, label: 'Logo效果图' },
    { mode: 'scene-video' as const, icon: 'scene_video' as const, label: '场景视频' },
    { mode: 'multi-shot' as const, icon: 'prompt_video' as const, label: '多镜头视频推荐' },
  ];
  const selectionToolbar = <AbilityToolbar label={t('选区工具')} items={selectionAbilities} width={Math.min(800, Math.max(240, viewportWidth - 80))} extras={selectionExtras} pinned={<><span className="ic-toolbar-divider" />{selectedLayers.some((layer) => layer.type !== 'text') && <button className="ic-tool-btn" title={t('下载原始文件')} aria-label={t('下载原始文件')} disabled={disabled} onClick={downloadOriginal}><CanvasIcon name="download" /></button>}<button className="ic-tool-btn" title={t('删除')} aria-label={t('删除')} disabled={disabled || selectedLayers.every((layer) => layer.locked) || selectedLayers.filter((layer) => !layer.locked).length >= design.layers.length} onClick={remove}><CanvasIcon name="delete" /></button></>} />;
  return <main className={`image-canvas-tldraw-container${dragOver ? ' drag-over' : ''}`} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragOver(true); } }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }} onDrop={(event) => { event.preventDefault(); setDragOver(false); if (cropLayerId || annotationEditing) return; void importFiles([...event.dataTransfer.files], view.current.clientToWorld?.(event.clientX, event.clientY)); }}>
    <Canvas document={canvasDocument} images={assets.images} selected={selected} tool={tool} busy={disabled} generations={generations} loadAsset={assets.load} focusLayerId={focusImported ? undefined : focus?.layerId} focusLayerIds={focusImported ? importFocus.ids : undefined} focusToken={focusImported ? `import:${importFocus.token}` : focus?.token} annotationConfirmLabel={annotationTool === 'erase' ? t('消除') : undefined} onSelect={select} onEdit={edit} onTool={setTool} onUpload={() => input.current?.click()} onAddText={addText} onRectangle={() => openTool('rectangle')} cropEditing={cropLayerId && selectedImages.some((layer) => layer.id === cropLayerId) ? { layerId: cropLayerId } : undefined} onCropConfirm={async (changes) => { if (!cropLayerId) return false; const saved = await edit([{ type: 'patch', id: cropLayerId, changes }]); if (saved) setCropLayerId(null); return saved; }} onCropCancel={() => setCropLayerId(null)} onPreviewAsset={setPreviewAssetId} annotationEditing={annotationEditing} onAnnotationConfirm={confirmAnnotation} onAnnotationCancel={() => { if (!lock.current) { setCreativeTool(null); setTool('select'); } }} onViewChange={(next) => { view.current = next; setViewportWidth(next.width); }} selectionToolbar={selectionToolbar} />
    {!design.layers.length && !generations.some((entry) => entry.state === 'running') && <div className="ic-empty-hint">{t('输入想法开始创作')}</div>}
    {!annotationEditing && !cropLayerId && <div className="ic-bottom-chrome"><AbilityToolbar label={t('创作工具')} bottom width={Math.max(240, viewportWidth - 32)} items={[
      { id: 'copy', label: t(transfers.copyOriginal.status === 'preparing' ? '正在准备原图…' : transfers.copyOriginal.status === 'writing' ? '正在复制原图…' : '复制原图'), icon: <Copy size={16} />, disabled: disabled || ['disabled', 'preparing', 'writing'].includes(transfers.copyOriginal.status), onClick: () => void transfers.copyOriginal.write() },
      ...bottomTools.map((entry) => ({ id: entry.mode, label: t(entry.label), icon: <CanvasIcon name={entry.icon} />, disabled, onClick: () => openTool(entry.mode) })),
    ]} extras={[
      { id: 'image', label: t('生成图片'), icon: <Plus size={16} />, onClick: () => openTool('image') },
      { id: 'video', label: t('指令视频'), onClick: () => openTool('video') },
      { id: 'storyboard', label: t('多镜头生成与合成'), onClick: () => editStoryboard() },
      { id: 'text', label: t('添加文字'), icon: <Type size={16} />, disabled, onClick: addText },
      { id: 'layers', label: t('图层'), icon: <LayersIcon size={16} />, onClick: () => setPanel('layers') },
    ]} /></div>}
    {!annotationEditing && !cropLayerId && <div className="ic-history-controls ic-pill"><button className="ic-pill-btn" aria-label={t('撤销')} title={t('撤销 Ctrl/⌘ Z')} disabled={disabled} onClick={() => void mutation('document_undo', {})}><Undo2 size={16} /></button><button className="ic-pill-btn" aria-label={t('重做')} title={t('重做 Ctrl/⌘ Shift Z')} disabled={disabled} onClick={() => void mutation('document_redo', {})}><Redo2 size={16} /></button><button className="ic-pill-btn" aria-label={t('生成记录')} title={t('生成记录')} onClick={() => { setCreativeTool(null); setPanel(panel === 'history' ? null : 'history'); }}><History size={16} /></button></div>}
    {notice && <div className="ic-save-status" role="status">{notice}</div>}
    {importBusy && <div className="canvas-loading" role="status">{t('正在导入图片…')}</div>}
    {generations.some((entry) => entry.state === 'running') && <div className="ic-task-status" role="status"><i />{t(generations.some((entry) => entry.state === 'running' && (entry.action === 'video' || entry.action === 'storyboard')) ? '视频生成中…' : 'AI 生成中…')}</div>}
    {displayedError && <div className="editor-error" role="alert"><span>{displayedError}</span><button title={t(hostError || error ? '重新读取' : '重试')} aria-label={t(hostError || error ? '重新读取' : '重试')} onClick={() => { if (hostError) onHostRetry(); else if (error) { setError(''); setAssetAttempt((value) => value + 1); void refresh().catch((cause) => setError(errorMessage(cause))); } else transfers.copyOriginal.retry(); }}><RefreshCw size={13} /></button><button className="icon small" aria-label={t('关闭错误提示')} onClick={() => { if (hostError) onHostErrorDismiss(); else if (error) setError(''); else transfers.copyOriginal.dismiss(); }}><X size={14} /></button></div>}
    {creativeTool === 'text' && annotationLayer && <TextEditor documentId={design.id} documentRevision={design.revision} layer={annotationLayer} load={assets.load} onSubmit={generate} onClose={() => setCreativeTool(null)} />}
    {creativeTool && creativeTool !== 'rectangle' && creativeTool !== 'brush' && creativeTool !== 'erase' && creativeTool !== 'text' && creativeTool !== 'white' && creativeTool !== 'upscale' && creativeTool !== 'watermark' && creativeTool !== 'erase-text' && <Generation key={`${creativeTool}:${storyboardRecord?.id ?? ''}`} tool={creativeTool} documentId={design.id} layers={creativeTool === 'storyboard' && storyboardRecord ? design.layers.filter((layer) => layer.type === 'image' && storyboardRecord.sourceLayerIds?.includes(layer.id)) : selectedLayers} initialRecord={storyboardRecord} load={assets.load} onCompose={compose} onGenerate={generate} onClose={() => setCreativeTool(null)} />}
    {panel && <section className={`ic-floating-panel ic-panel-${panel}`} role="dialog" aria-label={t(panel === 'layers' ? '图层' : panel === 'properties' ? '图层属性' : panel === 'adjustments' ? '调整' : panel === 'history' ? '生成记录' : '导出图片')} onKeyDown={(event) => { if (event.key === 'Escape') showPanel(null); }}>{panel !== 'adjustments' && <header><h2>{t(panel === 'layers' ? '图层' : panel === 'properties' ? '图层属性' : panel === 'history' ? '生成记录' : '导出图片')}</h2><button className="icon small" aria-label={t('关闭面板')} onClick={() => showPanel(null)}><X size={16} /></button></header>}
      {panel === 'layers' && <Layers layers={design.layers} selected={selected} busy={disabled} onSelect={select} onEdit={edit} />}
      {panel === 'adjustments' && singleImage && <ImageAdjustments key={`${design.id}:${design.revision}:${selectedImages[0].id}`} layer={selectedImages[0]} busy={disabled} onPreview={previewImage} onEdit={edit} onClose={() => showPanel(null)} />}
      {panel === 'properties' && <Properties document={design} selected={selected} busy={disabled} onPreview={previewImage} onEdit={edit} onDuplicate={duplicate} onDelete={remove} />}
      {panel === 'history' && <GenerationHistory generations={generations} load={assets.load} onInsert={insertAsset} onCancel={cancelGeneration} onEditStoryboard={editStoryboard} />}
      {panel === 'export' && <Export document={design} selected={selected} onClose={() => setPanel(null)} onNotice={setNotice} />}
    </section>}
    {generationClose.state && <GenerationCloseDialog state={generationClose.state} onConfirm={generationClose.confirm} onStay={generationClose.stay} />}
    {previewAssetId && <MediaPreview assets={[...new Set([...design.layers.flatMap((layer) => layer.type === 'text' ? [] : [layer.assetId]), ...generations.flatMap((record) => record.assets.map((asset) => asset.id))])].flatMap((id) => assets.entries.get(id)?.asset ?? [])} initialAssetId={previewAssetId} load={assets.load} onClose={() => setPreviewAssetId(null)} />}
    {dragOver && <div className="drop-indicator"><CanvasIcon name="upload_image" size={24} />{t('松开以导入图片')}</div>}
    <input ref={input} className="visually-hidden" type="file" accept="image/*" multiple aria-label={t('导入图片文件')} onChange={(event) => { void importFiles([...(event.target.files ?? [])]); event.target.value = ''; }} />
  </main>;
}
