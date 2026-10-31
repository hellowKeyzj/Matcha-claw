import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from './i18n';
import './HsvColorPicker.css';

type Hsv = { h: number; s: number; v: number };

function fromHex(hex: string): Hsv | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const v = Math.max(r, g, b);
  const delta = v - Math.min(r, g, b);
  const hue = delta === 0 ? 0 : v === r ? (g - b) / delta : v === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: (hue * 60 + 360) % 360, s: v === 0 ? 0 : delta / v, v };
}

function toHex({ h, s, v }: Hsv): string {
  const channel = (offset: number) => {
    const sector = (offset + h / 60) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(sector, 4 - sector, 1)))).toString(16).padStart(2, '0');
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`.toUpperCase();
}

function clamp(value: number, maximum = 1): number { return Math.max(0, Math.min(maximum, value)); }

export function HsvColorPicker({ hex, onChange, disabled = false }: {
  hex: string;
  onChange(hex: string): void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const [color, setColor] = useState(() => ({ hex: hex.toUpperCase(), hsv: fromHex(hex) ?? { h: 0, s: 0, v: 0 }, revision: 0 }));
  const pointer = useRef<{ element: HTMLButtonElement; id: number } | null>(null);
  const finish = useCallback(() => {
    const active = pointer.current;
    pointer.current = null;
    if (active?.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
  }, []);

  // Keep the exact HSV draft through RGB rounding, including hue at black/gray.
  if (hex.toUpperCase() !== color.hex) {
    const hsv = fromHex(hex);
    if (hsv) setColor({ hex: hex.toUpperCase(), hsv, revision: color.revision + 1 });
  }
  useLayoutEffect(finish, [color.revision, finish]);
  useLayoutEffect(() => { if (disabled) finish(); }, [disabled, finish]);
  useEffect(() => {
    window.addEventListener('blur', finish);
    return () => { window.removeEventListener('blur', finish); finish(); };
  }, [finish]);

  function change(hsv: Hsv) {
    if (disabled) return;
    const next = toHex(hsv);
    setColor({ hex: next, hsv, revision: color.revision });
    onChange(next);
  }

  function move(event: React.PointerEvent<HTMLButtonElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    // Client CSS px → normalized saturation/value or hue, independent of layout size.
    const x = clamp((event.clientX - box.left) / box.width);
    change(event.currentTarget.dataset.axis === 'hue'
      ? { ...color.hsv, h: Math.round(x * 360) }
      : { ...color.hsv, s: x, v: clamp(1 - (event.clientY - box.top) / box.height) });
  }

  function start(event: React.PointerEvent<HTMLButtonElement>) {
    if (disabled || event.button !== 0 || pointer.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    pointer.current = { element: event.currentTarget, id: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    move(event);
  }

  function key(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    const hue = event.currentTarget.dataset.axis === 'hue';
    const step = event.shiftKey ? 10 : 1;
    const { h, s, v } = color.hsv;
    let next: Hsv;
    switch (event.key) {
      case 'ArrowLeft': next = hue ? { h: clamp(Math.round(h) - step, 360), s, v } : { h, s: clamp(s - step / 100), v }; break;
      case 'ArrowRight': next = hue ? { h: clamp(Math.round(h) + step, 360), s, v } : { h, s: clamp(s + step / 100), v }; break;
      case 'ArrowDown': next = hue ? { h: clamp(Math.round(h) - step, 360), s, v } : { h, s, v: clamp(v - step / 100) }; break;
      case 'ArrowUp': next = hue ? { h: clamp(Math.round(h) + step, 360), s, v } : { h, s, v: clamp(v + step / 100) }; break;
      case 'Home': next = hue ? { h: 0, s, v } : { h, s: 0, v: 1 }; break;
      case 'End': next = hue ? { h: 360, s, v } : { h, s: 1, v: 0 }; break;
      case 'Enter': case ' ': event.preventDefault(); return;
      case 'Escape': finish(); return;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    change(next);
  }

  const events = {
    onPointerDown: start,
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => { if (pointer.current?.id === event.pointerId && pointer.current.element === event.currentTarget) move(event); },
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => { if (pointer.current?.id === event.pointerId) { move(event); finish(); } },
    onPointerCancel: (event: React.PointerEvent<HTMLButtonElement>) => { if (pointer.current?.id === event.pointerId) finish(); },
    onLostPointerCapture: (event: React.PointerEvent<HTMLButtonElement>) => { if (pointer.current?.id === event.pointerId) finish(); },
    onBlur: finish,
    onKeyDown: key,
  };
  const { h, s, v } = color.hsv;
  return <div className="hsv-color-picker" role="group" aria-label={t('选色器')}>
    <span id={hintId} className="visually-hidden">{t('方向键调整颜色，按住 Shift 每次调整 10。')}</span>
    <button {...events} type="button" className="hsv-color-plane" role="slider" disabled={disabled} aria-label={t('饱和度与明度')} aria-describedby={hintId} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s * 100)} aria-valuetext={t('饱和度 {saturation}%，明度 {value}%', { saturation: Math.round(s * 100), value: Math.round(v * 100) })} style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))` }}>
      <span className="hsv-color-thumb" aria-hidden="true" style={{ left: `${s * 100}%`, top: `${(1 - v) * 100}%` }} />
    </button>
    <div className="hsv-color-hue-row">
      <span className="hsv-color-preview" aria-hidden="true" style={{ backgroundColor: color.hex }} />
      <button {...events} type="button" className="hsv-color-hue" data-axis="hue" role="slider" disabled={disabled} aria-label={t('色相')} aria-describedby={hintId} aria-valuemin={0} aria-valuemax={360} aria-valuenow={Math.round(h)} aria-valuetext={t('色相 {hue}°', { hue: Math.round(h) })}>
        <span className="hsv-color-thumb" aria-hidden="true" style={{ left: `${h / 360 * 100}%`, top: '50%' }} />
      </button>
    </div>
  </div>;
}
