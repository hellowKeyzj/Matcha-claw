import { useState } from 'react';
import { X } from 'lucide-react';
import type { Edit, ImageLayer, LayerPatch } from '../document';
import { useTranslation } from './i18n';
import { isImageControlConfirmKey, useImagePreview } from './useImagePreview';
import './image-properties.css';

export function ImageNumberField({ source, label, value, min, max, step = 'any', range = false, disabled, onInput, onCommit, onCancel }: {
  source: ImageLayer;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number | 'any';
  range?: boolean;
  disabled: boolean;
  onInput(value: number): void;
  onCommit(): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState<{ source: ImageLayer; text: string } | null>(null);
  const text = draft?.source === source ? draft.text : null;
  if (draft && draft.source !== source) setDraft(null);
  function input(element: HTMLInputElement) {
    const raw = element.value;
    setDraft({ source, text: raw });
    if (raw !== '' && element.validity.valid && Number.isFinite(element.valueAsNumber)) onInput(element.valueAsNumber);
    else onCancel();
  }
  function finish(element: HTMLInputElement) {
    if (element.value !== '' && element.validity.valid) onCommit();
    else onCancel();
    setDraft(null);
  }
  return <div className={`image-number-field${range ? ' image-range-field' : ''}`}>
    <label className="field"><span>{label}</span><input type="number" aria-label={label} value={text ?? value} min={min} max={max} step={step} required disabled={disabled}
      onInput={(event) => input(event.currentTarget)} onChange={() => {}}
      onPointerUp={(event) => finish(event.currentTarget)} onBlur={(event) => finish(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); finish(event.currentTarget); }
        else if (event.key === 'Escape') { event.stopPropagation(); onCancel(); setDraft(null); }
      }} onKeyUp={(event) => { if (isImageControlConfirmKey(event.key)) finish(event.currentTarget); }}
    /></label>
    {range && <input type="range" aria-label={label} value={value} min={min} max={max} step={step} disabled={disabled}
      onInput={(event) => { setDraft(null); onInput(event.currentTarget.valueAsNumber); }} onChange={() => {}}
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerUp={onCommit} onPointerCancel={onCancel} onBlur={onCommit}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}
      onKeyUp={(event) => { if (isImageControlConfirmKey(event.key)) onCommit(); }}
    />}
  </div>;
}

export function ImageAdjustments({ layer, busy, onPreview, onEdit, onClose }: {
  layer: ImageLayer;
  busy: boolean;
  onPreview(id: string, changes: LayerPatch | null): void;
  onEdit(edits: Edit[]): Promise<boolean>;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const editor = useImagePreview(layer, busy, onEdit, onPreview);
  const disabled = busy || layer.locked;
  const adjustments = editor.value.adjustments ?? { blur: 0, brightness: 0, contrast: 0, hue: 0, saturation: 0, invert: false };
  function close() { editor.clear(); onClose(); }
  return <section className="image-adjustments" aria-label={t('图片调整')} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  }}>
    <header><h2>{t('图片调整')}</h2><button type="button" className="icon small" aria-label={t('关闭面板')} onClick={close}><X size={16} aria-hidden="true" /></button></header>
    {([
      ['blur', '模糊', 0], ['brightness', '亮度', -100], ['contrast', '对比度', -100],
      ['hue', '色相', -100], ['saturation', '饱和度', -100],
    ] as const).map(([key, label, min]) => <ImageNumberField key={key} source={layer} label={t(label)} value={adjustments[key]} min={min} max={100} step={1} range disabled={disabled}
      onInput={(value) => editor.preview(key, { adjustments: { ...adjustments, [key]: value } })}
      onCommit={() => editor.commit(key)} onCancel={() => editor.clear(key)}
    />)}
    <label className="image-toggle-field"><span>{t('反相')}</span><input type="checkbox" checked={adjustments.invert} disabled={disabled} onChange={(event) => editor.edit('invert', { adjustments: { ...adjustments, invert: event.currentTarget.checked } })} /></label>
    {layer.locked && <p className="quiet">{t('图层已锁定，解锁后可修改内容和位置。')}</p>}
  </section>;
}
