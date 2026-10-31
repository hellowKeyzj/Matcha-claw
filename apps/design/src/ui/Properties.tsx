import { useState } from 'react';
import { Copy, FlipHorizontal2, FlipVertical2, Link, Unlink, Trash2 } from 'lucide-react';
import type { DesignDocument, Edit, ImageLayer, LayerPatch } from '../document';
import { HsvColorPicker } from './HsvColorPicker';
import { ImageNumberField } from './ImageAdjustments';
import { isImageControlConfirmKey, useImagePreview } from './useImagePreview';
import { useTranslation } from './i18n';

interface Props {
  document: DesignDocument;
  selected: string[];
  busy: boolean;
  onEdit(edits: Edit[]): Promise<boolean>;
  onPreview?(id: string, changes: LayerPatch | null): void;
  onDuplicate(): void;
  onDelete(): void;
}

function Field({ label, value, type = 'text', min, max, step, disabled, onChange }: {
  label: string; value: string | number; type?: string; min?: number; max?: number; step?: number;
  disabled?: boolean; onChange(value: string): void;
}) {
  return <label className="field"><span>{label}</span><input
    key={String(value)} type={type} defaultValue={value} min={min} max={max} step={step}
    disabled={disabled} onBlur={(event) => {
      if (event.currentTarget.validity.valid && event.currentTarget.value !== String(value)) onChange(event.currentTarget.value);
      else event.currentTarget.value = String(value);
    }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
  /></label>;
}

function ImageColorField({ source, label, color, disabled, onInput, onCommit, onCancel }: {
  source: ImageLayer; label: string; color: string; disabled: boolean;
  onInput(hex: string): void; onCommit(): void; onCancel(): void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<{ source: ImageLayer; text: string } | null>(null);
  const text = draft?.source === source ? draft.text : null;
  if (draft && draft.source !== source) setDraft(null);
  return <details className="image-color-field" onToggle={(event) => { if (!event.currentTarget.open) onCancel(); }}>
    <summary><span>{label}</span><span className="ic-color-swatch" aria-hidden="true" style={{ backgroundColor: color }} /><span>{color.toUpperCase()}</span></summary>
    <div className="image-color-controls" onPointerUp={onCommit} onPointerCancel={onCancel}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { onCommit(); setDraft(null); } }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.stopPropagation(); onCancel(); setDraft(null); }
        else if (event.key === 'Enter') { event.preventDefault(); onCommit(); setDraft(null); }
      }} onKeyUp={(event) => { if (isImageControlConfirmKey(event.key)) onCommit(); }}
    >
      <HsvColorPicker hex={color} disabled={disabled} onChange={(hex) => { setDraft(null); onInput(hex); }} />
      <label className="field"><span>{t('HEX')}</span><input value={text ?? color} required pattern="#[0-9a-fA-F]{6}" maxLength={7} spellCheck={false} autoComplete="off" autoCapitalize="off" disabled={disabled}
        onInput={(event) => { const hex = event.currentTarget.value; setDraft({ source, text: hex }); if (/^#[0-9a-fA-F]{6}$/.test(hex)) onInput(hex.toUpperCase()); else onCancel(); }} onChange={() => {}}
      /></label>
    </div>
  </details>;
}

function ImageProperties({ layer, busy, onEdit, onPreview }: {
  layer: ImageLayer; busy: boolean; onEdit(edits: Edit[]): Promise<boolean>;
  onPreview?(id: string, changes: LayerPatch | null): void;
}) {
  const { t } = useTranslation();
  const editor = useImagePreview(layer, busy, onEdit, onPreview);
  const value = editor.value;
  const disabled = busy || layer.locked;
  const stroke = value.stroke ?? { color: '#000000', width: 0, opacity: 1 };
  const shadow = value.shadow ?? { color: '#000000', blur: 0, offsetX: 0, offsetY: 0, opacity: 0 };
  function number(control: string, label: string, amount: number, changes: (value: number) => LayerPatch, min?: number, max?: number, range = false) {
    return <ImageNumberField source={layer} label={t(label)} value={amount} min={min} max={max} range={range} step={range ? 1 : 'any'} disabled={disabled}
      onInput={(next) => editor.preview(control, changes(next))} onCommit={() => editor.commit(control)} onCancel={() => editor.clear(control)}
    />;
  }
  function size(key: 'width' | 'height', next: number): LayerPatch {
    if (!layer.lockAspectRatio) return { [key]: next };
    return key === 'width' ? { width: next, height: next * layer.height / layer.width } : { height: next, width: next * layer.width / layer.height };
  }
  const ratio = layer.width / layer.height;
  return <>
    <section className="image-property-section" aria-label={t('位置')}>
      <h3>{t('位置')}</h3>
      <div className="field-grid">
        {number('x', 'X', value.x, (x) => ({ x }), -1000000, 1000000)}
        {number('y', 'Y', value.y, (y) => ({ y }), -1000000, 1000000)}
      </div>
      <div className="image-rotation-row">
        {number('rotation', '旋转 °', value.rotation, (rotation) => ({ rotation }), -360000, 360000)}
        <div className="button-row">
          <button type="button" className="icon" title={t('水平翻转')} aria-label={t('水平翻转')} aria-pressed={!!value.flipX} disabled={disabled} onClick={() => editor.edit('flipX', { flipX: !value.flipX })}><FlipHorizontal2 size={16} aria-hidden="true" /></button>
          <button type="button" className="icon" title={t('垂直翻转')} aria-label={t('垂直翻转')} aria-pressed={!!value.flipY} disabled={disabled} onClick={() => editor.edit('flipY', { flipY: !value.flipY })}><FlipVertical2 size={16} aria-hidden="true" /></button>
        </div>
      </div>
    </section>
    <section className="image-property-section" aria-label={t('尺寸')}>
      <h3>{t('尺寸')}</h3>
      <div className="image-size-row">
        {number('width', '宽度', value.width, (width) => size('width', width), layer.lockAspectRatio ? Math.max(0.01, 0.01 * ratio) : 0.01, layer.lockAspectRatio ? Math.min(32768, 32768 * ratio) : 32768)}
        {number('height', '高度', value.height, (height) => size('height', height), layer.lockAspectRatio ? Math.max(0.01, 0.01 / ratio) : 0.01, layer.lockAspectRatio ? Math.min(32768, 32768 / ratio) : 32768)}
        <button type="button" className="icon" title={t('锁定宽高比')} aria-label={t('锁定宽高比')} aria-pressed={!!value.lockAspectRatio} disabled={disabled} onClick={() => editor.edit('ratio', { lockAspectRatio: !value.lockAspectRatio })}>{value.lockAspectRatio ? <Link size={16} aria-hidden="true" /> : <Unlink size={16} aria-hidden="true" />}</button>
      </div>
    </section>
    <section className="image-property-section" aria-label={t('外观')}>
      <h3>{t('外观')}</h3>
      {number('opacity', '不透明度 %', Math.round(value.opacity * 100), (opacity) => ({ opacity: opacity / 100 }), 0, 100, true)}
    </section>
    <section className="image-property-section" aria-label={t('描边')}>
      <label className="image-toggle-field"><span>{t('描边')}</span><input type="checkbox" checked={stroke.width > 0} disabled={disabled} onChange={(event) => editor.edit('stroke', { stroke: { ...stroke, width: event.currentTarget.checked ? 1 : 0 } })} /></label>
      {(stroke.width > 0 || (layer.stroke?.width ?? 0) > 0) && <>
        <ImageColorField source={layer} label={t('描边颜色')} color={stroke.color} disabled={disabled} onInput={(color) => editor.preview('stroke.color', { stroke: { ...stroke, color } })} onCommit={() => editor.commit('stroke.color')} onCancel={() => editor.clear('stroke.color')} />
        {number('stroke.width', '描边宽度', stroke.width, (width) => ({ stroke: { ...stroke, width } }), 0, 100)}
        {number('stroke.opacity', '描边不透明度 %', Math.round(stroke.opacity * 100), (opacity) => ({ stroke: { ...stroke, opacity: opacity / 100 } }), 0, 100, true)}
      </>}
    </section>
    <section className="image-property-section" aria-label={t('阴影')}>
      <label className="image-toggle-field"><span>{t('阴影')}</span><input type="checkbox" checked={shadow.opacity > 0} disabled={disabled} onChange={(event) => editor.edit('shadow', { shadow: { ...shadow, opacity: event.currentTarget.checked ? 1 : 0 } })} /></label>
      {(shadow.opacity > 0 || (layer.shadow?.opacity ?? 0) > 0) && <>
        <div className="field-grid">
          {number('shadow.offsetX', '水平偏移', shadow.offsetX, (offsetX) => ({ shadow: { ...shadow, offsetX } }), -100, 100)}
          {number('shadow.offsetY', '垂直偏移', shadow.offsetY, (offsetY) => ({ shadow: { ...shadow, offsetY } }), -100, 100)}
        </div>
        <ImageColorField source={layer} label={t('阴影颜色')} color={shadow.color} disabled={disabled} onInput={(color) => editor.preview('shadow.color', { shadow: { ...shadow, color } })} onCommit={() => editor.commit('shadow.color')} onCancel={() => editor.clear('shadow.color')} />
        {number('shadow.blur', '阴影模糊', shadow.blur, (blur) => ({ shadow: { ...shadow, blur } }), 0, 100, true)}
        {number('shadow.opacity', '阴影不透明度 %', Math.round(shadow.opacity * 100), (opacity) => ({ shadow: { ...shadow, opacity: opacity / 100 } }), 0, 100, true)}
      </>}
    </section>
  </>;
}

export function Properties({ document, selected, busy, onEdit, onPreview, onDuplicate, onDelete }: Props) {
  const { t } = useTranslation();
  const layers = document.layers.filter((layer) => selected.includes(layer.id));
  const layer = layers.length === 1 ? layers[0] : undefined;
  const disabled = busy || layer?.locked;
  const patch = (changes: LayerPatch) => void onEdit(layers.filter((entry) => !entry.locked).map((entry) => ({ type: 'patch', id: entry.id, changes })));

  return <section className="properties-panel">
    <div className="section-heading"><h2>{layers.length ? layers.length === 1 ? t('图层属性') : t('已选 {count} 个图层', { count: layers.length }) : t('画布设置')}</h2></div>
    {!layers.length ? <p className="empty-hint">{t('请先选择需要编辑的图片或文字。')}</p> : <div className="property-fields">
      {layer && <>
        <Field label={t('图层名称')} value={layer.name} disabled={busy} onChange={(name) => void onEdit([{ type: 'patch', id: layer.id, changes: { name } }])} />
        {layer.type === 'image' ? <ImageProperties key={`${document.id}:${document.revision}:${layer.id}`} layer={layer} busy={busy} onEdit={onEdit} onPreview={onPreview} /> : <div className="field-grid">
          <Field label={t('X')} type="number" value={layer.x} disabled={disabled} onChange={(value) => patch({ x: Number(value) })} />
          <Field label={t('Y')} type="number" value={layer.y} disabled={disabled} onChange={(value) => patch({ y: Number(value) })} />
          <Field label={t('宽度')} type="number" min={1} value={layer.width} disabled={disabled} onChange={(value) => patch({ width: Number(value) })} />
          <Field label={t('高度')} type="number" min={1} value={layer.height} disabled={disabled} onChange={(value) => patch({ height: Number(value) })} />
          <Field label={t('旋转 °')} type="number" value={layer.rotation} disabled={disabled} onChange={(value) => patch({ rotation: Number(value) })} />
          <Field label={t('不透明度 %')} type="number" min={0} max={100} value={Math.round(layer.opacity * 100)} disabled={disabled} onChange={(value) => patch({ opacity: Number(value) / 100 })} />
        </div>}
        {layer.type === 'text' && <>
          <label className="field"><span>{t('文字内容')}</span><textarea key={`${layer.id}:${layer.text}`} defaultValue={layer.text} disabled={disabled} onBlur={(event) => { if (event.target.value !== layer.text) patch({ text: event.target.value }); }} /></label>
          <Field label={t('字体')} value={layer.fontFamily} disabled={disabled} onChange={(fontFamily) => patch({ fontFamily })} />
          <div className="field-grid">
            <Field label={t('字号')} type="number" min={1} value={layer.fontSize} disabled={disabled} onChange={(value) => patch({ fontSize: Number(value) })} />
            <Field label={t('行高')} type="number" min={0.1} step={0.1} value={layer.lineHeight} disabled={disabled} onChange={(value) => patch({ lineHeight: Number(value) })} />
          </div>
          <label className="field"><span>{t('字形')}</span><select disabled={disabled} value={layer.fontStyle} onChange={(event) => patch({ fontStyle: event.target.value as typeof layer.fontStyle })}><option value="normal">{t('常规')}</option><option value="bold">{t('粗体')}</option><option value="italic">{t('斜体')}</option><option value="bold italic">{t('粗斜体')}</option></select></label>
          <div className="field-grid"><label className="field"><span>{t('文字颜色')}</span><input type="color" disabled={disabled} value={layer.fill} onChange={(event) => patch({ fill: event.target.value })} /></label><label className="field"><span>{t('对齐')}</span><select value={layer.align} disabled={disabled} onChange={(event) => patch({ align: event.target.value as typeof layer.align })}><option value="left">{t('左对齐')}</option><option value="center">{t('居中')}</option><option value="right">{t('右对齐')}</option></select></label></div>
        </>}
        {layer.locked && <p className="quiet">{t('图层已锁定，解锁后可修改内容和位置。')}</p>}
      </>}
      <div className="button-row"><button disabled={busy} onClick={onDuplicate}><Copy size={14} />{t('复制图层')}</button><button className="danger-text" disabled={busy || layers.every((entry) => entry.locked)} onClick={onDelete}><Trash2 size={14} />{t('删除')}</button></div>
    </div>}
  </section>;
}
