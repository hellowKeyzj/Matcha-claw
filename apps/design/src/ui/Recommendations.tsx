import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RecommendationKind, RecommendationRequest, RecommendationResult } from '../analysis';
import type { DesignTemplate } from '../templates';
import type { LoadedAsset } from './useAssets';
import { call, errorMessage } from './api';
import i18n, { useTranslation } from './i18n';
import { TemplatePicker } from './TemplatePicker';

interface Props {
  documentId: string;
  sourceLayerIds: string[];
  referenceAssetIds?: string[];
  kind: RecommendationKind;
  disabled: boolean;
  onSelect(prompt: string): void;
  load?(assetId: string): Promise<LoadedAsset>;
  onTemplateSelect?(template: DesignTemplate): void;
}

type RecommendationState =
  | { kind: 'idle' | 'loading' }
  | { kind: 'ready'; candidates: RecommendationResult['candidates']; selectedId: string }
  | { kind: 'failed'; message: string };

export function Recommendations({ documentId, sourceLayerIds, referenceAssetIds = [], kind, disabled, onSelect, load, onTemplateSelect }: Props) {
  const { t } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const sourceKey = JSON.stringify(sourceLayerIds);
  const referenceKey = JSON.stringify(referenceAssetIds);
  const inputKey = JSON.stringify([documentId, sourceKey, referenceKey, kind, language]);
  const referenceCount = sourceLayerIds.length + referenceAssetIds.length;
  const validSources = kind === 'product-scene' ? sourceLayerIds.length > 0 && referenceAssetIds.length === 0
    : referenceCount > 0 && referenceCount <= (kind === 'scene-video' ? 1 : 4);
  const [reload, setReload] = useState<{ inputKey: string; refresh: boolean } | null>(null);
  const request = useMemo<RecommendationRequest>(() => ({
    documentId, sourceLayerIds: JSON.parse(sourceKey) as string[], kind, language,
    ...(referenceKey === '[]' ? {} : { referenceAssetIds: JSON.parse(referenceKey) as string[] }),
    ...(reload?.inputKey === inputKey && reload.refresh ? { refresh: true } : {}),
  }), [documentId, sourceKey, referenceKey, kind, language, inputKey, reload]);
  const [result, setResult] = useState<{ request: RecommendationRequest; state: RecommendationState } | null>(null);
  const state: RecommendationState = !validSources ? { kind: 'idle' }
    : result?.request === request ? result.state : { kind: 'loading' };
  const [tab, setTab] = useState<'recommendations' | 'templates'>('recommendations');
  const [templateSelection, setTemplateSelection] = useState<{ inputKey: string; template: DesignTemplate } | null>(null);
  const selectedTemplate = templateSelection?.inputKey === inputKey ? templateSelection.template : null;
  const selection = useRef(onSelect);
  const templatesActive = useRef(false);
  const showTemplates = kind === 'product-scene' && tab === 'templates';

  useLayoutEffect(() => {
    selection.current = onSelect;
    templatesActive.current = showTemplates;
  }, [onSelect, showTemplates]);

  useLayoutEffect(() => {
    let current = true;
    selection.current('');
    if (validSources) void call<RecommendationResult>('recommendations', request).then(({ candidates }) => {
      if (!current) return;
      setResult({ request, state: { kind: 'ready', candidates, selectedId: candidates[0]?.id ?? '' } });
      if (!templatesActive.current) selection.current(candidates[0]?.prompt ?? '');
    }).catch((cause) => {
      if (current) setResult({ request, state: { kind: 'failed', message: errorMessage(cause) } });
    });
    // The tool transport cannot cancel accepted work; obsolete results must not select a new source.
    return () => { current = false; };
  }, [request, validSources]);

  function reloadRecommendations(refresh = false) {
    setReload({ inputKey, refresh });
  }

  function switchTab(next: typeof tab) {
    setTab(next);
    templatesActive.current = next === 'templates';
    const selected = state.kind === 'ready' ? state.candidates.find((candidate) => candidate.id === state.selectedId) : undefined;
    selection.current(next === 'templates' ? selectedTemplate?.prompt ?? '' : selected?.prompt ?? '');
  }

  function selectTemplate(template: DesignTemplate | null) {
    setTemplateSelection(template ? { inputKey, template } : null);
    selection.current(template?.prompt ?? '');
    if (template) onTemplateSelect?.(template);
  }

  return <section className="field" aria-label={t('推荐候选')} aria-busy={!showTemplates && state.kind === 'loading'}>
    {kind === 'product-scene' && <div className="ic-segmented" role="group" aria-label={t('商品场景来源')}>
      <button type="button" aria-pressed={tab === 'recommendations'} disabled={disabled} onClick={() => switchTab('recommendations')}>{t('按图推荐')}</button>
      <button type="button" aria-pressed={tab === 'templates'} disabled={disabled} onClick={() => switchTab('templates')}>{t('本地场景模板')}</button>
    </div>}
    {!validSources ? <p className="empty-hint" role="status">{t(kind === 'product-scene' ? '请先在画布中选择图片，再获取推荐。' : referenceCount === 0 ? '请先选择画布图片或上传独立参考，再获取推荐。' : kind === 'scene-video' ? '场景视频推荐需要且仅分析 1 张参考图片（画布或独立上传）。' : '多镜头推荐需要 1 至 4 张参考图片（含画布和独立上传）。')}</p> : showTemplates ? <TemplatePicker key={inputKey} category="product-scene" selectedId={selectedTemplate?.id} disabled={disabled} load={load} onSelect={selectTemplate} /> : <>
      <div className="section-heading"><h3>{t('推荐候选')}</h3>{state.kind === 'ready' && state.candidates.length > 0 && <button type="button" disabled={disabled} onClick={() => void reloadRecommendations(true)}>{t('换一批')}</button>}</div>
      {state.kind === 'loading' && <p className="empty-hint" role="status">{t('正在根据图片获取推荐…')}</p>}
      {state.kind === 'failed' && <div className="field"><p className="inline-error" role="alert">{t('获取推荐失败：{error}', { error: state.message })}</p><div className="button-row"><button type="button" disabled={disabled} onClick={() => void reloadRecommendations()}>{t('重试')}</button></div></div>}
      {state.kind === 'ready' && (state.candidates.length ? <div className="property-fields">{state.candidates.map((candidate) => <article className="generation-record" key={candidate.id}>
        <div className="record-heading"><strong>{candidate.title}</strong><button type="button" aria-pressed={state.selectedId === candidate.id} aria-label={t('选择推荐 {title}', { title: candidate.title })} disabled={disabled} onClick={() => {
          setResult({ request, state: { ...state, selectedId: candidate.id } });
          selection.current(candidate.prompt);
        }}>{t(state.selectedId === candidate.id ? '已选择' : '选择推荐')}</button></div>
        <p className="record-prompt">{candidate.description}</p>
      </article>)}</div> : <div className="field"><p className="empty-hint" role="status">{t('暂无推荐结果，请重试或更换图片。')}</p><div className="button-row"><button type="button" disabled={disabled} onClick={() => void reloadRecommendations()}>{t('重试')}</button></div></div>)}
    </>}
  </section>;
}
