import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { isAppPixelSizeSupported, type AppMediaModelList } from '@matcha/app-plugins-sdk';
import type { AnglePreset, Asset, GenerationRecord, GenerationRequest, ImageLayer, Layer } from '../document';
import type { LoadedAsset } from './useAssets';
import { call, errorMessage, isExternalApp } from './api';
import i18n, { useTranslation } from './i18n';
import { AnglePresets } from './AnglePresets';
import { ProductReferences } from './ProductReferences';
import { RecolorFields } from './RecolorFields';
import { Recommendations } from './Recommendations';
import { AssetImage, ReferenceImages } from './ReferenceImages';
import { StoryboardEditor, type StoryboardScene } from './StoryboardEditor';
import { toolTitles, type GenerationTool } from './tools';
import './Generation.css';

const aspectRatios = ['1:1', '4:5', '5:4', '9:16', '16:9', '4:3', '3:4', '2:3', '3:2', '21:9'];
const languages = [
  { code: 'zh-CN', name: '简体中文' }, { code: 'en', name: '英语' },
  { code: 'ja', name: '日语' }, { code: 'ru', name: '俄语' },
];
interface Props {
  tool: GenerationTool;
  documentId: string;
  layers: Layer[];
  initialRecord?: GenerationRecord;
  load(assetId: string): Promise<LoadedAsset>;
  onCompose(request: GenerationRequest, operationName: string): Promise<void>;
  onGenerate(request: GenerationRequest): Promise<void>;
  onClose(): void;
}

