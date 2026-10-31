import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Pipette, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from './i18n';
import { HsvColorPicker } from './HsvColorPicker';

type Color = { hex: string; opacity: number };
type ColorCard = { id: string; color: Color };
type ColorDraft = { id: string | null; hex: string; opacity: string };

function isSameColor(left: Color, right: Color): boolean {
  return left.hex === right.hex && Object.is(left.opacity, right.opacity);
}

export function RecolorFields({ colors, onChange, disabled }: {
  colors: { hex: string; opacity: number }[];
  onChange(colors: { hex: string; opacity: number }[]): void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const [cards, setCards] = useState<ColorCard[]>(() => colors.map((color) => ({ id: crypto.randomUUID(), color })));
  const [draft, setDraft] = useState<ColorDraft | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickFailed, setPickFailed] = useState(false);
  const picker = useRef<AbortController | null>(null);
  const returnFocus = useRef<string | null>(null);
  const EyeDropper = (window as Window & {
    EyeDropper?: new () => { open(options: { signal: AbortSignal }): Promise<{ sRGBHex: string }> };
  }).EyeDropper;
  const canPick = typeof EyeDropper === 'function';

  // Parent replacement cancels the editor; surviving cards keep their local identities.
  if (colors.length !== cards.length || colors.some((color, index) => !isSameColor(color, cards[index].color))) {
    const remaining = [...cards];
    setCards(colors.map((color) => {
      const index = remaining.findIndex((card) => isSameColor(card.color, color));
      const card = index < 0 ? undefined : remaining.splice(index, 1)[0];
      return { id: card?.id ?? crypto.randomUUID(), color };
    }));
    setDraft(null);
  }

  useLayoutEffect(() => () => { picker.current?.abort(); }, [disabled, draft?.id]);
  useEffect(() => {
    if (!draft && returnFocus.current) { document.getElementById(returnFocus.current)?.focus(); returnFocus.current = null; }
  }, [draft]);

  const hex = draft ? `#${draft.hex.replace(/^#/, '')}` : '';
  const opacity = Number(draft?.opacity);
  const isHexValid = /^#[0-9a-fA-F]{6}$/.test(hex);
  const isOpacityValid = !!draft?.opacity.trim() && Number.isInteger(opacity) && opacity >= 0 && opacity <= 100;

  function changeCards(next: ColorCard[]) {
    if (disabled || picking) return;
    setCards(next);
    onChange(next.map((card) => card.color));
  }

  function editColor(card?: ColorCard) {
    if (disabled || picking) return;
    returnFocus.current = `${hintId}-${card?.id ?? 'add'}`;
    setPickFailed(false);
    setDraft({ id: card?.id ?? null, hex: card?.color.hex ?? '#1ead6f', opacity: String(card?.color.opacity ?? 100) });
  }

  function cancelColor() {
    const controller = picker.current;
    picker.current = null;
    controller?.abort();
    setPicking(false);
    setDraft(null);
  }

  function applyColor() {
    if (!draft || disabled || picking || !isHexValid || !isOpacityValid) return;
    const color = { hex: hex.toUpperCase(), opacity };
    if (draft.id === null) {
      if (cards.length >= 8) return;
      const id = crypto.randomUUID();
      returnFocus.current = `${hintId}-${id}`;
      changeCards([...cards, { id, color }]);
    } else {
      if (!cards.some((card) => card.id === draft.id)) return;
      changeCards(cards.map((card) => card.id === draft.id ? { ...card, color } : card));
    }
    setDraft(null);
  }

  async function pickColor() {
    if (!draft || disabled || !EyeDropper || picker.current) return;
    const controller = new AbortController();
    picker.current = controller;
    setPicking(true);
    setPickFailed(false);
    try {
      const { sRGBHex } = await new EyeDropper().open({ signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!/^#[0-9a-fA-F]{6}$/.test(sRGBHex)) { setPickFailed(true); return; }
      setDraft((current) => current?.id === draft.id ? { ...current, hex: sRGBHex, opacity: '100' } : current);
    } catch (cause) {
      if (!controller.signal.aborted && !(cause instanceof DOMException && cause.name === 'AbortError')) setPickFailed(true);
    } finally {
      if (picker.current === controller) { picker.current = null; setPicking(false); }
    }
  }

  return <div className="property-fields" role="group" aria-label={t('目标颜色')} onKeyDown={(event) => {
    if (event.key !== 'Escape' || !draft) return;
    event.stopPropagation();
    if (!disabled) { if (picking) picker.current?.abort(); else cancelColor(); }
  }}>
    {draft ? <>
      <div className="section-heading"><h3>{t(draft.id === null ? '添加颜色' : '编辑颜色')}</h3><button type="button" disabled={disabled} onClick={cancelColor}>{t('取消')}</button></div>
      <p id={`${hintId}-draft`} className="quiet">{t('请先应用颜色或取消编辑。')}</p>
      <input className="visually-hidden" aria-label={t('请先应用颜色或取消编辑。')} aria-describedby={`${hintId}-draft`} tabIndex={-1} required value="" disabled={disabled} onChange={() => {}} onInvalid={(event) => {
        event.preventDefault();
        event.currentTarget.parentElement?.querySelector<HTMLInputElement>('input:not(.visually-hidden)')?.focus();
      }} />
      <HsvColorPicker hex={hex} disabled={disabled || picking} onChange={(next) => setDraft((current) => current ? { ...current, hex: next } : current)} />
      <div className="field-grid" onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyColor(); } }}>
        <label className="field"><span>{t('HEX')}</span><input autoFocus value={draft.hex} required pattern="#?[0-9a-fA-F]{6}" maxLength={7} spellCheck={false} autoCapitalize="off" autoComplete="off" aria-invalid={!isHexValid} aria-describedby={!isHexValid ? `${hintId}-hex` : undefined} disabled={disabled || picking} onChange={(event) => setDraft({ ...draft, hex: event.target.value })} /></label>
        <label className="field"><span>{t('不透明度 %')}</span><input type="number" min={0} max={100} step={1} required value={draft.opacity} aria-invalid={!isOpacityValid} aria-describedby={!isOpacityValid ? `${hintId}-opacity` : undefined} disabled={disabled || picking} onChange={(event) => setDraft({ ...draft, opacity: event.target.value })} /></label>
      </div>
      {!isHexValid && <p id={`${hintId}-hex`} className="inline-error">{t('请输入 6 位 HEX 颜色，例如 #1EAD6F。')}</p>}
      {!isOpacityValid && <p id={`${hintId}-opacity`} className="inline-error">{t('不透明度须为 0 至 100 的整数。')}</p>}
      <div className="button-row">
        <button type="button" disabled={disabled || picking || !canPick} aria-describedby={!canPick ? `${hintId}-picker` : undefined} onClick={() => void pickColor()}><Pipette size={14} aria-hidden="true" />{t(picking ? '取色中…' : '屏幕取色')}</button>
        <button type="button" disabled={disabled || picking || !isHexValid || !isOpacityValid} onClick={applyColor}>{t('应用颜色')}</button>
      </div>
      {!canPick && <p id={`${hintId}-picker`} className="quiet">{t('当前环境不支持屏幕取色，请使用选色器或输入 HEX。')}</p>}
      {pickFailed && <p role="alert" className="inline-error">{t('屏幕取色失败，请重试或输入 HEX。')}</p>}
    </> : <>
      <div className="section-heading"><h3>{t('目标颜色')}</h3><span>{t('色卡（{count}/8）', { count: cards.length })}</span></div>
      <div>{cards.map((card, index) => <div className="layer-row" key={card.id}>
        <button type="button" id={`${hintId}-${card.id}`} className="layer-select" disabled={disabled} aria-label={t('编辑色卡 {number}', { number: index + 1 })} onClick={() => editColor(card)}><span className="ic-color-swatch" aria-hidden="true" style={{ backgroundColor: card.color.hex, opacity: card.color.opacity / 100 }} /><span>{t('{hex}，不透明度 {opacity}%', { hex: card.color.hex, opacity: card.color.opacity })}</span></button>
        <button type="button" className="icon small" disabled={disabled} aria-label={t('删除色卡 {number}', { number: index + 1 })} onClick={() => changeCards(cards.filter((entry) => entry.id !== card.id))}><Trash2 size={14} aria-hidden="true" /></button>
      </div>)}</div>
      {!cards.length && <p className="quiet">{t('请添加 1 至 8 个目标颜色。')}</p>}
      <div className="button-row"><button type="button" id={`${hintId}-add`} disabled={disabled || cards.length >= 8} onClick={() => editColor()}><Plus size={14} aria-hidden="true" />{t('添加颜色')}</button></div>
    </>}
  </div>;
}