export function Generation({ tool, documentId, layers, initialRecord, load, onCompose, onGenerate, onClose }: Props) {
  const { t } = useTranslation();
  const initial = tool === 'storyboard' ? initialRecord : undefined;
  const editing = initial?.editing;
  const [prompt, setPrompt] = useState(() => initial?.prompt ?? '');
  const [size, setSize] = useState(() => editing?.size ?? '');
  const [count, setCount] = useState(1);
  const [duration, setDuration] = useState<number | undefined>(() => editing?.durationSeconds);
  const [scenes, setScenes] = useState<StoryboardScene[]>(() => (editing?.scenes?.length ? editing.scenes : [{ prompt: '' }]).map((scene) => ({ ...scene, id: crypto.randomUUID(), durationSeconds: scene.durationSeconds ?? editing?.durationSeconds })));
  const [referenceAssetIds, setReferenceAssetIds] = useState<string[]>(() => [...(editing?.referenceAssetIds ?? [])]);
  const [logoAsset, setLogoAsset] = useState<Asset | null>(null);
  const [modelAsset, setModelAsset] = useState<Asset | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [colors, setColors] = useState<NonNullable<GenerationRequest['colors']>>([{ hex: '#1ead6f', opacity: 100 }]);
  const [material, setMaterial] = useState('');
  const [model, setModel] = useState('');
  const [excluded, setExcluded] = useState<string[]>([]);
  const [anglePreset, setAnglePreset] = useState<AnglePreset>('front');
  const [modelResult, setModelResult] = useState<{ kind: 'image' | 'video'; attempt: number; models?: AppMediaModelList; error?: string } | null>(null);
  const [modelAttempt, setModelAttempt] = useState(0);
  const [selectionId, setSelectionId] = useState(() => editing?.selectionId ?? '');
  const section = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  const submitting = useRef(false);
  const sourceLayers = layers.filter((layer): layer is ImageLayer => layer.type === 'image' && !excluded.includes(layer.id));
  const sourceIds = sourceLayers.map((layer) => layer.id);
  const missingSources = (initial?.sourceLayerIds ?? []).filter((id) => !excluded.includes(id) && !sourceIds.includes(id));
  const recommendationLayers = tool === 'product-scene' ? sourceLayers.slice(0, 1) : sourceLayers;
  const recommendationSources = recommendationLayers.map((layer) => layer.id);
  const recommendationReferences = tool === 'scene-video' || tool === 'multi-shot' ? referenceAssetIds : [];
  const sourceKey = JSON.stringify([documentId, recommendationLayers.map((layer) => [layer.id, layer.assetId, layer.crop ? [layer.crop.x, layer.crop.y, layer.crop.width, layer.crop.height] : null]), recommendationReferences, i18n.resolvedLanguage ?? i18n.language]);
  const [recommendation, setRecommendation] = useState({ sourceKey: '', prompt: '' });
  const selectRecommendation = useCallback((value: string) => setRecommendation({ sourceKey, prompt: value }), [sourceKey]);
  const recommendedPrompt = recommendation.sourceKey === sourceKey ? recommendation.prompt : '';
  const video = tool === 'video' || tool === 'scene-video' || tool === 'multi-shot' || tool === 'storyboard';
  const kind = video ? 'video' : 'image';
  const currentModels = modelResult?.kind === kind && modelResult.attempt === modelAttempt ? modelResult : null;
  const models = currentModels?.models;
  const modelError = currentModels?.error;
  const direct = tool === 'resize' || tool === 'translate' || tool === 'remove-background' || tool === 'angle';
  const execute = direct || tool === 'storyboard';
  const popover = execute;
  const needsSource = !['image', 'video', 'storyboard', 'scene-video', 'multi-shot'].includes(tool);
  const recommendationKind = tool === 'product-scene' || tool === 'scene-video' || tool === 'multi-shot' ? tool : null;
  const recommendationLimit = tool === 'scene-video' ? 1 : tool === 'multi-shot' ? 4 : undefined;
  const caps = models?.models.find((entry) => entry.selectionId === selectionId)?.capabilities;
  const busy = adding || uploading;
  const external = isExternalApp();
  const independentImages = (tool === 'logo' && logoAsset ? 1 : 0) + (tool === 'model-display' && modelAsset ? 1 : 0) + (video ? referenceAssetIds.length : 0);
  const referenceCount = sourceIds.length + independentImages;
  const maxImages = caps ? Math.min(16, caps.maxImages) : 0;
  const recommendationCount = recommendationSources.length + recommendationReferences.length;
  const recommendationError = tool === 'scene-video' && recommendationCount !== 1 ? t('场景视频推荐需要且仅分析 1 张参考图片（画布或独立上传）。')
    : tool === 'multi-shot' && (recommendationCount < 1 || recommendationCount > 4) ? t('多镜头推荐需要 1 至 4 张参考图片（含画布和独立上传）。') : '';
  const referenceError = missingSources.length ? t('原分镜的部分画布参考已删除，无法恢复。请确认不再使用后继续。')
    : tool === 'angle' && sourceIds.length !== 1 ? t('变换视角需要且仅使用 1 张图片。')
    : referenceAssetIds.some((id) => sourceLayers.some((layer) => layer.assetId === id && !layer.crop)) ? t('独立参考与画布参考重复，请移除重复图片。')
    : caps && (direct ? sourceIds.length > 0 && caps.maxImages < 1 : referenceCount > maxImages) ? t('当前模型最多接收 {count} 张参考图（含画布、人物或 Logo）。', { count: maxImages }) : '';
  const allowedDurations = caps?.durationsSeconds;
  const selectedDuration = duration ?? allowedDurations?.[0];
  const selectedSize = size.trim() || (video ? caps?.sizes?.[0] ?? '' : '');
  const durationError = caps && tool === 'storyboard' && scenes.some((scene) => scene.durationSeconds !== undefined && !allowedDurations?.includes(scene.durationSeconds))
    ? t('原分镜时长不受当前模型支持，请重新选择每个镜头的时长。')
    : caps && video && tool !== 'storyboard' && duration !== undefined && !allowedDurations?.includes(duration) ? t('原视频时长不受当前模型支持，请重新选择时长。') : '';
  const canSubmit = !!caps && !busy && !referenceError && !recommendationError && !durationError && (!needsSource || sourceIds.length > 0);

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement as HTMLElement | null;
    section.current?.querySelector<HTMLElement>('textarea,input:not([type="file"]),select,button')?.focus();
    return () => { mounted.current = false; previous?.focus(); };
  }, []);
  useEffect(() => {
    let live = true;
    void call<AppMediaModelList>('media_models', { kind }).then((models) => {
      if (!live) return;
      setModelResult({ kind, attempt: modelAttempt, models });
      setSelectionId((previous) => previous || models.defaultSelectionId || '');
    }).catch((cause) => { if (live) setModelResult({ kind, attempt: modelAttempt, error: errorMessage(cause) }); });
    return () => { live = false; };
  }, [kind, modelAttempt]);

  async function generateDirect(action: 'resize' | 'translate' | 'remove-background' | 'angle', options: Pick<GenerationRequest, 'aspectRatio' | 'targetLanguage' | 'anglePreset'> = {}) {
    if (submitting.current || uploading) return;
    setError('');
    if (!caps) { setError(t('请选择可用的媒体模型。')); return; }
    if (!sourceIds.length) { setError(t('请先在画布中选择图片。')); return; }
    if (referenceError) { setError(referenceError); return; }
    if (caps.maxImages < 1) { setError(t('当前模型不支持参考图片，请选择其他模型。')); return; }
    submitting.current = true;
    setAdding(true);
    try {
      for (const layerId of sourceIds) {
        await onGenerate({ documentId, action, prompt: '', sourceLayerIds: [layerId], selectionId, ...options });
        if (!mounted.current) return;
        // Completed images leave this batch so a later failure cannot resubmit them.
        setExcluded((previous) => [...previous, layerId]);
      }
      onClose();
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { submitting.current = false; if (mounted.current) setAdding(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (tool === 'resize' || tool === 'translate') return;
    if (tool === 'angle') { await generateDirect(tool, { anglePreset }); return; }
    if (tool === 'remove-background') { await generateDirect(tool); return; }
    if (submitting.current || uploading) return;
    setError('');
    if (!caps) { setError(t('请选择可用的媒体模型。')); return; }
    if (needsSource && !sourceIds.length) { setError(t('请先在画布中选择图片。')); return; }
    if (referenceError || recommendationError || durationError) { setError(referenceError || recommendationError || durationError); return; }
    if (tool === 'logo' && !logoAsset) { setError(t('请上传需要定制到商品上的 Logo 图片。')); return; }
    if (tool === 'logo' && !material.trim()) { setError(t('请输入自定义工艺要求。')); return; }
    if (tool === 'logo' && material.trim().length > 2000) { setError(t('自定义工艺不能超过 2000 字，请缩短后重试。')); return; }
    if (tool === 'model-display' && !modelAsset && !model.trim()) { setError(t('请上传人物照片或填写模特描述。')); return; }
    if (tool === 'recolor' && (colors.length < 1 || colors.length > 8 || colors.some((color) => !/^#[0-9a-fA-F]{6}$/.test(color.hex) || !Number.isInteger(color.opacity) || color.opacity < 0 || color.opacity > 100))) {
      setError(t('请应用 1 至 8 个有效颜色，不透明度须为 0 至 100 的整数。')); return;
    }
    if (recommendationKind && !recommendedPrompt.trim()) { setError(t('请先选择一条图片推荐。')); return; }
    if ((tool === 'image' || tool === 'video') && !prompt.trim()) { setError(t('请输入创作要求。')); return; }
    if (tool === 'storyboard' && (scenes.length < 1 || scenes.length > 24 || scenes.some((scene) => !scene.prompt.trim()))) { setError(t('请填写 1 至 24 个镜头的内容。')); return; }
    if (selectedSize && !caps.sizes?.includes(selectedSize) && !(caps.pixelSize && caps.pixelSizeLimits && isAppPixelSizeSupported(selectedSize, caps.pixelSizeLimits))) {
      setError(t('请选择模型支持的尺寸，或输入宽x高像素。')); return;
    }
    if (!Number.isInteger(count) || count < 1 || count > Math.min(8, caps.maxCount)) { setError(t('生成数量超出当前模型支持范围。')); return; }
    const businessPrompt = tool === 'recolor' ? t('按所选色卡更换商品颜色，保留原有材质、纹理和光影。')
      : tool === 'logo' ? t('将独立 Logo 按自定义工艺应用到商品，保持商品与 Logo 细节准确。')
      : tool === 'model-display' ? [t('让模特自然展示所选商品，保持商品细节准确。'), model.trim()].filter(Boolean).join('\n')
      : '';
    const combinedPrompt = [businessPrompt, recommendedPrompt.trim(), prompt.trim()].filter(Boolean).join('\n');
    if (combinedPrompt.length > 20000) { setError(t('合并后的创作要求超过 20000 字，请缩短模板、推荐、模特描述或补充要求。')); return; }
    const action = tool === 'scene-video' || tool === 'multi-shot' ? 'video' : tool;
    const request: GenerationRequest = {
      documentId, action, selectionId, sourceLayerIds: sourceIds,
      prompt: combinedPrompt,
      ...(video ? { referenceAssetIds } : {}),
      ...(tool === 'logo' && logoAsset ? { logoAssetId: logoAsset.id, material: material.trim() } : {}),
      ...(tool === 'model-display' && modelAsset ? { modelAssetId: modelAsset.id } : {}),
      ...(tool === 'recolor' ? { colors } : {}),
      ...(selectedSize ? { size: selectedSize } : {}),
      ...(tool === 'storyboard' ? { count: 1, scenes: scenes.map((scene) => ({ prompt: scene.prompt.trim(),
        ...((scene.durationSeconds ?? allowedDurations?.[0]) !== undefined ? { durationSeconds: scene.durationSeconds ?? allowedDurations?.[0] } : {}) })) }
        : { count, ...(video && selectedDuration !== undefined ? { durationSeconds: selectedDuration } : {}) }),
    };
    submitting.current = true;
    setAdding(true);
    try {
      if (tool === 'storyboard') await onGenerate(request);
      else await onCompose(request, t(toolTitles[tool]));
      if (mounted.current) onClose();
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)); }
    finally { submitting.current = false; if (mounted.current) setAdding(false); }
  }

  return <div className={popover ? 'ic-tool-popover-wrap' : 'ic-dialog-backdrop'} onMouseDown={(event) => { if (!popover && event.target === event.currentTarget && !busy) onClose(); }} onDragOver={(event) => event.stopPropagation()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); }}>
    <section ref={section} className={`ic-creative-dialog ic-dialog-${tool}${popover ? ' ic-creative-popover' : ''}`} role="dialog" aria-modal={!popover} aria-labelledby="creative-title" aria-busy={adding} onKeyDown={(event) => {
      if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); }
      if (event.key === 'Tab' && !popover) {
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type="hidden"]):not([type="file"]),textarea:not(:disabled),select:not(:disabled)')];
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    }}><header><h2 id="creative-title">{t(toolTitles[tool])}</h2><button type="button" className="icon small" aria-label={t('关闭')} disabled={busy} onClick={onClose}><X size={18} /></button></header>
      <form onSubmit={(event) => void submit(event)}>
        <div className="ic-creative-body">
          {tool === 'storyboard' && <>
            <p className="quiet">{t('逐镜独立生成视频，再按脚本顺序本地合成 MP4；不保证镜头间的主体或风格一致。')}</p>
            <p className="quiet" role="status">{t(editing?.scenes?.length ? '修改脚本后将新建生成任务，原视频和原记录保持不变。' : '当前没有可恢复的分镜脚本。以下是新建脚本，不是还原原视频。')}</p>
          </>}
          {tool === 'multi-shot' && <p className="quiet">{t('选择推荐后添加到对话，按多镜头描述生成视频；不提供逐镜编辑或本地合成。')}</p>}
          <div className="ic-reference-section"><span className="ic-field-label">{t(tool === 'logo' || tool === 'model-display' ? '商品图片' : video ? '画布参考图片' : '参考图片')}</span><div className="ic-references">{sourceLayers.map((layer) => <div className="ic-reference" key={layer.id}><AssetImage id={layer.assetId} name={layer.name} load={load} /><button type="button" disabled={busy} aria-label={t('移除参考 {name}', { name: layer.name })} onClick={() => setExcluded((previous) => [...previous, layer.id])}><X size={12} /></button></div>)}{!sourceIds.length && <span className="quiet">{t(needsSource ? '请在画布中选择图片' : '可选画布图片作为参考')}</span>}</div></div>
          <label className="field"><span>{t('媒体模型')}</span><select value={selectionId} disabled={busy || !models?.models.length} onChange={(event) => { setSelectionId(event.target.value); setSize(''); setCount(1); setDuration(undefined); setScenes((previous) => previous.map(({ id, prompt }) => ({ id, prompt }))); }}><option value="">{t(!models && !modelError ? '读取模型中…' : models?.models.length ? '请选择媒体模型' : '暂无可用模型')}</option>{selectionId && models && !models.models.some((entry) => entry.selectionId === selectionId) && <option value={selectionId} disabled>{t('原模型不可用，请重新选择')}</option>}{models?.models.map((entry) => <option key={entry.selectionId} value={entry.selectionId}>{entry.name}</option>)}</select></label>
          {modelError && <div role="alert" className="inline-error"><p>{t('模型目录读取失败：{error}', { error: modelError })}</p><button type="button" disabled={busy} onClick={() => setModelAttempt((value) => value + 1)}>{t('重新读取')}</button></div>}
          {models && !models.models.length && <p className="quiet">{t('没有可执行的媒体模型，请先配置对应图片或视频模型。')}</p>}
          {referenceError && <p className="inline-error" role="alert">{referenceError}</p>}
          {recommendationError && <p className="inline-error" role="alert">{recommendationError}</p>}
          {!!missingSources.length && <button type="button" disabled={busy} onClick={() => setExcluded((previous) => [...previous, ...missingSources])}>{t('不再使用缺失的参考图')}</button>}
          {durationError && <p className="inline-error" role="alert">{durationError}</p>}
          {video && <ReferenceImages assetIds={referenceAssetIds} sourceImages={sourceLayers} maxImages={recommendationLimit ?? maxImages} forRecommendations={recommendationLimit !== undefined} load={load} disabled={adding || (recommendationLimit === undefined && !caps)} onChange={setReferenceAssetIds} onBusyChange={setUploading} />}
          {tool === 'resize' && <div className="ic-language-list" role="group" aria-label={t('目标比例')}>{aspectRatios.map((ratio) => <button type="button" key={ratio} disabled={!canSubmit} aria-label={t('按 {ratio} 重新生成图片', { ratio })} onClick={() => void generateDirect('resize', { aspectRatio: ratio })}>{t('{ratio}', { ratio })}</button>)}</div>}
          {tool === 'translate' && <div className="ic-language-list" role="group" aria-label={t('目标语言')}>{languages.map((language) => <button type="button" key={language.code} disabled={!canSubmit} onClick={() => void generateDirect('translate', { targetLanguage: language.code })}>{t(language.name)}</button>)}</div>}
          {tool === 'angle' && <AnglePresets selected={anglePreset} disabled={busy} onSelect={setAnglePreset} />}
          {tool === 'remove-background' && <p className="quiet">{t('逐张去除背景并保留主体，结果作为新图层添加到画布。')}</p>}
          {tool === 'recolor' && <RecolorFields colors={colors} onChange={setColors} disabled={busy} />}
          {tool === 'model-display' && <>
            <ProductReferences kind="model" asset={modelAsset} onChange={setModelAsset} onTemplateSelect={(template) => setModel(template.prompt)} load={load} disabled={adding} onBusyChange={setUploading} />
            <label className="field"><span>{t('模特描述（可选人物照片替代）')}</span><textarea value={model} required={!modelAsset} disabled={busy} onChange={(event) => setModel(event.target.value)} placeholder={t('描述模特的外形、姿势和展示方式')} rows={3} /></label>
          </>}
          {tool === 'logo' && <>
            <ProductReferences kind="logo" asset={logoAsset} onChange={setLogoAsset} onTemplateSelect={(template) => setMaterial(template.prompt)} load={load} disabled={adding} onBusyChange={setUploading} />
            <label className="field"><span>{t('自定义工艺')}</span><textarea value={material} required maxLength={2000} disabled={busy} onChange={(event) => setMaterial(event.target.value)} placeholder={t('描述印制工艺、位置、材质和预期效果')} rows={3} /></label>
          </>}
          {recommendationKind && <Recommendations key={sourceKey} documentId={documentId} sourceLayerIds={recommendationSources} referenceAssetIds={recommendationReferences} kind={recommendationKind} disabled={busy} onSelect={selectRecommendation} load={load} />}
          {!direct && <label className="field ic-prompt"><span>{t(tool === 'storyboard' ? '整体风格' : recommendationKind ? '补充要求（可选）' : '创作要求')}</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t(video ? '描述画面、主体动作和镜头运动…' : '描述你想对图片做的修改…')} rows={tool === 'storyboard' ? 2 : 3} disabled={busy} required={tool === 'image' || tool === 'video'} maxLength={20000} /></label>}
          {tool === 'storyboard' && <StoryboardEditor scenes={scenes} durations={allowedDurations} disabled={busy} onChange={setScenes} />}
          {!direct && caps && <details className="ic-output-options"><summary>{t('输出设置')}</summary><div className="field-grid">
            {(caps.pixelSize || !!caps.sizes?.length || !!size) && <label className="field"><span>{t('尺寸（可选）')}</span>{caps.pixelSize ? <><input value={selectedSize} onChange={(event) => setSize(event.target.value)} placeholder={t('模型默认，或宽x高')} disabled={busy} list="generation-sizes" /><datalist id="generation-sizes">{caps.sizes?.map((value) => <option key={value} value={value} />)}</datalist></> : <select value={selectedSize} disabled={busy} onChange={(event) => setSize(event.target.value)}><option value="">{t('模型默认')}</option>{size && !caps.sizes?.includes(size) && <option value={size} disabled>{t('原尺寸不可用，请重新选择')}</option>}{caps.sizes?.map((value) => <option key={value} value={value}>{t(value)}</option>)}</select>}</label>}
            {caps.pixelSizeLimits && <p className="quiet">{t('精确尺寸：边长须为 {step} 的倍数，最长边 {maxEdge}，像素总数 {minPixels}–{maxPixels}，长宽比不超过 {maxAspectRatio}:1。', { ...caps.pixelSizeLimits })}</p>}
            {caps.pixelSizeLimits && isAppPixelSizeSupported(selectedSize, caps.pixelSizeLimits) && selectedSize.split('x').map(Number).reduce((width, height) => width * height, 1) > caps.pixelSizeLimits.experimentalAbovePixels && <p className="quiet" role="status">{t('此尺寸超出常规分辨率范围，属于实验性支持；以实际返回尺寸为准。')}</p>}
            {video && tool !== 'storyboard' && !!allowedDurations?.length && <label className="field"><span>{t('时长')}</span><select value={selectedDuration} disabled={busy} onChange={(event) => setDuration(Number(event.target.value))}>{duration !== undefined && !allowedDurations.includes(duration) && <option value={duration} disabled>{t('原时长不可用')}</option>}{allowedDurations.map((value) => <option key={value} value={value}>{t('{value} 秒', { value })}</option>)}</select></label>}
            {tool !== 'storyboard' && caps.maxCount > 1 && <label className="field"><span>{t(video ? '生成数量' : '生成张数')}</span><input type="number" min={1} max={Math.min(8, caps.maxCount)} step={1} value={count} required disabled={busy} onChange={(event) => setCount(Number(event.target.value))} /></label>}
          </div></details>}
        </div>
        {error && <p role="alert" className="inline-error">{error}</p>}
        {adding && execute && <p className="quiet" role="status">{t('正在生成，请在生成记录中查看或取消本地等待。')}</p>}
        {external && !execute && <p className="quiet ic-external-note">{t('由客户端处理添加到对话的请求，宿主可能立即开始模型响应。')}</p>}
        <footer><button type="button" disabled={busy} onClick={onClose}>{t(execute && tool !== 'angle' ? '关闭' : '取消')}</button>{tool !== 'resize' && tool !== 'translate' && <button type="submit" className="primary" disabled={!canSubmit || (!!recommendationKind && !recommendedPrompt.trim())}>{t(adding ? execute ? '生成中…' : '添加中…' : tool === 'angle' ? '确认生成' : tool === 'storyboard' ? '开始逐镜生成与合成' : direct ? '开始抠图' : external ? '添加到客户端对话' : '添加到对话')}</button>}</footer>
      </form>
    </section>
  </div>;
}
